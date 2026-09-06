import { describe, expect, it } from 'vitest'
import { growthPercentage, trendHeat } from './trendPresentation.mjs'

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
})
