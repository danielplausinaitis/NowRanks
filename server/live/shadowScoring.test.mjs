import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import { logNormalizeCohort, peakNormalizeHistory, scoreShadowLiveCohort, SHADOW_SEARCH_INTEREST_WEIGHTS } from './shadowScoring.mjs'

const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }
const observations = (id, values) => values.map((interest, index) => ({ candidateId: id, date: `2026-08-${String(index + 1).padStart(2, '0')}`, observedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(), availability: 'available', interest }))
function candidate(topic, current, baseline, history, category = 'Technology') {
  const normalizedQuery = topic.toLocaleLowerCase('en-US')
  return {
    topic, normalizedQuery, category,
    currentTrendIntensity: current === null ? null : { providerId: 'serpapi-google-trends-trending-now', searchVolume: current, increasePercentage: 500, active: true },
    baselineDemand: baseline === null ? { providerId: 'dataforseo-google-ads-search-volume', availability: 'missing', searchVolume: null } : { providerId: 'dataforseo-google-ads-search-volume', availability: 'available', searchVolume: baseline },
    historicalTrendShape: { providerId: 'dataforseo-trends', provenance: { providerId: 'dataforseo-trends' }, observations: observations(normalizedQuery, history) },
  }
}

describe('shadow live scoring', () => {
  it('log-normalizes skewed current and baseline volumes while preserving zero and missing', () => {
    expect(logNormalizeCohort([0, 1_000, 100_000_000, null], normalize)).toEqual([0, expect.any(Number), 100, null])
    const rawMiddle = (1_000 / 100_000_000) * 100
    expect(logNormalizeCohort([0, 1_000, 100_000_000], normalize)[1]).toBeGreaterThan(rawMiddle * 1000)
  })

  it('uses the explicit 70/30 Search Interest hypothesis and emits raw plus normalized diagnostics', () => {
    const data = [candidate('Low', 10, 100, Array.from({ length: 14 }, (_, index) => index + 1)), candidate('High', 1000, 10000, Array.from({ length: 14 }, (_, index) => index + 2))]
    const result = scoreShadowLiveCohort({ candidates: data, signalEngine, scoreWeights: SCORE_WEIGHTS })
    const high = result.find((entry) => entry.topic === 'High')
    expect(SHADOW_SEARCH_INTEREST_WEIGHTS).toEqual({ currentTrendIntensity: 0.7, baselineDemand: 0.3 })
    expect(high.components.searchInterest).toBe(100)
    expect(high.raw.currentTrendIntensity).toMatchObject({ searchVolume: 1000, increasePercentage: 500 })
    expect(high.normalized).toMatchObject({ currentTrendIntensity: 100, baselineDemand: 100 })
  })

  it('does not substitute zero when a required current or baseline signal is missing', () => {
    const result = scoreShadowLiveCohort({ candidates: [candidate('Missing', null, null, Array(14).fill(20))], signalEngine, scoreWeights: SCORE_WEIGHTS })[0]
    expect(result.status).toBe('insufficient-signal')
    expect(result.components.searchInterest).toBeNull()
    expect(result.shadowOverallScore).toBeNull()
  })

  it('uses within-topic shape and is invariant to independent provider-batch amplitude', () => {
    const shape = Array.from({ length: 14 }, (_, index) => index + 1)
    expect(peakNormalizeHistory(observations('one', shape))).toEqual(peakNormalizeHistory(observations('two', shape.map((value) => value * 5))))
    const result = scoreShadowLiveCohort({ candidates: [candidate('One', 10, 100, shape), candidate('Two', 20, 200, shape.map((value) => value * 5))], signalEngine, scoreWeights: SCORE_WEIGHTS })
    expect(result[0].components.growth).toBe(result[1].components.growth)
    expect(result[0].components.momentum).toBe(result[1].components.momentum)
  })

  it('exposes history insufficiency instead of using the existing formulas zero sentinel', () => {
    const result = scoreShadowLiveCohort({ candidates: [candidate('Short', 10, 100, Array(13).fill(20))], signalEngine, scoreWeights: SCORE_WEIGHTS })[0]
    expect(result.missingComponents).toEqual(expect.arrayContaining(['growth', 'momentum', 'breakout']))
    expect(result.components.consistency).toBe(50)
    expect(result.shadowTrendingScore).toBeNull()
    expect(result.history).toMatchObject({ observationCount: 13, availableCount: 13, sufficientForAllComponents: false })
  })

  it('calculates Overall and Trending from the existing weights and ranks deterministically', () => {
    const rising = Array.from({ length: 14 }, (_, index) => 10 + index * index)
    const flat = Array(14).fill(20)
    const inputs = [candidate('Zulu', 100, 1000, rising), candidate('Alpha', 50, 500, flat), candidate('Beta', 50, 500, flat)]
    const first = scoreShadowLiveCohort({ candidates: inputs, signalEngine, scoreWeights: SCORE_WEIGHTS })
    const second = scoreShadowLiveCohort({ candidates: inputs, signalEngine, scoreWeights: SCORE_WEIGHTS })
    expect(first).toEqual(second)
    for (const entry of first) {
      const expectedOverall = Object.entries(SCORE_WEIGHTS.overall).reduce((sum, [key, weight]) => sum + entry.components[key] * weight, 0)
      const expectedTrending = Object.entries(SCORE_WEIGHTS.trending).reduce((sum, [key, weight]) => sum + entry.components[key] * weight, 0)
      expect(entry.shadowOverallScore).toBeCloseTo(expectedOverall)
      expect(entry.shadowTrendingScore).toBeCloseTo(expectedTrending)
    }
    expect(first.filter((entry) => entry.topic !== 'Zulu').map((entry) => entry.topic)).toEqual(['Alpha', 'Beta'])
  })
})
