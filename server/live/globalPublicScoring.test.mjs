import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import { globalGoogleTrendsCurrentIntensity, resolvePublicScoringInputs } from './globalPublicScoring.mjs'
import { scoreElapsedTimeShadowLiveCohort } from './shadowScoring.mjs'

const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }
const target = JSON.stringify({ mode: 'common-global', geographicScope: { kind: 'global' }, locationCode: null, locationName: null, locationCoordinate: null, languageCode: null, languageName: null })

function observations(values) {
  return values.map((interest, index) => ({
    observedAt: new Date(Date.UTC(2026, 8, 13, index)).toISOString(),
    availability: 'available', interest,
  }))
}

function globalCandidate(topic, { discoveryVolume = 100, discoveryIncrease = 100, baseline = 1_000, values = Array(24).fill(20) } = {}) {
  return {
    topic, normalizedQuery: topic.toLowerCase(), category: 'Technology',
    // Retained discovery evidence: it remains available to selection and audit.
    currentTrendIntensity: {
      providerId: 'serpapi-google-trends-trending-now', searchVolume: discoveryVolume,
      increasePercentage: discoveryIncrease, active: true,
      startedAt: '2026-09-13T18:00:00.000Z', retrievedAt: '2026-09-13T23:00:00.000Z',
      sourceGeos: ['BR'], bestGeo: 'BR', primaryDiscoveryEvidence: { geo: 'BR', searchVolume: discoveryVolume, increasePercentage: discoveryIncrease },
    },
    baselineDemand: {
      providerId: 'dataforseo-clickstream-global-search-volume', availability: 'available', searchVolume: baseline,
      measurementProvenance: { measurementMode: 'global', measurementTarget: target, measurementLocation: { kind: 'global' } },
    },
    historicalTrendShape: {
      providerId: 'dataforseo-google-trends',
      measurementProvenance: { measurementMode: 'global', measurementTarget: target, measurementLocation: { kind: 'global' } },
      provenance: { providerId: 'dataforseo-google-trends', geographicScope: { kind: 'global' } },
      observations: observations(values),
    },
  }
}

function score(candidates) {
  return scoreElapsedTimeShadowLiveCohort({ candidates, signalEngine, scoreWeights: SCORE_WEIGHTS, historyWindow: '24H' })
}

describe('true-global public scoring', () => {
  it('uses a candidate-local global Trends currentness ratio that is invariant to batch amplitude', () => {
    const source = globalCandidate('Source', { values: [...Array(21).fill(20), 40, 60, 80] }).historicalTrendShape
    const scaled = { ...source, observations: source.observations.map((point) => ({ ...point, interest: point.interest * 7 })) }
    const first = globalGoogleTrendsCurrentIntensity(source)
    const second = globalGoogleTrendsCurrentIntensity(scaled)
    expect(first).toMatchObject({ value: 75, source: 'global-google-trends-recent-3h-to-24h-peak', usablePointCount: 24, recentPointCount: 3 })
    expect(second.value).toBe(first.value)
  })

  it.each(['7D', '30D', '1Y'])('labels global DataForSEO Trends currentness truthfully for %s without changing its candidate-local ratio', (window) => {
    const history = globalCandidate(`${window} global curve`, { values: [...Array(21).fill(20), 40, 60, 80] }).historicalTrendShape
    history.provenance = { ...history.provenance, providerId: 'dataforseo-trends' }
    history.historyRequest = { timeRange: { '7D': 'past_7_days', '30D': 'past_30_days', '1Y': 'past_12_months' }[window] }
    expect(globalGoogleTrendsCurrentIntensity(history)).toMatchObject({ value: 75, source: 'global-dataforseo-trends-recent-3-to-window-peak', recentPointCount: 3 })
    expect(resolvePublicScoringInputs({ historicalTrendShape: history, currentTrendIntensity: { searchVolume: 9_000_000_000, increasePercentage: 500_000 } })).toMatchObject({
      measurementMode: 'global', fallbackAcceleration: null, discoveryMagnitudeUsedInPublicScore: false,
    })
  })

  it.each(['7D', '30D', '1Y'])('keeps missing/zero provider buckets distinct from positive currentness for %s', (window) => {
    const history = globalCandidate(`${window} sparse currentness`, { values: [20, 40, 80] }).historicalTrendShape
    history.provenance = { ...history.provenance, providerId: 'dataforseo-trends' }
    history.observations = history.observations.map((point, index) => index < 2
      ? point
      : { ...point, availability: 'missing', interest: null, missingReason: 'out-of-range' })
    expect(globalGoogleTrendsCurrentIntensity(history)).toMatchObject({ value: null, reason: 'insufficient-global-google-trends-points', usablePointCount: 2 })
    // Recent missing buckets do not fabricate zero attention: three older positive
    // buckets remain sufficient for the candidate-local currentness calculation.
    history.observations = observations([20, 40, 80, 0, 0]).map((point, index) => index < 3
      ? point
      : { ...point, availability: 'missing', interest: null, missingReason: 'out-of-range' })
    expect(globalGoogleTrendsCurrentIntensity(history)).toMatchObject({ value: 58.33333333333333, usablePointCount: 3, recentPointCount: 3 })
  })

  it('does not use country discovery volume or acceleration in a global public score, while preserving it as evidence', () => {
    const original = globalCandidate('Same global curve', { discoveryVolume: 10, discoveryIncrease: 1, baseline: 500, values: [...Array(21).fill(20), 40, 60, 80] })
    const alteredDiscovery = globalCandidate('Same global curve', { discoveryVolume: 9_000_000_000, discoveryIncrease: 500_000, baseline: 500, values: [...Array(21).fill(20), 40, 60, 80] })
    const first = score([original])[0]
    const second = score([alteredDiscovery])[0]
    expect(second.unifiedRawScore).toBe(first.unifiedRawScore)
    expect(second.unifiedComponents).toEqual(first.unifiedComponents)
    expect(second.raw.currentTrendIntensity).toMatchObject({ searchVolume: 9_000_000_000, increasePercentage: 500_000, bestGeo: 'BR' })
    expect(second.publicScoringDiagnostics).toEqual({
      discoveryEvidenceUsedForSelection: true,
      discoveryMagnitudeUsedInPublicScore: false,
      currentIntensitySource: 'global-google-trends-recent-3h-to-24h-peak',
      accelerationSource: 'global-history',
      baselineSource: 'global-clickstream',
    })
  })

  it('ranks common global evidence above a larger country-local discovery spike', () => {
    const weakGlobal = globalCandidate('A local spike', {
      discoveryVolume: 9_000_000_000, discoveryIncrease: 500_000, baseline: 100,
      values: [...Array(21).fill(100), 20, 20, 20],
    })
    const strongGlobal = globalCandidate('B global signal', {
      discoveryVolume: 1, discoveryIncrease: 1, baseline: 10_000,
      values: [...Array(21).fill(10), 100, 100, 100],
    })
    const results = score([weakGlobal, strongGlobal])
    expect(results.map((entry) => entry.topic)).toEqual(['B global signal', 'A local spike'])
    expect(results[0].publicScoringDiagnostics.discoveryMagnitudeUsedInPublicScore).toBe(false)
  })

  it('continues to use globally comparable Clickstream baseline demand', () => {
    const lowerBaseline = globalCandidate('Lower global baseline', { baseline: 100, values: [...Array(21).fill(20), 40, 60, 80] })
    const higherBaseline = globalCandidate('Higher global baseline', { baseline: 10_000, values: [...Array(21).fill(20), 40, 60, 80] })
    const results = score([lowerBaseline, higherBaseline])
    expect(results.map((entry) => entry.topic)).toEqual(['Higher global baseline', 'Lower global baseline'])
    expect(results.every((entry) => entry.publicScoringDiagnostics.baselineSource === 'global-clickstream')).toBe(true)
  })

  it('leaves missing global acceleration unavailable and lets the existing unified-score renormalization omit it', () => {
    const sparse = globalCandidate('Sparse global signal', { values: [20, 40, 80] })
    const result = score([sparse])[0]
    expect(result.publicScoringDiagnostics).toMatchObject({ accelerationSource: 'unavailable', discoveryMagnitudeUsedInPublicScore: false })
    expect(result.unifiedComponents.acceleration).toBeNull()
    expect(result.unifiedRawScore).toEqual(expect.any(Number))
    expect(result.unifiedAvailableWeight).toBeLessThan(1)
  })

  it('keeps US/legacy scoring inputs geographically aligned and unchanged', () => {
    const legacy = {
      currentTrendIntensity: { searchVolume: 123, increasePercentage: 456 },
      baselineDemand: { providerId: 'dataforseo-google-ads-search-volume' },
      historicalTrendShape: { observations: observations([1, 2, 3]) },
    }
    expect(resolvePublicScoringInputs(legacy)).toEqual(expect.objectContaining({
      measurementMode: 'us-or-legacy',
      currentIntensity: { value: 123, source: 'discovery-search-volume' },
      fallbackAcceleration: 456,
      discoveryMagnitudeUsedInPublicScore: true,
    }))
  })
})
