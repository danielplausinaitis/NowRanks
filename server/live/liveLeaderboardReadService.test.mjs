import { describe, expect, it, vi } from 'vitest'
import { computeLiveLaneMovement, readLiveLeaderboard } from './liveLeaderboardReadService.mjs'

const header = { snapshot_id: 'snapshot-current', ingestion_run_id: 'run-current', cycle_id: 'cycle-current', data_mode: 'live', selected_window: '1Y', scored_at: '2026-09-04T12:00:00.000Z' }
const previousHeader = { snapshot_id: 'snapshot-previous', ingestion_run_id: 'run-previous', cycle_id: 'cycle-previous', data_mode: 'live', selected_window: '1Y', scored_at: '2026-09-04T08:00:00.000Z' }
function row({ lane = 'established', rank = 1, id = `${lane}-${rank}`, snapshotId = header.snapshot_id, ...patch } = {}) {
  return { snapshot_entry_id: `entry-${snapshotId}-${id}`, snapshot_id: snapshotId, candidate_id: `candidate-${id}`, score_lane: lane, lane_rank: rank, classification: lane === 'established' ? 'established' : 'possible-new-trend', confidence: lane === 'established' ? 'full' : 'emerging', confidence_reason: 'sufficient persisted evidence', score_basis: lane === 'established' ? 'historical-trending' : 'current-emerging-evidence', overall_score: lane === 'established' ? 80 : null, established_trending_score: lane === 'established' ? 70 : null, emerging_trending_score: lane === 'emerging' ? 60 : null, history_observation_count: 365, history_available_count: 365, history_coverage_percentage: 100, search_interest_component: 42, component_availability: { presentation: { growthPercent: 184, trendHeat: 'surging' } }, candidates: { candidate_id: `candidate-${id}`, query_text: `Topic ${id}`, normalized_query: `topic-${id}`, category: 'Technology' }, ...patch }
}
function repository({ latest = header, exact = header, previous = null, entries = [row()], previousEntries = [] } = {}) {
  return { getLatestLiveSnapshot: vi.fn(async () => latest), getLiveSnapshot: vi.fn(async () => exact), getPreviousLiveSnapshot: vi.fn(async () => previous), listLiveSnapshotEntries: vi.fn(async ({ snapshotId }) => snapshotId === header.snapshot_id ? entries : previousEntries) }
}

describe('live lane movement', () => {
  it.each([['up', 5, 2, { state: 'up', delta: 3, previousRank: 5 }], ['down', 2, 5, { state: 'down', delta: -3, previousRank: 2 }], ['unchanged', 4, 4, { state: 'unchanged', delta: 0, previousRank: 4 }]])('calculates %s only from the same topic and lane', (_name, previousRank, currentRank, movement) => {
    const current = [{ candidateId: 'candidate-topic', scoreLane: 'established', laneRank: currentRank }]
    const previous = [{ candidateId: 'candidate-topic', scoreLane: 'established', laneRank: previousRank }]
    expect(computeLiveLaneMovement({ currentEntries: current, previousEntries: previous, previousSnapshotExists: true })[0].movement).toEqual(movement)
  })
  it('marks lane changes and absent same-lane topics as new, without a cross-lane delta', () => {
    const current = [{ candidateId: 'candidate-topic', scoreLane: 'emerging', laneRank: 2 }]
    const previous = [{ candidateId: 'candidate-topic', scoreLane: 'established', laneRank: 5 }]
    expect(computeLiveLaneMovement({ currentEntries: current, previousEntries: previous, previousSnapshotExists: true })[0].movement).toEqual({ state: 'new', delta: null, previousRank: null })
    expect(computeLiveLaneMovement({ currentEntries: current, previousEntries: [], previousSnapshotExists: false })[0].movement).toEqual({ state: 'unavailable', delta: null, previousRank: null })
  })
  it('fails safely when corrupted previous data duplicates a candidate across lanes', () => {
    const current = [{ candidateId: 'candidate-topic', scoreLane: 'established', laneRank: 1 }]
    const previous = [{ candidateId: 'candidate-topic', scoreLane: 'established', laneRank: 1 }, { candidateId: 'candidate-topic', scoreLane: 'emerging', laneRank: 1 }]
    expect(() => computeLiveLaneMovement({ currentEntries: current, previousEntries: previous, previousSnapshotExists: true })).toThrow(/duplicate candidate/)
  })
})

describe('live leaderboard read service', () => {
  it('looks up the current and closest strictly earlier selected-window snapshot, then returns independent sorted lanes', async () => {
    const repo = repository({ previous: previousHeader, entries: [row({ rank: 2, id: 'late' }), row({ rank: 1, id: 'first' }), row({ lane: 'emerging', rank: 2, id: 'em2' }), row({ lane: 'emerging', rank: 1, id: 'em1' })], previousEntries: [row({ snapshotId: previousHeader.snapshot_id, rank: 3, id: 'first' })] })
    const result = await readLiveLeaderboard({ repository: repo, selectedWindow: '1Y' })
    expect(repo.getLatestLiveSnapshot).toHaveBeenCalledWith({ selectedWindow: '1Y' }); expect(repo.getPreviousLiveSnapshot).toHaveBeenCalledWith({ selectedWindow: '1Y', beforeScoredAt: header.scored_at }); expect(repo.listLiveSnapshotEntries).toHaveBeenCalledTimes(2)
    expect(result.established.map((entry) => entry.laneRank)).toEqual([1, 2]); expect(result.emerging.map((entry) => entry.laneRank)).toEqual([1, 2])
    expect(result.established[0]).toMatchObject({ candidateId: 'candidate-first', scoreLane: 'established', growthPercent: 184, trendHeat: 'surging', movement: { state: 'up', delta: 2, previousRank: 3 } }); expect(result.emerging[0].movement).toEqual({ state: 'new', delta: null, previousRank: null })
  })
  it.each(['24H', '7D', '30D', '1Y'])('selects a prior snapshot only in the same %s window', async (selectedWindow) => {
    const repo = repository(); await readLiveLeaderboard({ repository: repo, selectedWindow }); expect(repo.getPreviousLiveSnapshot).toHaveBeenCalledWith({ selectedWindow, beforeScoredAt: header.scored_at })
  })
  it('marks every current entry unavailable when no prior snapshot exists', async () => {
    const result = await readLiveLeaderboard({ repository: repository({ entries: [row({ id: 'one' }), row({ lane: 'emerging', id: 'two' })] }) }); expect([...result.established, ...result.emerging].every((entry) => entry.movement.state === 'unavailable')).toBe(true)
  })
  it('looks up an exact cycle and window without a replay fallback', async () => { const repo = repository(); await readLiveLeaderboard({ repository: repo, selectedWindow: '1Y', cycleId: 'cycle-current' }); expect(repo.getLiveSnapshot).toHaveBeenCalledWith({ cycleId: 'cycle-current', selectedWindow: '1Y' }); expect(repo.getLatestLiveSnapshot).not.toHaveBeenCalled() })
  it('fails clearly when no selected snapshot exists', async () => { await expect(readLiveLeaderboard({ repository: repository({ latest: null }) })).rejects.toThrow('No live snapshot exists for window 1Y') })
  it.each([['established cannot contain emerging score', row({ emerging_trending_score: 1 })], ['emerging cannot contain overall score', row({ lane: 'emerging', overall_score: 1 })], ['emerging cannot contain established score', row({ lane: 'emerging', established_trending_score: 1 })]])('rejects corrupted score lanes: %s', async (_label, invalid) => { await expect(readLiveLeaderboard({ repository: repository({ entries: [invalid] }) })).rejects.toThrow('Malformed live persisted data') })
  it('rejects duplicate ranks within a lane', async () => { await expect(readLiveLeaderboard({ repository: repository({ entries: [row({ id: 'one' }), row({ id: 'two' })] }) })).rejects.toThrow('duplicate established lane rank 1') })
})
