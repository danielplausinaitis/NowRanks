import { pathToFileURL } from 'node:url'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'
import { buildActiveTrackingCohort, DEFAULT_TRACKING_RETENTION_HOURS } from '../live/activeTrackingCohort.mjs'
import { loadActiveTrackingState } from './ingestLive.mjs'

function option(name) { const value = process.argv.find((item) => item.startsWith(`${name}=`)); return value ? value.slice(name.length + 1) : null }

/** Read-only derived tracking view; it neither contacts providers nor records state. */
export async function checkActiveTracking({ candidateId = option('--candidate-id'), asOf = option('--as-of') ?? new Date().toISOString(), repository = createSupabaseIngestionRepository(createServerSupabaseClient()) } = {}) {
  const state = await loadActiveTrackingState({ repository, now: asOf })
  const cohort = buildActiveTrackingCohort({ latestPublic: state.latestPublic, tracking: state.tracking, maxPaidCandidates: 50, now: asOf })
  const chosen = new Set(cohort.candidates.map((candidate) => candidate.normalizedQuery))
  const selected = new Map(cohort.diagnostics.selected.map((item) => [item.query, item]))
  const excluded = new Map(cohort.diagnostics.exclusions.map((item) => [item.query, item]))
  const rows = state.tracking.filter((item) => !candidateId || item.candidateId === candidateId).map((item) => ({
    candidate: item.candidateId, query: item.query, latestPublicRank: state.latestPublic.find((entry) => entry.normalizedQuery === item.normalizedQuery)?.publicRank ?? null,
    lastPaidMeasurement: item.lastPaidAt, lastCanonicalSuccess: item.lastCanonicalSuccessAt, canonicalSegment: item.canonicalSegment,
    canonicalPointCount: item.canonicalPointCount, recentAcceptedAlignmentConfidence: item.recentAcceptedAlignmentConfidence ?? null,
    consecutiveMissingHistory: item.consecutiveMissingHistory, retentionExpiresAt: new Date(Date.parse(item.lastPaidAt) + DEFAULT_TRACKING_RETENTION_HOURS * 3_600_000).toISOString(),
    wouldTrack: chosen.has(item.normalizedQuery), selectionReason: selected.get(item.normalizedQuery)?.reason ?? null,
    exclusionReason: excluded.get(item.normalizedQuery)?.reason ?? null,
  }))
  console.log(JSON.stringify({ readOnly: true, asOf, cohort: cohort.diagnostics, candidates: rows }, null, 2))
  return rows
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) checkActiveTracking().catch((error) => { console.error(`Tracking check failed: ${error.message}`); process.exitCode = 1 })
