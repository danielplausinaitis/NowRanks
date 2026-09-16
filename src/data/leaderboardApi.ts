import type { Category, RankingMode, TimeWindow } from '../domain/types'

export type ApiRankMovement =
  | { status: 'moved', delta: number, previousRank: number }
  | { status: 'unchanged', delta: 0, previousRank: number }
  | { status: 'new', delta: null, previousRank: null }
  | { status: 'unavailable', delta: null, previousRank: null }

export type LiveRankMovement =
  | { state: 'up', delta: number, previousRank: number }
  | { state: 'down', delta: number, previousRank: number }
  | { state: 'unchanged', delta: 0, previousRank: number }
  | { state: 'new', delta: null, previousRank: null }
  | { state: 'unavailable', delta: null, previousRank: null }

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
  growthPercent?: number | null
  growthSource?: 'nowranks-history' | 'provider-history' | 'discovery-increase' | 'unavailable'
  growthSaturated?: boolean
  trendHeat?: 'stable' | 'rising' | 'fast' | 'surging' | 'exploding' | null
  heatStatus?: 'available' | 'pending'
  heatLevel?: 'stable' | 'rising' | 'fast' | 'surging' | 'exploding' | null
  heatEvidenceAvailable?: boolean
  heatEvidenceSource?: 'historical-shape' | 'discovery-acceleration' | 'current-intensity' | 'mixed' | 'legacy-heat-source-not-recorded' | null
  heatFallbackUsed?: boolean
  heatPendingReason?: string | null
  scoredAt: string
  cycleId: string
  selectedWindow: TimeWindow
  movement: LiveRankMovement
}

export interface LiveLeaderboardApiResponse {
  dataMode: 'live'
  source: 'persisted-live-snapshot'
  persisted: true
  rankingMode?: 'legacy-lanes'
  snapshot: { cycleId: string, selectedWindow: TimeWindow, scoredAt: string, snapshotFormatVersion?: 1 }
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

export interface UnifiedLiveLeaderboardApiEntry extends Omit<LiveLeaderboardApiEntry, 'scoreLane' | 'laneRank' | 'scoreBasis' | 'overallScore' | 'establishedTrendingScore' | 'emergingTrendingScore'> {
  publicRank: number
  publicScore: number
  evidenceStatus: 'established' | 'emerging'
}

export interface UnifiedLiveLeaderboardApiResponse {
  dataMode: 'live'
  source: 'persisted-live-snapshot'
  persisted: true
  rankingMode: 'unified' | 'unsupported'
  window: TimeWindow
  snapshot: { cycleId: string, selectedWindow: TimeWindow, scoredAt: string, snapshotFormatVersion: number }
  metadata: { mode: RankingMode, category: Category | null, compatibility: { status: string, snapshotFormatVersion?: number, diagnostics: unknown[] } }
  entries: UnifiedLiveLeaderboardApiEntry[]
}

export type LiveApiResponse = LiveLeaderboardApiResponse | UnifiedLiveLeaderboardApiResponse
export type LeaderboardApiResponse = ReplayLeaderboardApiResponse | LiveApiResponse

export class LeaderboardApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'LeaderboardApiError'
  }
}

/** Browser-only client for the public, read-only leaderboard API. */
export async function fetchLeaderboard({ window, mode, category, signal }: { window: TimeWindow, mode: RankingMode, category?: Category, signal?: AbortSignal }): Promise<UnifiedLiveLeaderboardApiResponse> {
  const params = new URLSearchParams({ window, mode })
  if (category) params.set('category', category)
  const response = await fetch(`/api/leaderboard?${params}`, { signal, headers: { Accept: 'application/json' } })
  const data = await response.json() as unknown
  if (!response.ok) {
    const code = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'object' && data.error !== null && 'code' in data.error && typeof data.error.code === 'string' ? data.error.code : undefined
    const message = code === 'live_snapshot_not_found' ? 'No live snapshot is available for this window yet.' : 'The leaderboard service is unavailable. Please try again.'
    throw new LeaderboardApiError(message, response.status, code)
  }
  if (isPersistedUnifiedLiveResponse(data, window)) return data
  throw new LeaderboardApiError('The leaderboard service did not return a persisted live public snapshot.')
}

function isPersistedUnifiedLiveResponse(data: unknown, requestedWindow: TimeWindow): data is UnifiedLiveLeaderboardApiResponse {
  const entries = typeof data === 'object' && data !== null ? (data as { entries?: unknown }).entries : null
  return typeof data === 'object' && data !== null
    && (data as { dataMode?: unknown }).dataMode === 'live'
    && (data as { source?: unknown }).source === 'persisted-live-snapshot'
    && (data as { rankingMode?: unknown }).rankingMode === 'unified'
    && (data as { window?: unknown }).window === requestedWindow
    && (data as { snapshot?: { selectedWindow?: unknown } }).snapshot?.selectedWindow === requestedWindow
    && (data as { snapshot?: { snapshotFormatVersion?: unknown } }).snapshot?.snapshotFormatVersion === 2
    && Array.isArray(entries)
    && entries.every((entry) => typeof entry === 'object' && entry !== null
      && Number.isInteger((entry as { publicRank?: unknown }).publicRank)
      && (entry as { publicRank: number }).publicRank >= 1
      && (entry as { publicRank: number }).publicRank <= 20
      && Number.isFinite((entry as { publicScore?: unknown }).publicScore))
}
