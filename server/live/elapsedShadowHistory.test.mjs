import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import {
  evaluateElapsedShadowHistory,
  peakNormalizeAvailableHistory,
  resolveShadowHistoryWindow,
  shadowHistoryRequestForWindow,
  SHADOW_HISTORY_MAX_GAP_INTERVALS,
  SHADOW_HISTORY_SEGMENT_COVERAGE,
} from './elapsedShadowHistory.mjs'
import { scoreElapsedTimeShadowLiveCohort } from './shadowScoring.mjs'
import { analyzeObservationTimeline } from './shadowTemporalDiagnostics.mjs'

const HOUR = 3_600_000
const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }

function series(count, intervalHours, missing = new Set()) {
  const start = Date.UTC(2025, 0, 1)
  return Array.from({ length: count }, (_, index) => ({
    candidateId: 'topic',
    date: new Date(start + index * intervalHours * HOUR).toISOString().slice(0, 10),
    observedAt: new Date(start + index * intervalHours * HOUR).toISOString(),
    ...(missing.has(index)
      ? { availability: 'missing', interest: null, missingReason: 'out-of-range' }
      : { availability: 'available', interest: 10 + index }),
  }))
}

function score(history, historyWindow) {
  return scoreElapsedTimeShadowLiveCohort({
    candidates: [{
      topic: 'Topic', normalizedQuery: 'topic', category: 'Technology',
      currentTrendIntensity: { providerId: 'serpapi', searchVolume: 10_000 },
      baselineDemand: { providerId: 'dataforseo-volume', availability: 'available', searchVolume: 5_000 },
      historicalTrendShape: { providerId: 'dataforseo-trends', observations: history },
    }],
    signalEngine,
    scoreWeights: SCORE_WEIGHTS,
    historyWindow,
  })[0]
}

describe('elapsed-time live shadow history', () => {
  it('maps each explicit shadow window to its documented provider preset', () => {
    expect(resolveShadowHistoryWindow({})).toBe('1Y')
    expect(shadowHistoryRequestForWindow('24H')).toEqual({ timeRange: 'past_day' })
    expect(shadowHistoryRequestForWindow('7D')).toEqual({ timeRange: 'past_7_days' })
    expect(shadowHistoryRequestForWindow('30D')).toEqual({ timeRange: 'past_30_days' })
    expect(shadowHistoryRequestForWindow('1Y')).toEqual({ timeRange: 'past_12_months' })
    expect(() => resolveShadowHistoryWindow({ LIVE_SHADOW_HISTORY_WINDOW: '90D' })).toThrow(/24H, 7D, 30D, 1Y/)
  })

  it('scores complete 24H hourly, 7D daily, 30D daily, and 1Y weekly histories', () => {
    for (const [window, history] of [
      ['24H', series(24, 1)], ['7D', series(7, 24)], ['30D', series(30, 24)], ['1Y', series(52, 168)],
    ]) {
      const result = score(history, window)
      expect(result.status, window).toBe('scored')
      expect(result.history.requestedWindow).toBe(window)
      expect(Object.values(result.componentDiagnostics).every((item) => item.status === 'available')).toBe(true)
    }
  })

  it('scores partial-but-sufficient 24H history under the explicit segment threshold', () => {
    const result = score(series(24, 1, new Set([0, 1, 2])), '24H')
    expect(SHADOW_HISTORY_SEGMENT_COVERAGE).toBe(0.8)
    expect(result.status).toBe('scored')
    expect(result.history).toMatchObject({ observationCount: 24, availableCount: 21, missingCount: 3 })
  })

  it('makes 49/52 weekly observations scoreable when every required segment has coverage', () => {
    const result = score(series(52, 168, new Set([0, 20, 40])), '1Y')
    expect(result.status).toBe('scored')
    expect(result.history).toMatchObject({ observationCount: 52, availableCount: 49, coveragePercentage: expect.closeTo(94.23, 1) })
    expect(Object.values(result.componentDiagnostics).every((item) => item.status === 'available')).toBe(true)
  })

  it('withholds only components whose recent segment lacks coverage', () => {
    const result = score(series(52, 168, new Set([48, 49, 50, 51])), '1Y')
    expect(result.componentDiagnostics.growth).toMatchObject({ status: 'unavailable', reason: 'insufficient-recent-coverage' })
    expect(result.componentDiagnostics.momentum.status).toBe('unavailable')
    expect(result.componentDiagnostics.breakout).toMatchObject({ status: 'unavailable', reason: 'insufficient-recent-coverage' })
    expect(result.componentDiagnostics.consistency.status).toBe('available')
    expect(result.status).toBe('insufficient-signal')
  })

  it('distinguishes missing baseline coverage from available recent shape', () => {
    const result = score(series(52, 168, new Set([0, 1, 2, 3, 4, 5, 6, 7])), '1Y')
    expect(result.componentDiagnostics.breakout).toMatchObject({ status: 'unavailable', reason: 'insufficient-baseline-coverage' })
    expect(result.componentDiagnostics.growth.status).toBe('available')
    expect(result.componentDiagnostics.consistency.status).toBe('available')
  })

  it('rejects material gaps and irregular cadence component-by-component', () => {
    const gapped = series(52, 168).filter((_, index) => index !== 25 && index !== 26)
    const gapResult = score(gapped, '1Y')
    expect(SHADOW_HISTORY_MAX_GAP_INTERVALS).toBe(2)
    expect(gapResult.componentDiagnostics.consistency).toMatchObject({ status: 'unavailable', reason: 'excessive-gap-in-history' })

    const irregular = series(30, 24)
    irregular[10].observedAt = new Date(Date.UTC(2025, 0, 11, 8)).toISOString()
    irregular[11].observedAt = new Date(Date.UTC(2025, 0, 12, 17)).toISOString()
    const timeline = analyzeObservationTimeline(irregular)
    const evaluated = evaluateElapsedShadowHistory(irregular, '30D', { ...timeline, detectedResolution: 'irregular' })
    expect(Object.values(evaluated.components).every((item) => item.reason.startsWith('unexpected-cadence'))).toBe(true)
  })

  it('sorts unsorted input safely but rejects duplicate timestamps', () => {
    const unsorted = series(30, 24)
    ;[unsorted[2], unsorted[3]] = [unsorted[3], unsorted[2]]
    expect(analyzeObservationTimeline(unsorted).unsorted).toBe(true)
    expect(score(unsorted, '30D').status).toBe('scored')

    const duplicated = series(30, 24)
    duplicated[5].observedAt = duplicated[4].observedAt
    expect(() => score(duplicated, '30D')).toThrow(/duplicate timestamp/)
  })

  it('peak-normalizes only available points and never converts missing to zero', () => {
    const normalized = peakNormalizeAvailableHistory(series(3, 24, new Set([1])))
    expect(normalized[0].interest).toBeCloseTo(10 / 12 * 100)
    expect(normalized[1]).toMatchObject({ availability: 'missing', interest: null })
    expect(normalized[2].interest).toBe(100)
  })
})
