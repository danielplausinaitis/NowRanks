import { LEADERBOARD_SIZE } from './config'
import { scoreTopics } from './scoring'
import type { LeaderboardEntry, LeaderboardSnapshot, SearchTopicData } from './types'

export function rankEntries(data: SearchTopicData[], scoreType: 'overallScore' | 'trendingScore' = 'overallScore'): LeaderboardEntry[] {
  return scoreTopics(data)
    .sort((a, b) => b[scoreType] - a[scoreType] || a.topic.localeCompare(b.topic))
    .slice(0, LEADERBOARD_SIZE)
    .map((entry, index) => ({ ...entry, rank: index + 1, movement: null }))
}

export function calculateMovement(current: LeaderboardEntry[], previous?: LeaderboardSnapshot): LeaderboardEntry[] {
  const previousRanks = new Map(previous?.entries.map(({ id, rank }) => [id, rank]))
  return current.map((entry) => {
    const previousRank = previousRanks.get(entry.id)
    return { ...entry, previousRank, movement: previousRank === undefined ? 'NEW' : previousRank - entry.rank }
  })
}
