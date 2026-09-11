import { describe, expect, it } from 'vitest'
import { boundedDiscoveryAcceleration, composeUnifiedPublicScore, nowScoreFromUnifiedRaw } from './unifiedPublicScoring.mjs'

function score(window, signals) { return composeUnifiedPublicScore({ window, currentAttention: 80, baselineDemand: 60, historicalGrowth: null, discoveryAcceleration: 90, momentum: null, consistency: null, breakout: null, recency: 90, historyCoverage: 0, ...signals }).rawScore }

describe('window-aware unified public scoring', () => {
  it('gives the same candidate different horizon scores', () => {
    expect(score('24H')).toBeGreaterThan(score('7D'))
    expect(score('7D')).toBeGreaterThan(score('30D'))
    expect(score('30D')).toBeGreaterThan(score('1Y'))
  })
  it('lets a current-only spike lead 24H but not dominate a long-horizon established topic in 1Y', () => {
    const spike24 = score('24H', { currentAttention: 98, baselineDemand: 20, discoveryAcceleration: 100, recency: 100 })
    const long24 = score('24H', { currentAttention: 55, baselineDemand: 98, historicalGrowth: 65, discoveryAcceleration: null, momentum: 82, consistency: 96, breakout: 50, recency: 20, historyCoverage: 1 })
    const spikeYear = score('1Y', { currentAttention: 98, baselineDemand: 20, discoveryAcceleration: 100, recency: 100 })
    const longYear = score('1Y', { currentAttention: 55, baselineDemand: 98, historicalGrowth: 65, discoveryAcceleration: null, momentum: 82, consistency: 96, breakout: 50, recency: 20, historyCoverage: 1 })
    expect(spike24).toBeGreaterThan(long24)
    expect(longYear).toBeGreaterThan(spikeYear)
  })
  it('keeps emerging topics rankable while reducing discovery fallback as the horizon expands', () => {
    const emerging = composeUnifiedPublicScore({ window: '7D', currentAttention: 90, baselineDemand: null, historicalGrowth: null, discoveryAcceleration: 80, momentum: null, consistency: null, breakout: null, recency: 90, historyCoverage: 0 })
    expect(emerging.rawScore).toEqual(expect.any(Number))
    expect(emerging.accelerationSource).toBe('discovery-acceleration')
    expect(emerging.discoveryFallbackScale).toBe(.7)
    expect(score('24H')).toBeGreaterThan(score('1Y'))
  })
  it('renormalizes missing optional signals without treating them as zero', () => {
    const missingOptional = composeUnifiedPublicScore({ window: '7D', currentAttention: 70, baselineDemand: null, historicalGrowth: 80, discoveryAcceleration: null, momentum: null, consistency: null, breakout: null, recency: null, historyCoverage: 1 })
    expect(missingOptional.rawScore).toBeCloseTo(((70 * .30 + 80 * .27) / .57))
    expect(composeUnifiedPublicScore({ window: '7D', currentAttention: null }).rawScore).toBeNull()
  })
  it('bounds discovery acceleration and transforms raw score monotonically without rank position', () => {
    expect(boundedDiscoveryAcceleration(1000)).toBe(500)
    expect(nowScoreFromUnifiedRaw(80)).toBeGreaterThan(nowScoreFromUnifiedRaw(60))
    expect(nowScoreFromUnifiedRaw(100)).toBe(99)
  })
})
