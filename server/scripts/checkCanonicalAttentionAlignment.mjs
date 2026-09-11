import { pathToFileURL } from 'node:url'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

function option(name) {
  const value = process.argv.find((item) => item.startsWith(`${name}=`))
  return value ? value.slice(name.length + 1) : null
}

/** Read-only operator report. It never creates a provider client or writes a table. */
export async function checkCanonicalAttentionAlignment({ candidateId = option('--candidate-id'), repository = createSupabaseIngestionRepository(createServerSupabaseClient()), limit = Number(option('--limit') ?? 25) } = {}) {
  if (!candidateId) throw new Error('Usage: npm run vault:alignment-check -- --candidate-id=<candidate-id> [--limit=25]')
  if (!repository.listLiveCanonicalAttentionAlignments) throw new Error('A canonical-attention repository is required')
  const rows = await repository.listLiveCanonicalAttentionAlignments({ candidateId, limit })
  const events = rows.map((row) => {
    const artifact = row.live_provider_curve_artifacts ?? {}
    return {
      slot: artifact.slot_at ?? null,
      cycle: artifact.ingestion_runs?.idempotency_key ?? null,
      providerArtifact: row.source_artifact_id,
      provider: artifact.provider_id ?? null,
      providerQuery: artifact.provider_query ?? null,
      status: row.accepted ? (row.reason === 'bootstrap' ? 'bootstrap' : 'aligned') : 'rejected',
      totalTimestampOverlap: row.total_timestamp_overlap ?? null,
      availableOverlap: row.available_overlap_count ?? null,
      strongUsableOverlap: row.strong_usable_overlap_count ?? row.usable_overlap_count,
      weakOverlapRejected: row.weak_overlap_rejected ?? null,
      zeroOverlapRejected: row.zero_overlap_rejected ?? null,
      missingOverlapRejected: row.missing_overlap_rejected ?? null,
      outlierOverlapRejected: row.outlier_overlap_rejected ?? null,
      gapSinceLastCanonicalPoint: row.gap_since_last_canonical_point_ms ?? null,
      canResumeExistingSegment: row.can_resume_existing_segment ?? null,
      resumeReason: row.resume_reason ?? null,
      newSegmentRequired: row.new_segment_required ?? null,
      rejectedOverlaps: row.rejected_overlap_count,
      medianRatio: row.scale_factor,
      relativeMad: row.dispersion,
      confidence: row.confidence,
      segment: row.segment_id,
      newCanonicalPoints: Array.isArray(artifact.live_canonical_attention_points) ? artifact.live_canonical_attention_points.length : null,
      rejectionReason: row.accepted ? null : row.reason,
    }
  })
  console.log(JSON.stringify({ readOnly: true, candidateId, events }, null, 2))
  return events
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkCanonicalAttentionAlignment().catch((error) => { console.error(`Canonical alignment check failed: ${error.message}`); process.exitCode = 1 })
}
