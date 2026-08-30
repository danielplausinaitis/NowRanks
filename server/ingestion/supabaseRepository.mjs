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
  }
}
