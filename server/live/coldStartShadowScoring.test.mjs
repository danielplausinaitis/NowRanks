import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import { coldStartIncreaseSignal, COLD_START_TRENDING, evaluateColdStartTrending } from './coldStartShadowScoring.mjs'
import { scoreElapsedTimeShadowLiveCohort } from './shadowScoring.mjs'

const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }

function sparseHistory(validCount = 2) {
  const start = Date.UTC(2025, 0, 1)
  return Array.from({ length: 52 }, (_, index) => ({
    candidateId: 'topic',
    date: new Date(start + index * 7 * 86_400_000).toISOString().slice(0, 10),
    observedAt: new Date(start + index * 7 * 86_400_000).toISOString(),
    ...(index >= 52 - validCount
      ? { availability: 'available', interest: index + 1 }
      : { availability: 'missing', interest: null, missingReason: 'out-of-range' }),
  }))
}

function fullHistory() {
  return sparseHistory(52)
}

function candidate({ topic, current, baseline = 10_000, increase = 1_000, active = true, startedAt = '2026-08-25T06:00:00.000Z', retrievedAt = '2026-08-25T12:00:00.000Z', history = sparseHistory() }) {
  return {
    topic, normalizedQuery: topic.toLowerCase(), category: 'Technology',
    currentTrendIntensity: { providerId: 'serpapi', searchVolume: current, increasePercentage: increase, active, startedAt, retrievedAt },
    baselineDemand: { providerId: 'dataforseo-volume', availability: 'available', searchVolume: baseline },
    historicalTrendShape: { providerId: 'dataforseo-trends', observations: history },
  }
}

function score(candidates) {
  return scoreElapsedTimeShadowLiveCohort({
    candidates, signalEngine, scoreWeights: SCORE_WEIGHTS, historyWindow: '1Y', coldStartMaxAgeHours: 24,
  })
}

describe('cold-start live Trending lane', () => {
  it('classifies an active recent sparse topic with strong current evidence as emerging', () => {
    const results = score([
      candidate({ topic: 'High', current: 200_000 }),
      candidate({ topic: 'Low', current: 5_000 }),
    ])
    const high = results.find((entry) => entry.topic === 'High')
    const low = results.find((entry) => entry.topic === 'Low')
    expect(high).toMatchObject({ status: 'emerging', topicClassification: 'possible-new-trend', confidence: 'emerging', shadowOverallScore: null, shadowTrendingScore: null })
    expect(high.shadowEmergingTrendingScore).toEqual(expect.any(Number))
    expect(high.shadowEmergingRank).toBe(1)
    expect(low).toMatchObject({ status: 'insufficient-signal', topicClassification: 'insufficient-provider-data', confidence: 'insufficient' })
  })

  it('requires an active trend and a start time inside the discovery lookback', () => {
    const inactive = evaluateColdStartTrending({
      candidate: candidate({ topic: 'Inactive', current: 100_000, active: false }), searchInterest: 80,
      normalizedCurrentIntensity: 100, historyCoverage: 0.1, establishedEligible: false, maximumAgeHours: 24,
    })
    const old = evaluateColdStartTrending({
      candidate: candidate({ topic: 'Old', current: 100_000, startedAt: '2026-08-23T00:00:00.000Z' }), searchInterest: 80,
      normalizedCurrentIntensity: 100, historyCoverage: 0.1, establishedEligible: false, maximumAgeHours: 24,
    })
    expect(inactive).toMatchObject({ eligible: false, classification: 'insufficient-provider-data' })
    expect(inactive.reason).toMatch(/active-trend-required/)
    expect(old.reason).toMatch(/recent-valid-start-time-required/)
  })

  it('requires at least a doubled increase and handles 1000% saturation explicitly', () => {
    expect(coldStartIncreaseSignal(1_000)).toBe(100)
    expect(coldStartIncreaseSignal(5_000)).toBe(100)
    expect(coldStartIncreaseSignal(400)).toBeLessThan(100)
    const weakIncrease = evaluateColdStartTrending({
      candidate: candidate({ topic: 'Weak', current: 100_000, increase: 99 }), searchInterest: 80,
      normalizedCurrentIntensity: 100, historyCoverage: 0.1, establishedEligible: false, maximumAgeHours: 24,
    })
    expect(weakIncrease.reason).toMatch(/increase-below-100-percent/)
  })

  it('uses baseline demand only through Search Interest, never a direct cross-period ratio', () => {
    const lowerSearchInterest = evaluateColdStartTrending({
      candidate: candidate({ topic: 'One', current: 100_000, baseline: 1_000 }), searchInterest: 50,
      normalizedCurrentIntensity: 100, historyCoverage: 0.1, establishedEligible: false, maximumAgeHours: 24,
    })
    const higherSearchInterest = evaluateColdStartTrending({
      candidate: candidate({ topic: 'Two', current: 100_000, baseline: 100_000 }), searchInterest: 80,
      normalizedCurrentIntensity: 100, historyCoverage: 0.1, establishedEligible: false, maximumAgeHours: 24,
    })
    expect(higherSearchInterest.score).toBeGreaterThan(lowerSearchInterest.score)
    expect(higherSearchInterest.signals.baselineRelationship.usedAsDirectRatio).toBe(false)
  })

  it('uses the documented current-only formula and does not invent historical components', () => {
    const result = score([
      candidate({ topic: 'Emerging', current: 200_000 }),
      candidate({ topic: 'Reference', current: 5_000 }),
    ]).find((entry) => entry.topic === 'Emerging')
    const signals = result.coldStart.signals
    const expected = signals.searchInterest * COLD_START_TRENDING.weights.searchInterest
      + signals.increaseSignal * COLD_START_TRENDING.weights.increase
      + signals.recencySignal * COLD_START_TRENDING.weights.recency
    expect(result.shadowEmergingTrendingScore).toBeCloseTo(expected)
    expect(result.components).toMatchObject({ growth: null, momentum: null, consistency: null, breakout: null })
    expect(result.shadowOverallScore).toBeNull()
  })

  it('leaves established full-history scoring in the established lane', () => {
    const result = score([candidate({ topic: 'Established', current: 100_000, history: fullHistory() })])[0]
    expect(result).toMatchObject({ status: 'scored', topicClassification: 'established', confidence: 'full', shadowEmergingTrendingScore: null })
    expect(result.shadowOverallScore).toEqual(expect.any(Number))
    expect(result.shadowTrendingScore).toEqual(expect.any(Number))
  })
})
