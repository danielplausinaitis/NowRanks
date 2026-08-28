import type { ComponentWeights, TimeWindow } from './types'

export const SCORE_WEIGHTS = {
  // Initial proposal: validate against replay fixtures before treating these as a production model.
  overall: { searchInterest: 0.45, growth: 0.25, momentum: 0.15, consistency: 0.1, breakout: 0.05 },
  // Preserve the existing Trending intent while giving breakout the same small explicit share.
  trending: { searchInterest: 0.1, growth: 0.4, momentum: 0.35, consistency: 0.1, breakout: 0.05 },
} as const satisfies Record<'overall' | 'trending', ComponentWeights>

export const TIME_WINDOWS: Record<TimeWindow, number> = { '24H': 1, '7D': 7, '30D': 30, '1Y': 365 }
export const LEADERBOARD_SIZE = 100
