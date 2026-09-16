import { pathToFileURL } from 'node:url'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { resolveHistoricalVaultConfig } from '../live/historicalVault.mjs'
import { readHistoricalVaultCoverage } from '../live/historicalVaultReadService.mjs'
import { readLiveLeaderboard } from '../live/liveLeaderboardReadService.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

function option(args, name) {
  const match = args.find((argument) => argument.startsWith(`${name}=`))
  return match ? match.slice(name.length + 1) : null
}

function countCurve(curve) {
  const points = Array.isArray(curve) ? curve : []
  const valid = points.filter((point) => point?.availability === 'available' && Number.isFinite(point.value))
  const missing = points.filter((point) => point?.availability === 'missing' || point?.value === null)
  // Canonical raw_curve retains normalized observations. The DataForSEO adapter
  // deliberately maps an exact numeric provider zero to a missing value with
  // this marker, rather than claiming that a zero is usable attention evidence.
  const providerZeroMappedToMissing = points.filter((point) => point?.missingReason === 'out-of-range').length
  return {
    providerCurvePointCount: points.length,
    providerValidPointCount: valid.length,
    providerMissingPointCount: missing.length,
    providerZeroPointCount: valid.filter((point) => point.value === 0).length,
    providerZeroMappedToMissingCount: providerZeroMappedToMissing,
  }
}

function mean(values) {
  const available = (values ?? []).filter(Number.isFinite)
  return available.length ? available.reduce((total, value) => total + value, 0) / available.length : null
}

function requiredWindow(window) {
  if (window !== '24H') throw new Error('Canonical Growth diagnostics are only available for 24H')
  return window
}

/** Pure formatter for the persisted 24H canonical-attention audit. */
export function build24hCanonicalGrowthDiagnostics({ result, artifacts, alignments, canonicalPoints, coverageByCandidate }) {
  requiredWindow(result?.snapshot?.selectedWindow)
  const artifactByCandidate = new Map((artifacts ?? []).map((artifact) => [artifact.candidate_id, artifact]))
  const alignmentByArtifact = new Map((alignments ?? []).map((alignment) => [alignment.source_artifact_id, alignment]))
  const pointsByCandidate = new Map()
  for (const point of canonicalPoints ?? []) {
    const rows = pointsByCandidate.get(point.candidate_id) ?? []
    rows.push(point)
    pointsByCandidate.set(point.candidate_id, rows)
  }

  return result.entries.map((entry) => {
    const artifact = artifactByCandidate.get(entry.candidateId) ?? null
    const alignment = artifact ? alignmentByArtifact.get(artifact.artifact_id) ?? null : null
    const coverage = coverageByCandidate.get(entry.candidateId) ?? null
    const currentSegment = coverage?.canonicalSegment ?? alignment?.segment_id ?? null
    const points = pointsByCandidate.get(entry.candidateId) ?? []
    const currentPoints = currentSegment === null
      ? []
      : points.filter((point) => point.segment_id === currentSegment)
    const presentation = entry.componentAvailability?.presentation ?? {}
    const growthDiagnostics = presentation.growthDiagnostics ?? {}
    const promotion = growthDiagnostics.promotion ?? presentation.vaultGrowth?.promotion ?? null
    return {
      candidate: entry.title,
      publicRank: entry.publicRank,
      providerHistoryRequested: artifact?.request_window ?? null,
      providerHistoryReturned: artifact !== null,
      ...(countCurve(artifact?.raw_curve)),
      canonicalArtifactId: artifact?.artifact_id ?? null,
      canonicalAlignmentAccepted: alignment?.accepted ?? null,
      canonicalAlignmentReason: alignment?.accepted ? alignment.reason ?? 'aligned' : alignment?.reason ?? null,
      canonicalSegmentId: currentSegment,
      canonicalNewPointCount: artifact ? points.filter((point) => point.source_artifact_id === artifact.artifact_id).length : 0,
      canonicalPointCountCurrentSegment: currentPoints.length,
      canonicalLatestPointAt: coverage?.latestPointAt ?? currentPoints.map((point) => point.observed_at).sort().at(-1) ?? null,
      canonicalFresh: Boolean(coverage?.latestPointAt) && coverage.reason !== 'stale-canonical-history',
      growthRecentSlots: coverage?.recent ? { actual: coverage.recent.actual, expected: coverage.recent.expected } : null,
      growthPreviousSlots: coverage?.previous ? { actual: coverage.previous.actual, expected: coverage.previous.expected } : null,
      growthRecentMean: coverage?.recent ? mean(coverage.recent.values) : null,
      growthPreviousMean: coverage?.previous ? mean(coverage.previous.values) : null,
      canonicalGrowthAvailable: coverage?.status === 'available',
      canonicalGrowthValue: coverage?.growthPercent ?? null,
      canonicalGrowthReason: coverage?.reason ?? null,
      promotionEligible: promotion?.eligible ?? false,
      promotionConfidence: promotion?.confidence ?? 'unavailable',
      promotionDecision: promotion?.promotionOutcome ?? 'not-recorded-in-snapshot',
      promotionRejectionReason: promotion?.reason ?? 'not-recorded-in-snapshot',
      publicGrowthValue: entry.growthPercent,
      publicGrowthSource: entry.growthSource,
      publicGrowthSaturated: entry.growthSaturated,
    }
  })
}

async function rows(query, label) {
  const { data, error } = await query
  if (error) throw new Error(`Canonical Growth diagnostic ${label} failed: ${error.message}`)
  return data ?? []
}

/** Read-only public-24H diagnostic. It creates no provider client and writes no table. */
export async function check24hCanonicalGrowth({ env = process.env, args = process.argv.slice(2), createClient = createServerSupabaseClient, createRepository = createSupabaseIngestionRepository, read = readLiveLeaderboard, readCoverage = readHistoricalVaultCoverage, write = console.log } = {}) {
  const unsupported = args.filter((argument) => !argument.startsWith('--cycle='))
  if (unsupported.length) throw new Error('Usage: npm run growth:24h-check [-- --cycle=<cycle-id>]')
  const cycleId = option(args, '--cycle')
  const client = createClient(env)
  const repository = createRepository(client)
  const result = await read({ repository, selectedWindow: '24H', ...(cycleId ? { cycleId } : {}) })
  const candidateIds = result.entries.map((entry) => entry.candidateId)
  const artifacts = await rows(client.from('live_provider_curve_artifacts').select('*')
    .eq('ingestion_run_id', result.snapshot.ingestionRunId).eq('request_window', 'past_day'), 'artifacts')
  const alignments = artifacts.length
    ? await rows(client.from('live_canonical_attention_alignments').select('*').in('source_artifact_id', artifacts.map((artifact) => artifact.artifact_id)), 'alignments')
    : []
  const canonicalPoints = candidateIds.length
    ? await rows(client.from('live_canonical_attention_points').select('*').in('candidate_id', candidateIds), 'points')
    : []
  const config = resolveHistoricalVaultConfig(env)
  const asOf = new Date(Math.floor(Date.parse(result.snapshot.scoredAt) / (config.slotMinutes * 60_000)) * config.slotMinutes * 60_000).toISOString()
  const coverageByCandidate = await readCoverage({ repository, candidateIds, window: '24H', asOf, slotMinutes: config.slotMinutes })
  const topics = build24hCanonicalGrowthDiagnostics({ result, artifacts, alignments, canonicalPoints, coverageByCandidate })
  const report = {
    readOnly: true,
    requestedWindow: '24H',
    cycleId: result.snapshot.cycleId,
    scoredAt: result.snapshot.scoredAt,
    canonicalAsOf: asOf,
    vaultConfig: { enabled: config.enabled, growthMode: config.growthMode, slotMinutes: config.slotMinutes },
    topics,
  }
  write(JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  check24hCanonicalGrowth().catch((error) => { console.error(`24H canonical Growth check failed: ${error.message}`); process.exitCode = 1 })
}
