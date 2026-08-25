import type { TimeWindow } from './types'

export const SCORE_WEIGHTS = {
  overall: { searchInterest: 0.45, growth: 0.25, momentum: 0.2, consistency: 0.1 },
  trending: { searchInterest: 0.1, growth: 0.45, momentum: 0.35, consistency: 0.1 },
} as const

export const TIME_WINDOWS: Record<TimeWindow, number> = { '24H': 1, '7D': 7, '30D': 30, '1Y': 365 }
export const LEADERBOARD_SIZE = 100
