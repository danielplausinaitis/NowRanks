import { describe, expect, it, vi } from 'vitest'
import { readLiveLeaderboard } from './liveLeaderboardReadService.mjs'

const header = { snapshot_id: 'snapshot-1', ingestion_run_id: 'run-1', cycle_id: 'cycle-1', data_mode: 'live', selected_window: '1Y', scored_at: '2026-09-04T12:00:00.000Z' }
function row({ lane = 'established', rank = 1, id = `${lane}-${rank}`, ...patch } = {}) {
  return {
    snapshot_entry_id: `entry-${id}`, snapshot_id: 'snapshot-1', candidate_id: `candidate-${id}`,
    score_lane: lane, lane_rank: rank, classification: lane === 'established' ? 'established' : 'possible-new-trend',
    confidence: lane === 'established' ? 'full' : 'emerging', confidence_reason: 'sufficient persisted evidence',
    score_basis: lane === 'established' ? 'historical-trending' : 'current-emerging-evidence',
    overall_score: lane === 'established' ? 80 : null, established_trending_score: lane === 'established' ? 70 : null, emerging_trending_score: lane === 'emerging' ? 60 : null,
    history_observation_count: 365, history_available_count: 365, history_coverage_percentage: 100, search_interest_component: 42, component_availability: {},
    candidates: { candidate_id: `candidate-${id}`, query_text: `Topic ${id}`, normalized_query: `topic-${id}`, category: 'Technology' }, ...patch,
  }
}
function repository({ latest = header, exact = header, entries = [row()] } = {}) {
  return {
    getLatestLiveSnapshot: vi.fn(async () => latest), getLiveSnapshot: vi.fn(async () => exact), listLiveSnapshotEntries: vi.fn(async () => entries),
  }
}

describe('live leaderboard read service', () => {
  it('looks up the latest selected-window snapshot and returns independent sorted lanes', async () => {
    const repo = repository({ entries: [row({ rank: 2, id: 'late' }), row({ rank: 1, id: 'first' }), row({ lane: 'emerging', rank: 2, id: 'em2' }), row({ lane: 'emerging', rank: 1, id: 'em1' })] })
    const result = await readLiveLeaderboard({ repository: repo, selectedWindow: '1Y' })
    expect(repo.getLatestLiveSnapshot).toHaveBeenCalledWith({ selectedWindow: '1Y' })
    expect(repo.getLiveSnapshot).not.toHaveBeenCalled()
    expect(result.established.map((entry) => entry.laneRank)).toEqual([1, 2])
    expect(result.emerging.map((entry) => entry.laneRank)).toEqual([1, 2])
    expect(result.established[0]).toMatchObject({ candidateId: 'candidate-first', title: 'Topic first', scoreLane: 'established', overallScore: 80, emergingTrendingScore: null, cycleId: 'cycle-1', selectedWindow: '1Y' })
    expect(result.established[0]).not.toHaveProperty('rank')
    expect(result).not.toHaveProperty('entries')
  })

  it('looks up an exact cycle and window without a replay fallback', async () => {
    const repo = repository()
    await readLiveLeaderboard({ repository: repo, selectedWindow: '1Y', cycleId: 'cycle-1' })
    expect(repo.getLiveSnapshot).toHaveBeenCalledWith({ cycleId: 'cycle-1', selectedWindow: '1Y' })
    expect(repo.getLatestLiveSnapshot).not.toHaveBeenCalled()
    expect(repo).not.toHaveProperty('listProvenance')
  })

  it('fails clearly when no selected snapshot exists', async () => {
    await expect(readLiveLeaderboard({ repository: repository({ latest: null }) })).rejects.toThrow('No live snapshot exists for window 1Y')
  })

  it.each([
    ['established cannot contain emerging score', row({ emerging_trending_score: 1 })],
    ['emerging cannot contain overall score', row({ lane: 'emerging', overall_score: 1 })],
    ['emerging cannot contain established score', row({ lane: 'emerging', established_trending_score: 1 })],
  ])('rejects corrupted score lanes: %s', async (_label, invalid) => {
    await expect(readLiveLeaderboard({ repository: repository({ entries: [invalid] }) })).rejects.toThrow('Malformed live persisted data')
  })

  it('rejects duplicate ranks within a lane', async () => {
    await expect(readLiveLeaderboard({ repository: repository({ entries: [row({ id: 'one' }), row({ id: 'two' })] }) })).rejects.toThrow('duplicate established lane rank 1')
  })
})
