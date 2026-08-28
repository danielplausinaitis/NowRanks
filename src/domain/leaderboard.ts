import { LEADERBOARD_SIZE, TIME_WINDOWS } from './config'
import { scoreTopics } from './scoring'
import type { LeaderboardEntry, LeaderboardSnapshot, SearchTopicData, TimeWindow } from './types'

/** Return immutable candidate copies with only the trailing observations for the selected range. */
export function selectTopicDataForWindow(data: SearchTopicData[], window: TimeWindow): SearchTopicData[] {
  return data.map((topic) => ({ ...topic, observations: topic.observations.slice(-TIME_WINDOWS[window]) }))
}

export function rankEntries(
  data: SearchTopicData[],
  scoreType: 'overallScore' | 'trendingScore' = 'overallScore',
  window: TimeWindow = '30D',
): LeaderboardEntry[] {
  return scoreTopics(selectTopicDataForWindow(data, window))
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
