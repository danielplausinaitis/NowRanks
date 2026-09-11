import { describe, expect, it } from 'vitest'
import { growthPercentage, resolveGrowthPresentation, trendHeat } from './trendPresentation.mjs'

describe('trend presentation', () => {
  it('maps only complete window-specific component evidence to deterministic heat levels', () => {
    expect(trendHeat({ growth: 20, momentum: 20, breakout: 20, trendingScore: 20 })).toBe('stable')
    expect(trendHeat({ growth: 45, momentum: 10, breakout: 10, trendingScore: 35 })).toBe('rising')
    expect(trendHeat({ growth: 60, momentum: 10, breakout: 10, trendingScore: 55 })).toBe('fast')
    expect(trendHeat({ growth: 75, momentum: 10, breakout: 10, trendingScore: 70 })).toBe('surging')
    expect(trendHeat({ growth: 90, momentum: 10, breakout: 10, trendingScore: 85 })).toBe('exploding')
  })
  it('keeps heat unavailable when the required evidence is absent', () => {
    expect(trendHeat({ growth: null, momentum: 80, breakout: 80, trendingScore: 80 })).toBeNull()
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
})
