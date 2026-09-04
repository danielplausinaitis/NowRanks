import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import { analyzeObservationTimeline, diagnoseHistoricalComponents } from './shadowTemporalDiagnostics.mjs'
import { scoreShadowLiveCohort, SHADOW_HISTORY_REQUIREMENTS } from './shadowScoring.mjs'

const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }

function series(count, intervalHours, missingIndexes = new Set()) {
  return Array.from({ length: count }, (_, index) => ({
    candidateId: 'topic',
    date: new Date(Date.UTC(2025, 0, 1) + index * intervalHours * 3_600_000).toISOString().slice(0, 10),
    observedAt: new Date(Date.UTC(2025, 0, 1) + index * intervalHours * 3_600_000).toISOString(),
    ...(missingIndexes.has(index)
      ? { availability: 'missing', interest: null, missingReason: 'out-of-range' }
      : { availability: 'available', interest: index + 1 }),
  }))
}

function candidate(history) {
  return {
    topic: 'Topic', normalizedQuery: 'topic', category: 'Technology',
    currentTrendIntensity: { providerId: 'serpapi', searchVolume: 10_000 },
    baselineDemand: { providerId: 'dataforseo-search-volume', availability: 'available', searchVolume: 5_000 },
    historicalTrendShape: { providerId: 'dataforseo-trends', observations: history },
  }
}

describe('shadow temporal diagnostics', () => {
  it('detects hourly, daily, weekly, and monthly series from timestamp intervals', () => {
    expect(analyzeObservationTimeline(series(24, 1))).toMatchObject({ detectedResolution: 'hourly', medianIntervalHours: 1 })
    expect(analyzeObservationTimeline(series(30, 24))).toMatchObject({ detectedResolution: 'daily', medianIntervalHours: 24, largeGapCount: 0 })
    expect(analyzeObservationTimeline(series(52, 24 * 7))).toMatchObject({ detectedResolution: 'weekly', medianIntervalHours: 168, largeGapCount: 0 })
    expect(analyzeObservationTimeline(series(12, 24 * 30))).toMatchObject({ detectedResolution: 'monthly', medianIntervalHours: 720 })
  })

  it('reports irregular cadence and large gaps without changing scoring eligibility', () => {
    const irregular = series(8, 24)
    irregular[4].observedAt = new Date(Date.UTC(2025, 0, 12)).toISOString()
    const diagnostic = analyzeObservationTimeline(irregular)
    expect(diagnostic.largeGapCount).toBeGreaterThan(0)

    const irregularCadence = [0, 1, 6, 18, 48].map((hours, index) => ({
      ...series(1, 24)[0],
      observedAt: new Date(Date.UTC(2025, 0, 1) + hours * 3_600_000).toISOString(),
      interest: index + 1,
    }))
    expect(analyzeObservationTimeline(irregularCadence).detectedResolution).toBe('irregular')

    const sparse = diagnoseHistoricalComponents(series(1, 24), SHADOW_HISTORY_REQUIREMENTS)
    expect(sparse.components.consistency.status).toBe('unavailable')
    expect(sparse.components.consistency.reason).toBe('insufficient-valid-observations')
    expect(sparse.components.growth).toMatchObject({ required: 14, actual: 1 })
  })

  it('reports duplicates and original unsorted order separately from sorted cadence analysis', () => {
    const values = series(5, 24)
    ;[values[1], values[2]] = [values[2], values[1]]
    values[4].observedAt = values[3].observedAt
    expect(analyzeObservationTimeline(values)).toMatchObject({ unsorted: true, duplicateCount: 1 })
  })

  it('allows the current scorer to calculate a complete 52-point weekly series', () => {
    const result = scoreShadowLiveCohort({ candidates: [candidate(series(52, 24 * 7))], signalEngine, scoreWeights: SCORE_WEIGHTS })[0]
    expect(result.status).toBe('scored')
    expect(result.history).toMatchObject({
      observationCount: 52, availableCount: 52, detectedResolution: 'weekly',
      sufficientForAllComponents: true,
    })
    expect(Object.values(result.componentDiagnostics).every((item) => item.status === 'available')).toBe(true)
  })

  it('traces 49 valid points out of 52 to the current all-or-nothing completeness contract', () => {
    const history = series(52, 24 * 7, new Set([3, 20, 40]))
    const result = scoreShadowLiveCohort({ candidates: [candidate(history)], signalEngine, scoreWeights: SCORE_WEIGHTS })[0]

    expect(result.status).toBe('insufficient-signal')
    expect(result.history).toMatchObject({
      observationCount: 52, availableCount: 49, missingCount: 3,
      detectedResolution: 'weekly', medianIntervalHours: 168,
    })
    for (const component of ['growth', 'momentum', 'consistency', 'breakout']) {
      expect(result.components[component]).toBeNull()
      expect(result.componentDiagnostics[component]).toEqual({
        status: 'unavailable',
        reason: 'incomplete-series-rejected-by-current-contract',
        missingCount: 3,
      })
    }
  })
})
