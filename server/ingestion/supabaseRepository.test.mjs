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
    await repository.upsertLiveHistoricalVaultMeasurements([{ measurement_id: 'vault' }])
    await repository.upsertLiveProviderCurveArtifacts([{ artifact_id: 'artifact' }])
    await repository.upsertLiveCanonicalAttentionAlignments([{ alignment_id: 'alignment' }])
    await repository.upsertLiveCanonicalAttentionPoints([{ point_id: 'point' }])
    await repository.upsertLiveSnapshot({ snapshot_id: 'snapshot' })
    await repository.upsertLiveSnapshotEntries([{ snapshot_entry_id: 'entry' }])
    expect(supabase.calls.map(({ table, options }) => [table, options.onConflict])).toEqual([
      ['live_provider_evidence', 'evidence_id'],
      ['source_provenance', 'provenance_id'],
      ['observations', 'observation_id'],
      ['live_historical_vault_measurements', 'candidate_id,metric_key,metric_version,comparability_key,slot_at'],
      ['live_provider_curve_artifacts', 'ingestion_run_id,candidate_id,provider_id,request_window'],
      ['live_canonical_attention_alignments', 'alignment_id'],
      ['live_canonical_attention_points', 'candidate_id,series_key,segment_id,observed_at'],
      ['live_leaderboard_snapshots', 'snapshot_id'],
      ['live_leaderboard_snapshot_entries', 'snapshot_entry_id'],
    ])
  })

  it('exposes read-only live snapshot queries without using mutation operations', async () => {
    const calls = []
    const supabase = { from(table) {
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query), lt: vi.fn(() => query), order: vi.fn(() => query), limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: table === 'live_leaderboard_snapshots' ? { snapshot_id: 'snapshot' } : null, error: null })),
      }
      calls.push({ table, query })
      return query
    } }
    const repository = createSupabaseIngestionRepository(supabase)
    await repository.getLatestLiveSnapshot({ selectedWindow: '1Y' })
    await repository.getLatestUnifiedLiveSnapshot({ selectedWindow: '1Y' })
    await repository.getPreviousLiveSnapshot({ selectedWindow: '1Y', beforeScoredAt: '2026-09-04T12:00:00.000Z' })
    await repository.getUnifiedLiveSnapshot({ cycleId: 'cycle', selectedWindow: '1Y' })
    await repository.listLiveSnapshotEntries({ snapshotId: 'snapshot' })
    await repository.listRecentLiveIngestionRuns({ limit: 10 })
    await repository.listRunningLiveIngestionRuns()
    expect(calls.map((call) => call.table)).toEqual(['live_leaderboard_snapshots', 'live_leaderboard_snapshots', 'live_leaderboard_snapshots', 'live_leaderboard_snapshots', 'live_leaderboard_snapshot_entries', 'ingestion_runs', 'ingestion_runs'])
    expect(calls.every(({ query }) => !('insert' in query) && !('update' in query) && !('upsert' in query))).toBe(true)
  })

  it('ignores failed snapshots by filtering public reads to live, requested-window v2 succeeded runs', async () => {
    const filters = []
    const supabase = { from() {
      const query = {
        select: vi.fn(() => query), eq: vi.fn((column, value) => { filters.push([column, value]); return query }),
        lt: vi.fn(() => query), order: vi.fn(() => query), limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      }
      return query
    } }
    const repository = createSupabaseIngestionRepository(supabase)
    await repository.getLatestUnifiedLiveSnapshot({ selectedWindow: '24H' })
    expect(filters).toEqual(expect.arrayContaining([
      ['data_mode', 'live'], ['selected_window', '24H'], ['snapshot_format_version', 2], ['ingestion_runs.status', 'succeeded'],
    ]))
  })

  it('reads canonical alignment cycle identity from ingestion_runs.idempotency_key, never a nonexistent cycle_id', async () => {
    const calls = []
    const supabase = { from(table) {
      const query = {
        select: vi.fn((selection) => { calls.push({ table, selection }); return query }), eq: vi.fn(() => query), order: vi.fn(() => query),
        limit: vi.fn(async () => ({ data: [], error: null })),
      }
      return query
    } }
    const repository = createSupabaseIngestionRepository(supabase)
    await repository.listLiveCanonicalAttentionAlignments({ candidateId: 'candidate' })
    expect(calls[0].selection).toContain('idempotency_key')
    expect(calls[0].selection).not.toContain('cycle_id')
  })
})
