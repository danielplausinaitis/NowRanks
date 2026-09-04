import { SupabaseOperationError } from './errorDiagnostics.mjs'

function requireSuccess(result, operation, table) {
  if (result.error) throw new SupabaseOperationError({ operation, table, error: result.error })
  return result.data
}

/** Concrete Supabase Data API adapter; no browser module imports this file. */
export function createSupabaseIngestionRepository(supabase) {
  return {
    async findRunByIdempotencyKey(idempotencyKey) {
      return requireSuccess(await supabase.from('ingestion_runs').select('*').eq('idempotency_key', idempotencyKey).maybeSingle(), 'select', 'ingestion_runs')
    },
    async createRun(run) {
      requireSuccess(await supabase.from('ingestion_runs').insert(run), 'insert', 'ingestion_runs')
    },
    async updateRun(runId, patch) {
      requireSuccess(await supabase.from('ingestion_runs').update(patch).eq('run_id', runId), 'update', 'ingestion_runs')
    },
    async upsertCandidate(candidate) {
      const existing = requireSuccess(await supabase.from('candidates').select('candidate_id').eq('normalized_query', candidate.normalized_query).maybeSingle(), 'select', 'candidates')
      if (existing) {
        requireSuccess(await supabase.from('candidates').update({ query_text: candidate.query_text, category: candidate.category }).eq('candidate_id', existing.candidate_id), 'update', 'candidates')
        return existing.candidate_id
      }
      const created = requireSuccess(await supabase.from('candidates').upsert(candidate, { onConflict: 'candidate_id' }).select('candidate_id').single(), 'upsert', 'candidates')
      return created.candidate_id
    },
    async upsertProvenance(provenance) {
      requireSuccess(await supabase.from('source_provenance').upsert(provenance, { onConflict: 'provenance_id' }), 'upsert', 'source_provenance')
    },
    async upsertObservations(observations) {
      requireSuccess(await supabase.from('observations').upsert(observations, { onConflict: 'candidate_id,provenance_id,observed_at' }), 'upsert batch', 'observations')
    },
    async upsertLiveEvidence(evidence) {
      requireSuccess(await supabase.from('live_provider_evidence').upsert(evidence, { onConflict: 'evidence_id' }), 'upsert batch', 'live_provider_evidence')
    },
    async upsertLiveProvenance(provenance) {
      requireSuccess(await supabase.from('source_provenance').upsert(provenance, { onConflict: 'provenance_id' }), 'upsert batch', 'source_provenance')
    },
    async upsertLiveObservations(observations) {
      requireSuccess(await supabase.from('observations').upsert(observations, { onConflict: 'observation_id' }), 'upsert batch', 'observations')
    },
    async upsertLiveSnapshot(snapshot) {
      requireSuccess(await supabase.from('live_leaderboard_snapshots').upsert(snapshot, { onConflict: 'snapshot_id' }), 'upsert', 'live_leaderboard_snapshots')
    },
    async upsertLiveSnapshotEntries(entries) {
      requireSuccess(await supabase.from('live_leaderboard_snapshot_entries').upsert(entries, { onConflict: 'snapshot_entry_id' }), 'upsert batch', 'live_leaderboard_snapshot_entries')
    },
    /** Read-only live snapshot lookup. This deliberately never falls back to replay tables. */
    async getLatestLiveSnapshot({ selectedWindow }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshots').select('*')
        .eq('data_mode', 'live').eq('selected_window', selectedWindow)
        .order('scored_at', { ascending: false }).limit(1).maybeSingle(), 'select latest', 'live_leaderboard_snapshots')
    },
    async getLiveSnapshot({ cycleId, selectedWindow }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshots').select('*')
        .eq('data_mode', 'live').eq('cycle_id', cycleId).eq('selected_window', selectedWindow)
        .maybeSingle(), 'select exact', 'live_leaderboard_snapshots')
    },
    async listLiveSnapshotEntries({ snapshotId }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshot_entries')
        .select('*, candidates!inner(candidate_id, query_text, normalized_query, category)')
        .eq('snapshot_id', snapshotId), 'select', 'live_leaderboard_snapshot_entries') ?? []
    },
    async listLiveBaselineDemandCache({ cacheKeys }) { return requireSuccess(await supabase.from('live_baseline_demand_cache').select('*').in('cache_key', cacheKeys), 'select', 'live_baseline_demand_cache') ?? [] },
    async upsertLiveBaselineDemandCache(rows) { requireSuccess(await supabase.from('live_baseline_demand_cache').upsert(rows, { onConflict: 'cache_key' }), 'upsert batch', 'live_baseline_demand_cache') },
  }
}
