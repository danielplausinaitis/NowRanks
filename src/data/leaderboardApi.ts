import type { Category, RankingMode, TimeWindow } from '../domain/types'

export type ApiRankMovement =
  | { status: 'moved', delta: number, previousRank: number }
  | { status: 'unchanged', delta: 0, previousRank: number }
  | { status: 'new', delta: null, previousRank: null }
  | { status: 'unavailable', delta: null, previousRank: null }

export interface ReplayLeaderboardApiResponse {
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

export interface LiveLeaderboardApiEntry {
  candidateId: string
  query: string
  title: string
  normalizedQuery: string
  category: Category
  scoreLane: 'established' | 'emerging'
  laneRank: number
  classification: 'established' | 'partial-history' | 'possible-new-trend'
  confidence: 'full' | 'partial-high' | 'partial-low' | 'emerging'
  confidenceReason: string
  scoreBasis: 'historical-trending' | 'current-emerging-evidence'
  overallScore: number | null
  establishedTrendingScore: number | null
  emergingTrendingScore: number | null
  historyObservationCount: number
  historyAvailableCount: number
  historyCoveragePercentage: number
  searchInterest: number | null
  componentAvailability: Record<string, unknown>
  scoredAt: string
  cycleId: string
  selectedWindow: TimeWindow
}

export interface LiveLeaderboardApiResponse {
  dataMode: 'live'
  source: 'persisted-live-snapshot'
  persisted: true
  snapshot: { cycleId: string, selectedWindow: TimeWindow, scoredAt: string }
  metadata: {
    mode: RankingMode
    category: Category | null
    establishedCount: number
    emergingCount: number
    categoryRankSemantics: 'persisted-global-lane-rank' | 'persisted-global-lane-rank-not-reranked'
  }
  established: LiveLeaderboardApiEntry[]
  emerging: LiveLeaderboardApiEntry[]
}

export type LeaderboardApiResponse = ReplayLeaderboardApiResponse | LiveLeaderboardApiResponse

export class LeaderboardApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'LeaderboardApiError'
  }
}

/** Browser-only client for the public, read-only leaderboard API. */
export async function fetchLeaderboard({ window, mode, category, signal }: { window: TimeWindow, mode: RankingMode, category?: Category, signal?: AbortSignal }): Promise<LeaderboardApiResponse> {
  const params = new URLSearchParams({ window, mode })
  if (category) params.set('category', category)
  const response = await fetch(`/api/leaderboard?${params}`, { signal, headers: { Accept: 'application/json' } })
  const data = await response.json() as unknown
  if (!response.ok) {
    const code = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'object' && data.error !== null && 'code' in data.error && typeof data.error.code === 'string' ? data.error.code : undefined
    const message = code === 'live_snapshot_not_found' ? 'No live snapshot is available for this window yet.' : 'The leaderboard service is unavailable. Please try again.'
    throw new LeaderboardApiError(message, response.status, code)
  }
  if (isReplayResponse(data) || isLiveResponse(data)) return data
  throw new LeaderboardApiError('The leaderboard service returned an invalid response.')
}

function isReplayResponse(data: unknown): data is ReplayLeaderboardApiResponse {
  return typeof data === 'object' && data !== null && 'metadata' in data && 'entries' in data && Array.isArray(data.entries)
}

function isLiveResponse(data: unknown): data is LiveLeaderboardApiResponse {
  return typeof data === 'object' && data !== null && (data as { dataMode?: unknown }).dataMode === 'live'
    && (data as { source?: unknown }).source === 'persisted-live-snapshot'
    && Array.isArray((data as { established?: unknown }).established) && Array.isArray((data as { emerging?: unknown }).emerging)
}
