import { describe, expect, it } from 'vitest'
import { growthPercentage, resolveGrowthPresentation, resolveTrendHeat, trendHeat } from './trendPresentation.mjs'

describe('trend presentation', () => {
  it('maps only complete window-specific component evidence to deterministic heat levels', () => {
    expect(trendHeat({ growth: 20, momentum: 20, breakout: 20, trendingScore: 20 })).toBe('stable')
    expect(trendHeat({ growth: 45, momentum: 10, breakout: 10, trendingScore: 35 })).toBe('rising')
    expect(trendHeat({ growth: 60, momentum: 10, breakout: 10, trendingScore: 55 })).toBe('fast')
    expect(trendHeat({ growth: 75, momentum: 10, breakout: 10, trendingScore: 70 })).toBe('surging')
    expect(trendHeat({ growth: 90, momentum: 10, breakout: 10, trendingScore: 85 })).toBe('exploding')
  })
  it('uses valid discovery acceleration for short-window Heat when provider shape components are absent', () => {
    expect(trendHeat({ growth: null, momentum: null, breakout: null, discoveryAcceleration: 50, trendingScore: 40 })).toBe('rising')
    expect(trendHeat({ growth: null, momentum: null, breakout: null, discoveryAcceleration: 75, trendingScore: 70 })).toBe('surging')
  })
  it('keeps Heat pending only when there is no supporting signal', () => {
    expect(trendHeat({ growth: null, momentum: null, breakout: null, discoveryAcceleration: null, trendingScore: 80 })).toBeNull()
  })
  it('uses valid normalized current intensity as a short-window fallback without fabricating missing data', () => {
    expect(resolveTrendHeat({ growth: null, momentum: null, breakout: null, discoveryAcceleration: null, currentIntensity: 50, trendingScore: 40 }))
      .toMatchObject({ heatStatus: 'available', heatLevel: 'rising', heatEvidenceAvailable: true, heatEvidenceSource: 'current-intensity', heatFallbackUsed: true, heatPendingReason: null })
    expect(resolveTrendHeat({ growth: null, momentum: null, breakout: null, discoveryAcceleration: null, currentIntensity: 0, trendingScore: 20 }))
      .toMatchObject({ heatStatus: 'available', heatLevel: 'stable', heatEvidenceAvailable: true, heatEvidenceSource: 'current-intensity' })
    expect(resolveTrendHeat({ growth: null, momentum: null, breakout: null, discoveryAcceleration: null, currentIntensity: null, trendingScore: 20 }))
      .toMatchObject({ heatStatus: 'pending', heatLevel: null, heatEvidenceAvailable: false, heatPendingReason: 'no-supporting-signal' })
  })
  it('keeps valid short-window history as Heat evidence and distinguishes Stable from pending', () => {
    expect(resolveTrendHeat({ growth: 20, momentum: 10, breakout: 15, discoveryAcceleration: null, currentIntensity: null, trendingScore: 20 }))
      .toMatchObject({ heatStatus: 'available', heatLevel: 'stable', heatEvidenceSource: 'historical-shape', heatFallbackUsed: false })
  })
  it('reports a truthful growth percentage but never treats a zero or near-zero baseline as a percentage', () => {
    expect(growthPercentage({ recentAverage: 18, previousAverage: 10 })).toBe(80)
    expect(growthPercentage({ recentAverage: 18, previousAverage: 0 })).toBeNull()
    expect(growthPercentage({ recentAverage: 18, previousAverage: 4.99 })).toBeNull()
    expect(growthPercentage({ recentAverage: Number.NaN, previousAverage: 10 })).toBeNull()
  })
  it('prioritizes calculated NowRanks history, then provider history, over discovery acceleration', () => {
    expect(resolveGrowthPresentation({ nowranksHistoricalGrowthPercent: 10_902, providerHistoricalGrowthPercent: 4_000, discoveryIncreasePercentage: 1_000 }))
      .toEqual({ growthPercent: 10_902, growthSource: 'nowranks-history', growthSaturated: false })
    expect(resolveGrowthPresentation({ providerHistoricalGrowthPercent: 10_902, discoveryIncreasePercentage: 1_000 }))
      .toEqual({ growthPercent: 10_902, growthSource: 'provider-history', growthSaturated: false })
  })
  it('marks an exact 1000% discovery fallback as a saturated lower bound', () => {
    expect(resolveGrowthPresentation({ discoveryIncreasePercentage: 1_000 }))
      .toEqual({ growthPercent: 1_000, growthSource: 'discovery-increase', growthSaturated: true })
  })
  it('keeps negative and unsaturated provider Growth precise', () => {
    expect(resolveGrowthPresentation({ providerHistoricalGrowthPercent: -35, discoveryIncreasePercentage: 1_000 }))
      .toEqual({ growthPercent: -35, growthSource: 'provider-history', growthSaturated: false })
    expect(resolveGrowthPresentation({ discoveryIncreasePercentage: 999 }))
      .toEqual({ growthPercent: 999, growthSource: 'discovery-increase', growthSaturated: false })
    expect(resolveGrowthPresentation({})).toEqual({ growthPercent: null, growthSource: 'unavailable', growthSaturated: false })
  })
})
