import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import { renormalizedAvailableScore, scoreElapsedTimeShadowLiveCohort } from './shadowScoring.mjs'

const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }

function weeklySeries(count = 52, missing = new Set()) {
  const start = Date.UTC(2025, 0, 1)
  return Array.from({ length: count }, (_, index) => ({
    candidateId: 'topic',
    date: new Date(start + index * 7 * 86_400_000).toISOString().slice(0, 10),
    observedAt: new Date(start + index * 7 * 86_400_000).toISOString(),
    ...(missing.has(index)
      ? { availability: 'missing', interest: null, missingReason: 'out-of-range' }
      : { availability: 'available', interest: 10 + index }),
  }))
}

function candidate({ topic = 'Topic', history = weeklySeries(), current = 10_000, baseline = 5_000, active = true, startedAt = '2026-08-25T00:00:00.000Z', retrievedAt = '2026-08-25T12:00:00.000Z' } = {}) {
  return {
    topic, normalizedQuery: topic.toLowerCase(), category: 'Technology',
    currentTrendIntensity: current === null ? null : { providerId: 'serpapi', searchVolume: current, increasePercentage: 1_000, active, startedAt, retrievedAt },
    baselineDemand: baseline === null ? null : { providerId: 'dataforseo-volume', availability: 'available', searchVolume: baseline },
    historicalTrendShape: { providerId: 'dataforseo-trends', observations: history },
  }
}

function score(candidates) {
  return scoreElapsedTimeShadowLiveCohort({ candidates, signalEngine, scoreWeights: SCORE_WEIGHTS, historyWindow: '1Y' })
}

describe('partial-component elapsed shadow scoring', () => {
  it('emits a full-confidence score when all five components are available', () => {
    const result = score([candidate()])[0]
    expect(result).toMatchObject({ status: 'scored', scoreCompleteness: 'full', confidence: 'full' })
    expect(result.availableComponentWeight).toEqual({ overall: 1, trending: 1 })
  })

  it('scores 48/51 history with only momentum unavailable as partial-high', () => {
    const history = weeklySeries(51, new Set([0, 49, 50]))
    const result = score([candidate({ history })])[0]
    expect(result.history).toMatchObject({ observationCount: 51, availableCount: 48 })
    expect(result.missingComponents).toEqual(['momentum'])
    expect(result).toMatchObject({ status: 'scored', scoreCompleteness: 'partial', confidence: 'partial-high' })
    expect(result.availableComponentWeight.overall).toBeCloseTo(0.85)
    expect(result.availableComponentWeight.trending).toBeCloseTo(0.65)
  })

  it('renormalizes a missing low-weight component instead of treating it as zero', () => {
    const result = score([candidate({ history: weeklySeries(52, new Set([0, 1, 2, 3, 4, 5, 6, 7])) })])[0]
    expect(result.missingComponents).toEqual(['breakout'])
    expect(result.status).toBe('scored')
    expect(result.availableComponentWeight).toEqual({ overall: 0.95, trending: 0.95 })
    expect(result.shadowOverallScore).not.toBe(0)
  })

  it('rejects multiple missing recent components despite high total coverage', () => {
    const result = score([candidate({ history: weeklySeries(51, new Set([45, 46, 47, 48, 49, 50])) })])[0]
    expect(result.history.availableCount).toBe(45)
    expect(result.componentDiagnostics.consistency.status).toBe('available')
    expect(result.missingComponents).toEqual(expect.arrayContaining(['growth', 'momentum', 'breakout']))
    expect(result).toMatchObject({ status: 'insufficient-signal', confidence: 'insufficient', scoreCompleteness: 'unavailable' })
    expect(result.confidenceReason).toMatch(/fewer-than-two-historical-components/)
  })

  it('keeps Search Interest mandatory', () => {
    const result = score([candidate({ baseline: null })])[0]
    expect(result.components.searchInterest).toBeNull()
    expect(result.shadowOverallScore).toBeNull()
    expect(result.confidenceReason).toMatch(/search-interest-required/)
  })

  it.each([1, 2, 10])('keeps Overall unavailable for %i/52-like history while using a separate emerging lane', (validCount) => {
    const missing = new Set(Array.from({ length: 52 - validCount }, (_, index) => index))
    const result = score([candidate({ history: weeklySeries(52, missing) })])[0]
    expect(result.status).toBe('emerging')
    expect(result.confidence).toBe('emerging')
    expect(result.shadowOverallScore).toBeNull()
    expect(result.shadowTrendingScore).toBeNull()
    expect(result.shadowEmergingTrendingScore).toEqual(expect.any(Number))
    expect(result.coldStart?.classification).toBe('possible-new-trend')
  })

  it('uses exact independent Overall and Trending weight renormalization', () => {
    const components = { searchInterest: 80, growth: 60, momentum: null, consistency: 40, breakout: 20 }
    const overall = renormalizedAvailableScore(components, SCORE_WEIGHTS.overall)
    const trending = renormalizedAvailableScore(components, SCORE_WEIGHTS.trending)
    expect(overall.availableWeight).toBeCloseTo(0.85)
    expect(overall.score).toBeCloseTo((80 * 0.45 + 60 * 0.25 + 40 * 0.1 + 20 * 0.05) / 0.85)
    expect(trending.availableWeight).toBeCloseTo(0.65)
    expect(trending.score).toBeCloseTo((80 * 0.1 + 60 * 0.4 + 40 * 0.1 + 20 * 0.05) / 0.65)
  })

  it('derives confidence from evidence rather than score magnitude', () => {
    const partialHistory = weeklySeries(51, new Set([0, 49, 50]))
    const results = score([
      candidate({ topic: 'Low', history: partialHistory, current: 100, baseline: 100 }),
      candidate({ topic: 'High', history: partialHistory, current: 1_000_000, baseline: 1_000_000 }),
    ])
    expect(results.map((entry) => entry.confidence)).toEqual(['partial-high', 'partial-high'])
    expect(results[0].shadowOverallScore).not.toBe(results[1].shadowOverallScore)
  })

  it('keeps the partial evaluator outside production and persistence modules', () => {
    const productionScorer = readFileSync('src/domain/scoring.ts', 'utf8')
    const elapsedEvaluator = readFileSync('server/live/elapsedShadowHistory.mjs', 'utf8')
    expect(productionScorer).not.toMatch(/elapsedShadowHistory|partialShadow/)
    expect(elapsedEvaluator).not.toMatch(/supabase|repository|persistence/i)
  })
})
