import type { Category, RankingMode, TimeWindow } from '../domain/types'

export type ApiRankMovement =
  | { status: 'moved', delta: number, previousRank: number }
  | { status: 'unchanged', delta: 0, previousRank: number }
  | { status: 'new', delta: null, previousRank: null }
  | { status: 'unavailable', delta: null, previousRank: null }

export interface LeaderboardApiResponse {
  metadata: {
    providerId: string
    dataMode: 'live' | 'replay' | 'test'
    window: TimeWindow
    mode: RankingMode
    category: Category | null
    observedFrom: string
    observedThrough: string
    comparisonAvailable: boolean
    comparisonObservedThrough: string | null
    generatedAt: string
  }
  entries: Array<{ rank: number, candidateId: string, topic: string, category: Category, score: number, movement: ApiRankMovement }>
}

export class LeaderboardApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'LeaderboardApiError'
  }
}

/** Browser-only client for the public, read-only leaderboard API. */
export async function fetchLeaderboard({ window, mode, category, signal }: { window: TimeWindow, mode: RankingMode, category?: Category, signal?: AbortSignal }): Promise<LeaderboardApiResponse> {
  const params = new URLSearchParams({ window, mode })
  if (category) params.set('category', category)
  const response = await fetch(`/api/leaderboard?${params}`, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new LeaderboardApiError('The leaderboard service is unavailable. Please try again.', response.status)
  const data = await response.json() as LeaderboardApiResponse
  if (!data?.metadata || !Array.isArray(data.entries)) throw new LeaderboardApiError('The leaderboard service returned an invalid response.')
  return data
}
