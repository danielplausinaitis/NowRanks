import { describe, expect, it, vi } from 'vitest'
import { createSupabaseIngestionRepository } from './supabaseRepository.mjs'

function fakeSupabase() {
  const calls = []
  return {
    calls,
    from(table) {
      return {
        async upsert(rows, options) {
          calls.push({ table, rows, options })
          return { data: null, error: null }
        },
      }
    },
  }
}

describe('Supabase live ingestion repository', () => {
  it('uses deterministic conflict identities for every additive live table and canonical observations', async () => {
    const supabase = fakeSupabase()
    const repository = createSupabaseIngestionRepository(supabase)
    await repository.upsertLiveEvidence([{ evidence_id: 'evidence' }])
    await repository.upsertLiveProvenance([{ provenance_id: 'provenance' }])
    await repository.upsertLiveObservations([{ observation_id: 'observation' }])
    await repository.upsertLiveSnapshot({ snapshot_id: 'snapshot' })
    await repository.upsertLiveSnapshotEntries([{ snapshot_entry_id: 'entry' }])
    expect(supabase.calls.map(({ table, options }) => [table, options.onConflict])).toEqual([
      ['live_provider_evidence', 'evidence_id'],
      ['source_provenance', 'provenance_id'],
      ['observations', 'observation_id'],
      ['live_leaderboard_snapshots', 'snapshot_id'],
      ['live_leaderboard_snapshot_entries', 'snapshot_entry_id'],
    ])
  })

  it('exposes read-only live snapshot queries without using mutation operations', async () => {
    const calls = []
    const supabase = { from(table) {
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: table === 'live_leaderboard_snapshots' ? { snapshot_id: 'snapshot' } : null, error: null })),
      }
      calls.push({ table, query })
      return query
    } }
    const repository = createSupabaseIngestionRepository(supabase)
    await repository.getLatestLiveSnapshot({ selectedWindow: '1Y' })
    await repository.getLiveSnapshot({ cycleId: 'cycle', selectedWindow: '1Y' })
    await repository.listLiveSnapshotEntries({ snapshotId: 'snapshot' })
    expect(calls.map((call) => call.table)).toEqual(['live_leaderboard_snapshots', 'live_leaderboard_snapshots', 'live_leaderboard_snapshot_entries'])
    expect(calls.every(({ query }) => !('insert' in query) && !('update' in query) && !('upsert' in query))).toBe(true)
  })
})
