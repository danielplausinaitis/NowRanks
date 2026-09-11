import { describe, expect, it, vi } from 'vitest'
import { computeLiveLaneMovement, computeUnifiedMovement, readLiveLeaderboard } from './liveLeaderboardReadService.mjs'

const header = { snapshot_id: 'snapshot-current', ingestion_run_id: 'run-current', cycle_id: 'cycle-current', data_mode: 'live', selected_window: '1Y', scored_at: '2026-09-04T12:00:00.000Z', snapshot_format_version: 2, ingestion_runs: { status: 'succeeded' } }
const previousHeader = { snapshot_id: 'snapshot-previous', ingestion_run_id: 'run-previous', cycle_id: 'cycle-previous', data_mode: 'live', selected_window: '1Y', scored_at: '2026-09-04T08:00:00.000Z', snapshot_format_version: 2, ingestion_runs: { status: 'succeeded' } }

function unifiedRow({ rank = 1, id = `unified-${rank}`, snapshotId = header.snapshot_id, ...patch } = {}) {
  return {
    snapshot_entry_id: `entry-${snapshotId}-${id}`, snapshot_id: snapshotId, candidate_id: `candidate-${id}`,
    score_lane: 'unified', lane_rank: null, score_basis: 'unified-public', overall_score: null, established_trending_score: null, emerging_trending_score: null,
    public_rank: rank, public_score: 82, evidence_status: 'emerging', classification: 'possible-new-trend', confidence: 'emerging', confidence_reason: 'sufficient persisted evidence',
    history_observation_count: 365, history_available_count: 365, history_coverage_percentage: 100, search_interest_component: 42,
    component_availability: { presentation: { growthPercent: 184, growthSource: 'provider-history', growthSaturated: false, trendHeat: 'surging' } },
    candidates: { candidate_id: `candidate-${id}`, query_text: `Topic ${id}`, normalized_query: `topic-${id}`, category: 'Technology' }, ...patch,
  }
}

function repository({ latestUnified = header, exact = header, previousUnified = null, entries = [unifiedRow()], previousEntries = [], latestLegacy = null } = {}) {
  return {
    getLatestUnifiedLiveSnapshot: vi.fn(async () => latestUnified), getUnifiedLiveSnapshot: vi.fn(async () => exact),
    getLatestLiveSnapshot: vi.fn(async () => latestLegacy), getPreviousUnifiedLiveSnapshot: vi.fn(async () => previousUnified),
    listLiveSnapshotEntries: vi.fn(async ({ snapshotId }) => snapshotId === previousUnified?.snapshot_id ? previousEntries : entries),
  }
}

describe('live movement helpers', () => {
  it('calculates legacy movement only in the same topic and lane', () => {
    const current = [{ candidateId: 'candidate-topic', scoreLane: 'established', laneRank: 2 }]
    const previous = [{ candidateId: 'candidate-topic', scoreLane: 'established', laneRank: 5 }]
    expect(computeLiveLaneMovement({ currentEntries: current, previousEntries: previous, previousSnapshotExists: true })[0].movement).toEqual({ state: 'up', delta: 3, previousRank: 5 })
  })

  it('calculates unified movement by candidate and public rank', () => {
    expect(computeUnifiedMovement({ currentEntries: [{ candidateId: 'candidate-topic', publicRank: 2 }], previousEntries: [{ candidateId: 'candidate-topic', publicRank: 5 }], previousSnapshotExists: true })[0].movement).toEqual({ state: 'up', delta: 3, previousRank: 5 })
  })
})

describe('public persisted live leaderboard read service', () => {
  it('defaults to the latest successful 24H v2 snapshot', async () => {
    const latest24H = { ...header, snapshot_id: 'snapshot-24h', cycle_id: 'cycle-24h', selected_window: '24H' }
    const repo = repository({ latestUnified: latest24H, entries: [unifiedRow({ snapshotId: latest24H.snapshot_id })] })
    const result = await readLiveLeaderboard({ repository: repo })
    expect(repo.getLatestUnifiedLiveSnapshot).toHaveBeenCalledWith({ selectedWindow: '24H' })
    expect(result.snapshot).toMatchObject({ snapshotId: 'snapshot-24h', selectedWindow: '24H', snapshotFormatVersion: 2 })
  })

  it.each(['24H', '7D', '30D', '1Y'])('returns the latest successful v2 %s snapshot only', async (selectedWindow) => {
    const selected = { ...header, snapshot_id: `snapshot-${selectedWindow}`, selected_window: selectedWindow }
    const repo = repository({ latestUnified: selected, entries: [unifiedRow({ snapshotId: selected.snapshot_id })] })
    const result = await readLiveLeaderboard({ repository: repo, selectedWindow })
    expect(repo.getLatestUnifiedLiveSnapshot).toHaveBeenCalledWith({ selectedWindow })
    expect(result.snapshot.selectedWindow).toBe(selectedWindow)
  })

  it('keeps each horizon latest independently when a newer 1Y snapshot exists', async () => {
    const latestByWindow = {
      '24H': { ...header, snapshot_id: 'snapshot-24h', cycle_id: 'cycle-24h', selected_window: '24H', scored_at: '2026-09-11T12:00:00.000Z' },
      '1Y': { ...header, snapshot_id: 'snapshot-1y', cycle_id: 'cycle-1y', selected_window: '1Y', scored_at: '2026-09-11T12:03:00.000Z' },
    }
    const repo = repository({ latestUnified: null, entries: [unifiedRow({ snapshotId: latestByWindow['24H'].snapshot_id })] })
    repo.getLatestUnifiedLiveSnapshot.mockImplementation(async ({ selectedWindow }) => latestByWindow[selectedWindow] ?? null)
    const result = await readLiveLeaderboard({ repository: repo, selectedWindow: '24H' })
    expect(result.snapshot).toMatchObject({ snapshotId: 'snapshot-24h', selectedWindow: '24H' })
    expect(repo.getLatestUnifiedLiveSnapshot).toHaveBeenCalledOnce()
  })

  it('uses the same successful v2 window contract for exact-cycle reads', async () => {
    const repo = repository()
    await readLiveLeaderboard({ repository: repo, selectedWindow: '1Y', cycleId: 'cycle-current' })
    expect(repo.getUnifiedLiveSnapshot).toHaveBeenCalledWith({ cycleId: 'cycle-current', selectedWindow: '1Y' })
    expect(repo.getLatestUnifiedLiveSnapshot).not.toHaveBeenCalled()
  })

  it('uses only a prior v2 snapshot from the same window for movement', async () => {
    const repo = repository({ entries: [unifiedRow({ rank: 2, id: 'same' }), unifiedRow({ rank: 1, id: 'new' })], previousUnified: previousHeader, previousEntries: [unifiedRow({ snapshotId: previousHeader.snapshot_id, rank: 4, id: 'same' })] })
    const result = await readLiveLeaderboard({ repository: repo, selectedWindow: '1Y' })
    expect(repo.getPreviousUnifiedLiveSnapshot).toHaveBeenCalledWith({ selectedWindow: '1Y', beforeScoredAt: header.scored_at })
    expect(result.entries.find((entry) => entry.candidateId === 'candidate-same')).toMatchObject({ publicRank: 2, publicScore: 82, growthPercent: 184, growthSource: 'provider-history' })
    expect(result.entries.find((entry) => entry.candidateId === 'candidate-same').movement).toEqual({ state: 'up', delta: 2, previousRank: 4 })
    expect(result.entries.find((entry) => entry.candidateId === 'candidate-new').movement).toEqual({ state: 'new', delta: null, previousRank: null })
  })

  it('returns an explicit unavailable error when the requested v2 window is absent, without a legacy fallback', async () => {
    const repo = repository({ latestUnified: null, latestLegacy: { ...header, snapshot_format_version: 1 } })
    await expect(readLiveLeaderboard({ repository: repo, selectedWindow: '7D' })).rejects.toThrow('No live snapshot exists for window 7D')
    expect(repo.getLatestLiveSnapshot).not.toHaveBeenCalled()
  })

  it('rejects a legacy/non-v2 header if a repository incorrectly returns one', async () => {
    await expect(readLiveLeaderboard({ repository: repository({ latestUnified: { ...header, snapshot_format_version: 1 } }), selectedWindow: '1Y' })).rejects.toThrow('No live snapshot exists for window 1Y')
  })

  it('rejects a failed header if a repository incorrectly returns one', async () => {
    await expect(readLiveLeaderboard({ repository: repository({ latestUnified: { ...header, ingestion_runs: { status: 'failed' } } }), selectedWindow: '1Y' })).rejects.toThrow('No live snapshot exists for window 1Y')
  })

  it('rejects a mis-scoped repository result instead of returning another window', async () => {
    await expect(readLiveLeaderboard({ repository: repository({ latestUnified: header }), selectedWindow: '24H' })).rejects.toThrow('No live snapshot exists for window 24H')
  })
})
