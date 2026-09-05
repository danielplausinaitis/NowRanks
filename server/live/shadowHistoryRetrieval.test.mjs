import { describe, expect, it, vi } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'
import {
  createShadowTrendRequestGroups,
  providerReportedCost,
  resolveShadowTrendsMode,
  retrieveShadowTrendHistories,
} from './shadowHistoryRetrieval.mjs'
import { scoreElapsedTimeShadowLiveCohort, scoreShadowLiveCohort } from './shadowScoring.mjs'

const geographicScope = { kind: 'country', countryCode: 'US' }
const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }
const candidates = (count) => Array.from({ length: count }, (_, index) => ({
  sourceId: `serp-${index + 1}`,
  query: `Topic ${index + 1}`,
  normalizedQuery: `topic ${index + 1}`,
  category: 'Technology',
}))

function responseFor(keywords, valueFor, cost = 0.01) {
  return {
    status_code: 20000,
    tasks: [{
      status_code: 20000,
      cost,
      result: [{
        items: [{
          type: 'dataforseo_trends_graph',
          keywords,
          data: Array.from({ length: 14 }, (_, pointIndex) => ({
            timestamp: Date.UTC(2026, 7, pointIndex + 1) / 1000,
            values: keywords.map((keyword, keywordIndex) => valueFor({ keyword, keywordIndex, pointIndex })),
          })),
        }],
      }],
    }],
  }
}

function clientWith(responseFactory) {
  return {
    measure: vi.fn(async ({ keywords }) => ({
      response: responseFactory(keywords),
      retrievedAt: '2026-08-26T00:00:00.000Z',
    })),
  }
}

function adapter() {
  return createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' })
}

describe('shadow history retrieval strategies', () => {
  it('defaults the explicit shadow experiment to single mode and validates configuration', () => {
    expect(resolveShadowTrendsMode({})).toBe('single')
    expect(resolveShadowTrendsMode({ LIVE_SHADOW_TRENDS_MODE: 'batched' })).toBe('batched')
    expect(() => resolveShadowTrendsMode({ LIVE_SHADOW_TRENDS_MODE: 'other' })).toThrow(/single, batched/)
  })

  it('uses exactly one keyword per request in single mode, including 10 candidates to 10 requests', async () => {
    const input = candidates(10)
    const client = clientWith((keywords) => responseFor(keywords, ({ pointIndex }) => pointIndex + 1))
    const result = await retrieveShadowTrendHistories({
      candidates: input,
      mode: 'single',
      client,
      geographicScope,
      adapter: adapter(),
    })

    expect(result.requestCount).toBe(10)
    expect(client.measure).toHaveBeenCalledTimes(10)
    expect(client.measure.mock.calls.every(([request]) => request.keywords.length === 1)).toBe(true)
    expect(result.histories).toHaveLength(10)
    expect(result.providerCost).toBeCloseTo(0.1)
  })

  it('retains the bounded five-keyword request strategy in batched mode', () => {
    expect(createShadowTrendRequestGroups(candidates(10), 'batched').map((group) => group.length)).toEqual([5, 5])
    expect(createShadowTrendRequestGroups(candidates(12), 'batched').map((group) => group.length)).toEqual([5, 5, 2])
  })

  it('keeps single histories within-topic and prevents mocked cross-topic suppression', async () => {
    const input = candidates(2)
    const singleClient = clientWith((keywords) => responseFor(keywords, ({ pointIndex }) => (pointIndex + 1) * 10))
    const batchedClient = clientWith((keywords) => responseFor(
      keywords,
      ({ keywordIndex, pointIndex }) => keywordIndex === 0 ? (pointIndex + 1) * 10 : 0,
    ))
    const common = { candidates: input, geographicScope, adapter: adapter() }
    const single = await retrieveShadowTrendHistories({ ...common, mode: 'single', client: singleClient })
    const batched = await retrieveShadowTrendHistories({ ...common, mode: 'batched', client: batchedClient })

    expect(single.histories.every((history) => history.observations.every((point) => point.availability === 'available'))).toBe(true)
    expect(single.histories[0].provenance.crossQueryComparability.basis).toMatch(/single-keyword/)
    expect(batched.histories[1].observations.every((point) => point.availability === 'missing')).toBe(true)

    const scoringInput = (histories) => input.map((candidate, index) => ({
      topic: candidate.query,
      normalizedQuery: candidate.normalizedQuery,
      category: candidate.category,
      currentTrendIntensity: { providerId: 'serpapi-google-trends-trending-now', searchVolume: 100 + index * 100 },
      baselineDemand: { providerId: 'dataforseo-search-volume', availability: 'available', searchVolume: 1_000 + index * 1_000 },
      historicalTrendShape: histories[index],
    }))
    const singleScores = scoreShadowLiveCohort({ candidates: scoringInput(single.histories), signalEngine, scoreWeights: SCORE_WEIGHTS })
    const batchedScores = scoreShadowLiveCohort({ candidates: scoringInput(batched.histories), signalEngine, scoreWeights: SCORE_WEIGHTS })

    expect(singleScores.every((entry) => entry.status === 'scored')).toBe(true)
    expect(batchedScores.find((entry) => entry.topic === 'Topic 2').status).toBe('insufficient-signal')
    for (const singleEntry of singleScores) {
      expect(singleEntry.components.searchInterest).toBe(
        batchedScores.find((entry) => entry.topic === singleEntry.topic).components.searchInterest,
      )
    }
  })

  it('tracks provider costs without persistence or any non-injected I/O dependency', async () => {
    const client = clientWith((keywords) => responseFor(keywords, ({ pointIndex }) => pointIndex + 1, 0.025))
    const result = await retrieveShadowTrendHistories({
      candidates: candidates(2), mode: 'single', client, geographicScope, adapter: adapter(),
    })
    expect(result.providerCost).toBeCloseTo(0.05)
    expect(providerReportedCost({ cost: 0.03, tasks: [{ cost: 99 }] })).toBe(0.03)
    expect(result.graphMeasurements).toEqual({ invalidOrMissingMeasurements: 0, affectedCandidates: 0 })
    expect(Object.keys(result).sort()).toEqual(['graphMeasurements', 'histories', 'providerCost', 'requestCount'])
  })

  it('aggregates candidate-local invalid graph diagnostics without aborting valid histories', async () => {
    const client = clientWith((keywords) => responseFor(keywords, ({ keywordIndex, pointIndex }) => keywordIndex === 0 && pointIndex === 3 ? null : pointIndex + 1))
    const result = await retrieveShadowTrendHistories({ candidates: candidates(2), mode: 'batched', client, geographicScope, adapter: adapter() })
    expect(result.histories).toHaveLength(2)
    expect(result.histories[0].observations[3]).toMatchObject({ availability: 'missing', interest: null, missingReason: 'invalid-provider-measurement' })
    expect(result.histories[1].observations.filter((point) => point.availability === 'available')).toHaveLength(14)
    expect(result.graphMeasurements).toEqual({ invalidOrMissingMeasurements: 1, affectedCandidates: 1 })
  })

  it('lets normal elapsed coverage rules make a heavily degraded candidate insufficient', async () => {
    const input = candidates(2)
    const client = clientWith((keywords) => responseFor(keywords, ({ keywordIndex, pointIndex }) => keywordIndex === 0 && pointIndex >= 8 ? null : pointIndex + 1))
    const result = await retrieveShadowTrendHistories({ candidates: input, mode: 'batched', client, geographicScope, adapter: adapter() })
    const scored = scoreElapsedTimeShadowLiveCohort({
      historyWindow: '7D', signalEngine, scoreWeights: SCORE_WEIGHTS,
      candidates: input.map((candidate, index) => ({ topic: candidate.query, normalizedQuery: candidate.normalizedQuery, category: candidate.category, currentTrendIntensity: { searchVolume: 100 + index }, baselineDemand: { availability: 'available', searchVolume: 1_000 + index }, historicalTrendShape: result.histories[index] })),
    })
    expect(scored.find((entry) => entry.topic === 'Topic 1')).toMatchObject({ status: 'insufficient-signal', shadowTrendingScore: null })
    expect(scored.find((entry) => entry.topic === 'Topic 2').status).toBe('scored')
  })
})
