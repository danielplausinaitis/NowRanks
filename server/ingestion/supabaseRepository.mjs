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
    /** Read-only scheduler health input; no provider or persistence side effects. */
    async listRecentLiveIngestionRuns({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Ingestion-run limit must be an integer between 1 and 500')
      return requireSuccess(await supabase.from('ingestion_runs').select('*').eq('data_mode', 'live').order('started_at', { ascending: false }).limit(limit), 'select recent live ingestion runs', 'ingestion_runs') ?? []
    },
    async listRunningLiveIngestionRuns() {
      return requireSuccess(await supabase.from('ingestion_runs').select('*').eq('data_mode', 'live').eq('status', 'running').order('started_at', { ascending: false }), 'select running live ingestion runs', 'ingestion_runs') ?? []
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
    async listCandidatesByNormalizedQueries({ normalizedQueries }) {
      return requireSuccess(await supabase.from('candidates').select('candidate_id, normalized_query')
        .in('normalized_query', normalizedQueries), 'select candidates', 'candidates') ?? []
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
    /** A retry must not replace the first evidence captured for a logical UTC slot. */
    async upsertLiveHistoricalVaultMeasurements(measurements) {
      if (!measurements.length) return
      requireSuccess(await supabase.from('live_historical_vault_measurements').upsert(measurements, {
        onConflict: 'candidate_id,metric_key,metric_version,comparability_key,slot_at', ignoreDuplicates: true,
      }), 'upsert batch', 'live_historical_vault_measurements')
    },
    /** Batch-only range read used by vault diagnostics and future scoring; never a provider call. */
    async listLiveHistoricalVaultMeasurements({ candidateIds, metricKey, comparabilityKey, startAt, endAt }) {
      let query = supabase.from('live_historical_vault_measurements').select('*').in('candidate_id', candidateIds)
      if (metricKey) query = query.eq('metric_key', metricKey)
      if (comparabilityKey) query = query.eq('comparability_key', comparabilityKey)
      if (startAt) query = query.gte('slot_at', startAt)
      if (endAt) query = query.lte('slot_at', endAt)
      return requireSuccess(await query.order('slot_at', { ascending: true }), 'select range', 'live_historical_vault_measurements') ?? []
    },
    /** Canonical tables are batch-only: one curve artifact, one event, then its immutable points. */
    async upsertLiveProviderCurveArtifacts(rows) {
      if (!rows.length) return
      requireSuccess(await supabase.from('live_provider_curve_artifacts').upsert(rows, {
        onConflict: 'ingestion_run_id,candidate_id,provider_id,request_window', ignoreDuplicates: true,
      }), 'upsert batch', 'live_provider_curve_artifacts')
    },
    async upsertLiveCanonicalAttentionAlignments(rows) {
      if (!rows.length) return
      requireSuccess(await supabase.from('live_canonical_attention_alignments').upsert(rows, {
        onConflict: 'alignment_id', ignoreDuplicates: true,
      }), 'upsert batch', 'live_canonical_attention_alignments')
    },
    async upsertLiveCanonicalAttentionPoints(rows) {
      if (!rows.length) return
      requireSuccess(await supabase.from('live_canonical_attention_points').upsert(rows, {
        onConflict: 'candidate_id,series_key,segment_id,observed_at', ignoreDuplicates: true,
      }), 'upsert batch', 'live_canonical_attention_points')
    },
    /** One cohort query; callers group rows and never issue a per-topic history lookup. */
    async listLiveCanonicalAttentionPoints({ candidateIds, seriesKey, startAt, endAt }) {
      if (!candidateIds?.length) return []
      // A 7D canonical cohort can contain 20 * 336 hourly rows. Page through
      // the Data API limit rather than silently losing later candidates.
      const pageSize = 1_000
      const all = []
      for (let from = 0; ; from += pageSize) {
        let query = supabase.from('live_canonical_attention_points').select('*').in('candidate_id', candidateIds)
        if (seriesKey) query = query.eq('series_key', seriesKey)
        if (startAt) query = query.gte('observed_at', startAt)
        if (endAt) query = query.lte('observed_at', endAt)
        const page = requireSuccess(await query.order('observed_at', { ascending: true }).order('candidate_id', { ascending: true }).order('series_key', { ascending: true }).order('segment_id', { ascending: true }).range(from, from + pageSize - 1), 'select range', 'live_canonical_attention_points') ?? []
        all.push(...page)
        if (page.length < pageSize) return all
      }
    },
    async listLiveCanonicalAttentionAlignments({ candidateId, limit = 25 }) {
      return requireSuccess(await supabase.from('live_canonical_attention_alignments')
        .select('*, live_provider_curve_artifacts!inner(artifact_id, slot_at, ingestion_run_id, provider_id, provider_query, ingestion_runs!inner(run_id, idempotency_key), live_canonical_attention_points(point_id))')
        .eq('candidate_id', candidateId).order('created_at', { ascending: false }).limit(limit), 'select alignments', 'live_canonical_attention_alignments') ?? []
    },
    /** Read-only input for the bounded active tracking allocator. */
    async listRecentCanonicalTrackingArtifacts({ since }) {
      return requireSuccess(await supabase.from('live_provider_curve_artifacts')
        .select('candidate_id, slot_at, retrieved_at, targeting, raw_curve, candidates!inner(candidate_id, query_text, normalized_query, category), live_canonical_attention_alignments(accepted, reason, segment_id, series_key, confidence)')
        .gte('slot_at', since).order('slot_at', { ascending: false }), 'select tracking artifacts', 'live_provider_curve_artifacts') ?? []
    },
    async upsertLiveSnapshot(snapshot) {
      requireSuccess(await supabase.from('live_leaderboard_snapshots').upsert(snapshot, { onConflict: 'snapshot_id' }), 'upsert', 'live_leaderboard_snapshots')
    },
    async upsertLiveSnapshotEntries(entries) {
      requireSuccess(await supabase.from('live_leaderboard_snapshot_entries').upsert(entries, { onConflict: 'snapshot_entry_id' }), 'upsert batch', 'live_leaderboard_snapshot_entries')
    },
    /** Read-only live snapshot lookup. This deliberately never falls back to replay tables. */
    async getLatestLiveSnapshot({ selectedWindow }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshots').select('*, ingestion_runs!inner(status)')
        .eq('data_mode', 'live').eq('selected_window', selectedWindow).eq('ingestion_runs.status', 'succeeded')
        .order('scored_at', { ascending: false }).limit(1).maybeSingle(), 'select latest', 'live_leaderboard_snapshots')
    },
    async getLatestUnifiedLiveSnapshot({ selectedWindow }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshots').select('*, ingestion_runs!inner(status)')
        .eq('data_mode', 'live').eq('selected_window', selectedWindow).eq('snapshot_format_version', 2).eq('ingestion_runs.status', 'succeeded')
        .order('scored_at', { ascending: false }).limit(1).maybeSingle(), 'select latest unified', 'live_leaderboard_snapshots')
    },
    async getPreviousLiveSnapshot({ selectedWindow, beforeScoredAt }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshots').select('*, ingestion_runs!inner(status)')
        .eq('data_mode', 'live').eq('selected_window', selectedWindow).eq('ingestion_runs.status', 'succeeded')
        .lt('scored_at', beforeScoredAt)
        .order('scored_at', { ascending: false }).limit(1).maybeSingle(), 'select previous', 'live_leaderboard_snapshots')
    },
    /** v2 movement must never compare a unified public rank with a legacy lane rank. */
    async getPreviousUnifiedLiveSnapshot({ selectedWindow, beforeScoredAt }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshots').select('*, ingestion_runs!inner(status)')
        .eq('data_mode', 'live').eq('selected_window', selectedWindow).eq('snapshot_format_version', 2).eq('ingestion_runs.status', 'succeeded')
        .lt('scored_at', beforeScoredAt)
        .order('scored_at', { ascending: false }).limit(1).maybeSingle(), 'select previous unified', 'live_leaderboard_snapshots')
    },
    /** Exact-cycle public reads retain the same v2, live, successful contract. */
    async getUnifiedLiveSnapshot({ cycleId, selectedWindow }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshots').select('*, ingestion_runs!inner(status)')
        .eq('data_mode', 'live').eq('cycle_id', cycleId).eq('selected_window', selectedWindow).eq('snapshot_format_version', 2).eq('ingestion_runs.status', 'succeeded')
        .maybeSingle(), 'select exact unified', 'live_leaderboard_snapshots')
    },
    async listLiveSnapshotEntries({ snapshotId }) {
      return requireSuccess(await supabase.from('live_leaderboard_snapshot_entries')
        .select('*, candidates!inner(candidate_id, query_text, normalized_query, category)')
        .eq('snapshot_id', snapshotId), 'select', 'live_leaderboard_snapshot_entries') ?? []
    },
    async listLiveBaselineDemandCache({ cacheKeys }) { return requireSuccess(await supabase.from('live_baseline_demand_cache').select('*').in('cache_key', cacheKeys), 'select', 'live_baseline_demand_cache') ?? [] },
    async upsertLiveBaselineDemandCache(rows) { requireSuccess(await supabase.from('live_baseline_demand_cache').upsert(rows, { onConflict: 'cache_key' }), 'upsert batch', 'live_baseline_demand_cache') },
    /** One server-only daily discovery artifact is shared by every due horizon. */
    async getLiveDailyDiscoveryCache({ cacheKey }) { return requireSuccess(await supabase.from('live_daily_discovery_cache').select('*').eq('cache_key', cacheKey).maybeSingle(), 'select', 'live_daily_discovery_cache') },
    async upsertLiveDailyDiscoveryCache(row) { requireSuccess(await supabase.from('live_daily_discovery_cache').upsert(row, { onConflict: 'cache_key' }), 'upsert', 'live_daily_discovery_cache') },
    /** Historical Google Trends cache is keyed by provider, target, range, and resampling identity. */
    async listLiveGoogleTrendsHistoryCache({ cacheKeys }) { return requireSuccess(await supabase.from('live_google_trends_history_cache').select('*').in('cache_key', cacheKeys), 'select', 'live_google_trends_history_cache') ?? [] },
    async upsertLiveGoogleTrendsHistoryCache(rows) { requireSuccess(await supabase.from('live_google_trends_history_cache').upsert(rows, { onConflict: 'cache_key' }), 'upsert batch', 'live_google_trends_history_cache') },
  }
}
