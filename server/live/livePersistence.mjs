import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { DEFAULT_INGESTION_STALE_AFTER_MINUTES, DEFAULT_OBSERVATION_UPSERT_BATCH_SIZE, stableUuid } from '../ingestion/persistence.mjs'
import { buildDiscoveryVaultMeasurements, resolveHistoricalVaultConfig, utcSchedulerSlot } from './historicalVault.mjs'
import { buildCanonicalAttentionPersistencePlan } from './canonicalAttentionPersistence.mjs'
import { serializeUnifiedScoreDiagnostic } from './unifiedScoreDiagnostics.mjs'
import { CROSS_QUERY_COMPARABILITY_STATUSES, isCrossQueryComparabilityStatus } from './provenanceComparability.mjs'

export const ALLOW_LIVE_DATABASE_WRITE_ENV = 'ALLOW_LIVE_DATABASE_WRITE'
export const LIVE_INGEST_DRY_RUN_ENV = 'LIVE_INGEST_DRY_RUN'
export const LIVE_INGEST_CANDIDATE_LIMIT_ENV = 'LIVE_INGEST_CANDIDATE_LIMIT'
export const LIVE_DISPLAY_LIMIT_ENV = 'LIVE_DISPLAY_LIMIT'
export const LIVE_DISCOVERY_LIMIT_ENV = 'LIVE_DISCOVERY_LIMIT'
export const LIVE_INITIAL_PAID_CANDIDATES_ENV = 'LIVE_INITIAL_PAID_CANDIDATES'
export const LIVE_MAX_PAID_CANDIDATES_ENV = 'LIVE_MAX_PAID_CANDIDATES'
export const LIVE_7D_ADAPTIVE_MAX_CANDIDATES_ENV = 'LIVE_7D_ADAPTIVE_MAX_CANDIDATES'
export const LIVE_INGEST_CYCLE_ID_ENV = 'LIVE_INGEST_CYCLE_ID'
export const LIVE_INGEST_RECOVER_STALE_ENV = 'LIVE_INGEST_RECOVER_STALE'
export const DEFAULT_LIVE_INGEST_CANDIDATE_LIMIT = 10
export const LIVE_INGEST_CANDIDATE_LIMIT_RANGE = Object.freeze({ minimum: 2, maximum: 100 })
export const DEFAULT_LIVE_DISPLAY_LIMIT = 20
// SerpApi returns the complete Trending Now set for one request. Retain a
// broader in-memory universe before selecting the unchanged 50 paid topics.
export const DEFAULT_LIVE_DISCOVERY_LIMIT = 100
export const DEFAULT_LIVE_INITIAL_PAID_CANDIDATES = 15
export const DEFAULT_LIVE_MAX_PAID_CANDIDATES = 50
export const LIVE_MAX_PAID_CANDIDATES_HARD_LIMIT = 50
export const DEFAULT_LIVE_7D_ADAPTIVE_MAX_CANDIDATES = 70
export const LIVE_7D_ADAPTIVE_MAX_CANDIDATES_HARD_LIMIT = 70
// Kept as a compatibility export; the shared contract is also enforced by the
// source_provenance database CHECK constraint.
export const LIVE_PROVENANCE_COMPARABILITY_STATUSES = CROSS_QUERY_COMPARABILITY_STATUSES

function booleanValue(value, name, defaultValue) {
  if (value === undefined || value === '') return defaultValue
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function defaultCycleId(now) {
  const date = new Date(now)
  if (Number.isNaN(date.valueOf())) throw new Error('Live ingestion cycle time must be valid')
  date.setUTCMinutes(0, 0, 0)
  return date.toISOString().replace(':00.000Z', 'Z')
}

function boundedInteger(value, name, fallback, range = LIVE_INGEST_CANDIDATE_LIMIT_RANGE) {
  const number = Number(value === undefined || value === '' ? fallback : value)
  if (!Number.isInteger(number) || number < range.minimum || number > range.maximum) throw new Error(`${name} must be an integer between ${range.minimum} and ${range.maximum}`)
  return number
}

export function resolveLiveIngestionSafetyConfig(env = process.env, now = () => new Date().toISOString()) {
  const legacyLimit = env[LIVE_INGEST_CANDIDATE_LIMIT_ENV]
  // The legacy standalone limit remains a fixed-cohort compatibility switch.
  const displayLimit = boundedInteger(env[LIVE_DISPLAY_LIMIT_ENV], LIVE_DISPLAY_LIMIT_ENV, DEFAULT_LIVE_DISPLAY_LIMIT)
  const discoveryLimit = boundedInteger(env[LIVE_DISCOVERY_LIMIT_ENV], LIVE_DISCOVERY_LIMIT_ENV, legacyLimit === undefined || legacyLimit === '' ? DEFAULT_LIVE_DISCOVERY_LIMIT : legacyLimit)
  const initialPaidCandidates = boundedInteger(env[LIVE_INITIAL_PAID_CANDIDATES_ENV], LIVE_INITIAL_PAID_CANDIDATES_ENV, legacyLimit === undefined || legacyLimit === '' ? DEFAULT_LIVE_INITIAL_PAID_CANDIDATES : legacyLimit)
  const maxPaidCandidates = boundedInteger(env[LIVE_MAX_PAID_CANDIDATES_ENV], LIVE_MAX_PAID_CANDIDATES_ENV, legacyLimit === undefined || legacyLimit === '' ? DEFAULT_LIVE_MAX_PAID_CANDIDATES : legacyLimit, { minimum: 2, maximum: LIVE_MAX_PAID_CANDIDATES_HARD_LIMIT })
  const adaptiveFallback = legacyLimit === undefined || legacyLimit === '' ? DEFAULT_LIVE_7D_ADAPTIVE_MAX_CANDIDATES : maxPaidCandidates
  const adaptive7dMaxCandidates = boundedInteger(env[LIVE_7D_ADAPTIVE_MAX_CANDIDATES_ENV], LIVE_7D_ADAPTIVE_MAX_CANDIDATES_ENV, adaptiveFallback, { minimum: maxPaidCandidates, maximum: LIVE_7D_ADAPTIVE_MAX_CANDIDATES_HARD_LIMIT })
  if (initialPaidCandidates > maxPaidCandidates) throw new Error(`${LIVE_INITIAL_PAID_CANDIDATES_ENV} must not exceed ${LIVE_MAX_PAID_CANDIDATES_ENV}`)
  if (maxPaidCandidates > discoveryLimit) throw new Error(`${LIVE_MAX_PAID_CANDIDATES_ENV} must not exceed ${LIVE_DISCOVERY_LIMIT_ENV}`)
  const cycleId = env[LIVE_INGEST_CYCLE_ID_ENV]?.trim() || defaultCycleId(now())
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(cycleId)) throw new Error(`${LIVE_INGEST_CYCLE_ID_ENV} contains unsupported characters`)
  return {
    dryRun: booleanValue(env[LIVE_INGEST_DRY_RUN_ENV], LIVE_INGEST_DRY_RUN_ENV, true),
    // Retained for callers which still expect the old field; it now means maximum paid cohort.
    candidateLimit: maxPaidCandidates,
    displayLimit,
    discoveryLimit,
    initialPaidCandidates,
    maxPaidCandidates,
    adaptive7dMaxCandidates,
    cycleId,
    recoverStaleRun: booleanValue(env[LIVE_INGEST_RECOVER_STALE_ENV], LIVE_INGEST_RECOVER_STALE_ENV, false),
  }
}

export function assertLiveDatabaseWriteAllowed(env = process.env) {
  if (env[ALLOW_LIVE_DATABASE_WRITE_ENV] !== 'true') {
    throw new Error(`${ALLOW_LIVE_DATABASE_WRITE_ENV}=true is required before live external data can be written to the database`)
  }
}

function safePayload(value) {
  return JSON.parse(JSON.stringify(value, (key, field) => /authorization|api.?key|password|secret|credential/i.test(key) ? undefined : field))
}

function candidateKey(normalizedQuery) {
  return `live:${normalizedQuery}`
}

function requiredLiveEvidenceProviderId(providerId, { kind, candidateId }) {
  if (typeof providerId !== 'string' || !providerId.trim()) {
    throw new Error(`Live ${kind} evidence for ${candidateId ?? 'an unknown candidate'} requires a non-empty provider ID`)
  }
  return providerId.trim()
}

function requiredLiveProvenanceComparabilityStatus(status, { providerId, normalizedQuery }) {
  if (!isCrossQueryComparabilityStatus(status)) {
    throw new Error(`Live source provenance for ${providerId ?? 'an unknown provider'}/${normalizedQuery ?? 'an unknown query'} has unsupported cross-query comparability status ${JSON.stringify(status)}; expected one of ${LIVE_PROVENANCE_COMPARABILITY_STATUSES.join(', ')}`)
  }
  return status
}

export function liveIngestionIdentity({ cycleId, historyWindow }) {
  return { runId: stableUuid(`live-ingestion-run:${cycleId}:${historyWindow}:v2`), idempotencyKey: `live:serpapi-dataforseo:${cycleId}:${historyWindow}:v2` }
}

function evidenceRow({ runId, candidateId, providerId, kind, observedAt, retrievedAt, geographicScope, availability, payload }) {
  const resolvedProviderId = requiredLiveEvidenceProviderId(providerId, { kind, candidateId })
  return {
    evidence_id: stableUuid(`live-evidence:${runId}:${candidateId}:${resolvedProviderId}:${kind}`),
    ingestion_run_id: runId,
    candidate_id: candidateId,
    provider_id: resolvedProviderId,
    data_mode: 'live',
    evidence_kind: kind,
    observed_at: observedAt,
    retrieved_at: retrievedAt,
    geographic_scope: geographicScope,
    availability,
    evidence_payload: safePayload(payload),
  }
}

function rankScores(scores, scoreKey, limit = Infinity) {
  return scores
    .filter((entry) => Number.isFinite(entry[scoreKey]))
    .sort((left, right) => right[scoreKey] - left[scoreKey] || left.topic.localeCompare(right.topic))
    .slice(0, limit)
    .map((entry, index) => ({ entry, rank: index + 1 }))
}

function componentAvailability(entry) {
  const presentation = {
    growthPercent: entry.presentation?.growthPercent ?? null,
    growthSource: entry.presentation?.growthSource ?? 'unavailable',
    growthSaturated: entry.presentation?.growthSaturated === true,
    vaultGrowth: entry.presentation?.vaultGrowth ?? null,
    trendHeat: entry.presentation?.trendHeat ?? null,
  }
  if (entry.presentation?.growthDiagnostics) presentation.growthDiagnostics = entry.presentation.growthDiagnostics
  if (entry.presentation?.heatDiagnostics) presentation.heatDiagnostics = entry.presentation.heatDiagnostics
  return {
    ...Object.fromEntries(Object.entries(entry.components).map(([component, value]) => [component, {
    available: value !== null,
    value,
    reason: entry.componentDiagnostics?.[component]?.reason ?? null,
    }])),
    presentation,
  }
}

export function buildLivePersistencePlan({ cycleId, historyWindow, scoredAt, candidates, discoveryCandidates = candidates, paidTrackingDiagnostics = null, volumes, histories, scores, displayLimit = DEFAULT_LIVE_DISPLAY_LIMIT, vaultConfig = resolveHistoricalVaultConfig(), vaultDiscoveryRequest = {}, canonicalExistingByQuery = new Map(), canonicalTargeting = {} }) {
  if (!cycleId || !historyWindow || Number.isNaN(Date.parse(scoredAt))) throw new Error('Live persistence plan requires cycle, window, and scored timestamp')
  if (![candidates, discoveryCandidates, volumes, histories, scores].every(Array.isArray)) throw new Error('Live persistence plan inputs must be arrays')
  const { runId, idempotencyKey } = liveIngestionIdentity({ cycleId, historyWindow })
  const candidatesByQuery = new Map()
  for (const candidate of discoveryCandidates) if (candidate?.normalizedQuery) candidatesByQuery.set(candidate.normalizedQuery, candidate)
  for (const candidate of candidates) if (candidate?.normalizedQuery) candidatesByQuery.set(candidate.normalizedQuery, candidate)
  const persistedCandidates = [...candidatesByQuery.values()]
  const candidateRows = persistedCandidates.map((candidate) => ({
    candidate_id: candidateKey(candidate.normalizedQuery),
    query_text: candidate.query,
    normalized_query: candidate.normalizedQuery,
    // Unclassified records are diagnostic-only: they are never eligible for
    // paid selection or public output, but retaining them avoids hiding the
    // provider's unclassified share from category-breadth audits.
    category: candidate.category ?? 'Unclassified',
  }))
  const candidateIdByQuery = new Map(candidateRows.map((row) => [row.normalized_query, row.candidate_id]))
  const volumeByQuery = new Map(volumes.map((record) => [record.normalizedQuery, record]))
  const historyByQuery = new Map(histories.map((record) => [record.normalizedQuery, record]))
  // Rank once for diagnostics as well as the public slice. This uses the
  // existing exact public order and has no effect on the selected Top 20.
  const allUnified = rankScores(scores, 'unifiedRawScore')
  const unifiedRankByQuery = new Map(allUnified.map(({ entry, rank }) => [entry.normalizedQuery, rank]))
  const scoreByQuery = new Map(scores.map((entry) => [entry.normalizedQuery, entry]))
  const evidence = []
  const provenances = []
  const observations = []
  const discoveryEvidenceIdByQuery = new Map()
  const selectedPaidByQuery = new Map(candidates.map((candidate) => [candidate.normalizedQuery, candidate]))
  const paidTrackingByQuery = new Map((paidTrackingDiagnostics?.selected ?? []).map((candidate) => [candidate.query, candidate]))

  // Keep the full current discovery universe as evidence, even when only a
  // bounded subset receives paid baseline and Trends measurement. This makes
  // later category-breadth diagnostics evidence-based rather than inferred.
  for (const candidate of discoveryCandidates) {
    const candidateId = candidateIdByQuery.get(candidate.normalizedQuery)
    if (!candidate.trackingOnly) {
      const paidCandidate = selectedPaidByQuery.get(candidate.normalizedQuery)
      const paidTracking = paidTrackingByQuery.get(candidate.normalizedQuery)
      const discoveryEvidence = evidenceRow({
        runId, candidateId, providerId: candidate.providerId, kind: 'discovery',
        observedAt: candidate.startedAt ?? candidate.retrievedAt, retrievedAt: candidate.retrievedAt,
        geographicScope: candidate.geographicScope, availability: 'available', payload: {
          ...candidate,
          discoveryPoolPosition: paidCandidate?.discoveryPoolPosition ?? null,
          discoverySelectionReason: paidCandidate?.discoverySelectionReason ?? 'paid-discovery-capacity',
          paidTrackingSelected: Boolean(paidCandidate),
          paidTrackingSelectionReason: paidTracking?.reason ?? (paidCandidate ? 'paid-tracking-selection-diagnostics-unavailable' : 'not-selected-for-paid-tracking'),
        },
      })
      evidence.push(discoveryEvidence)
      discoveryEvidenceIdByQuery.set(candidate.normalizedQuery, discoveryEvidence.evidence_id)
    }
  }
  for (const candidate of candidates) {
    const candidateId = candidateIdByQuery.get(candidate.normalizedQuery)
    const volume = volumeByQuery.get(candidate.normalizedQuery)
    if (volume) evidence.push(evidenceRow({
      runId, candidateId, providerId: volume.providerId, kind: 'baseline-demand',
      observedAt: volume.retrievedAt, retrievedAt: volume.retrievedAt, geographicScope: volume.geographicScope,
      availability: volume.availability, payload: volume,
    }))
    const history = historyByQuery.get(candidate.normalizedQuery)
    if (!history) continue
    const crossQueryComparabilityStatus = requiredLiveProvenanceComparabilityStatus(history.provenance?.crossQueryComparability?.status, {
      providerId: history.provenance?.providerId,
      normalizedQuery: candidate.normalizedQuery,
    })
    const provenanceId = stableUuid(`live-history-provenance:${runId}:${history.provenance.providerId}:${candidate.normalizedQuery}`)
    provenances.push({
      provenance_id: provenanceId,
      ingestion_run_id: runId,
      provider_id: history.provenance.providerId,
      data_mode: 'live',
      source_observed_at: history.provenance.sourceObservedAt,
      ingested_at: history.provenance.ingestedAt,
      source_version: history.provenance.sourceVersion ?? null,
      collection_method: history.provenance.collectionMethod ?? null,
      geographic_scope: history.provenance.geographicScope,
      cross_query_comparability_status: crossQueryComparabilityStatus,
      cross_query_comparability_basis: history.provenance.crossQueryComparability.basis ?? null,
      normalized_query: candidate.normalizedQuery,
    })
    evidence.push(evidenceRow({
      runId, candidateId, providerId: history.provenance.providerId, kind: 'history-metadata',
      observedAt: history.provenance.sourceObservedAt, retrievedAt: history.retrievedAt,
      geographicScope: history.provenance.geographicScope, availability: 'metadata',
      payload: {
        historyRequest: history.historyRequest,
        measurementProvenance: history.measurementProvenance ?? null,
        observationCount: history.observations.length,
        providerId: history.provenance.providerId,
        // Existing metadata evidence has one row per measured candidate, so it
        // safely holds the diagnostic for public and non-public scores without
        // a new evidence kind or schema change.
        unifiedScoreDiagnostic: scoreByQuery.has(candidate.normalizedQuery)
          ? serializeUnifiedScoreDiagnostic({ entry: scoreByQuery.get(candidate.normalizedQuery), window: historyWindow, wouldBeRank: unifiedRankByQuery.get(candidate.normalizedQuery) ?? null, publicDisplayLimit: displayLimit })
          : null,
      },
    }))
    for (const observation of history.observations) {
      observations.push({
        observation_id: stableUuid(`live-observation:${candidateId}:${history.provenance.providerId}:${observation.observedAt}`),
        candidate_id: candidateId,
        provenance_id: provenanceId,
        observation_date: observation.date,
        observed_at: observation.observedAt,
        availability: observation.availability,
        interest_value: observation.availability === 'available' ? observation.interest : null,
        missing_reason: observation.availability === 'missing' ? observation.missingReason : null,
        ingested_at: history.provenance.ingestedAt,
      })
    }
  }

  const vaultMeasurements = vaultConfig.enabled
    ? buildDiscoveryVaultMeasurements({
      candidates: candidates.filter((candidate) => !candidate.trackingOnly), candidateIdByQuery, discoveryRequest: vaultDiscoveryRequest, ingestionRunId: runId,
      sourceEvidenceIdByQuery: discoveryEvidenceIdByQuery, slotAt: utcSchedulerSlot(scoredAt, vaultConfig.slotMinutes), retrievedAt: scoredAt,
    })
    : []
  // Canonical attention is deliberately limited to DataForSEO's high-resolution past_day curve.
  // The other requested history windows stay on the established provider-history path.
  const canonicalAttention = vaultConfig.enabled && vaultConfig.growthMode !== 'off' && historyWindow === '24H'
    ? buildCanonicalAttentionPersistencePlan({ histories, candidateIdByQuery, existingByQuery: canonicalExistingByQuery, runId, scoredAt, slotMinutes: vaultConfig.slotMinutes, canonicalTargeting })
    : { artifacts: [], alignments: [], points: [], diagnostics: { eligibleCandidates: 0, bootstrapped: 0, aligned: 0, rejected: 0, rejectionReasons: {}, rawArtifacts: 0, newPoints: 0, failures: 0 } }

  if (!Number.isInteger(displayLimit) || displayLimit < 1) throw new Error('Live persistence displayLimit must be a positive integer')
  const publication = {
    publishable: allUnified.length >= displayLimit,
    requiredCount: displayLimit,
    availableCount: allUnified.length,
    historyWindow,
    cycleId,
    reason: allUnified.length >= displayLimit ? null : 'insufficient-public-candidates',
  }
  const snapshotId = stableUuid(`live-snapshot:v2:${cycleId}:${historyWindow}`)
  const unified = allUnified.slice(0, displayLimit)
  const snapshotEntries = publication.publishable ? unified.map(({ entry, rank }) => ({
      snapshot_entry_id: stableUuid(`live-snapshot-entry:${snapshotId}:${entry.normalizedQuery}:unified`),
      snapshot_id: snapshotId,
      candidate_id: candidateIdByQuery.get(entry.normalizedQuery),
      score_lane: 'unified',
      classification: entry.evidenceStatus === 'established' ? (entry.topicClassification === 'partial-history' ? 'partial-history' : 'established') : 'possible-new-trend',
      confidence: entry.unifiedConfidence ?? (entry.evidenceStatus === 'established' ? entry.confidence : 'emerging'),
      confidence_reason: entry.unifiedConfidenceReason ?? entry.confidenceReason,
      score_basis: 'unified-public',
      overall_score: null,
      established_trending_score: null,
      emerging_trending_score: null,
      lane_rank: null,
      public_rank: rank,
      public_score: entry.nowScore,
      evidence_status: entry.evidenceStatus,
      history_observation_count: entry.history.observationCount,
      history_available_count: entry.history.availableCount,
      history_coverage_percentage: entry.history.coveragePercentage,
      search_interest_component: entry.components.searchInterest,
      component_availability: componentAvailability(entry),
  })) : []

  return {
    cycleId, historyWindow, scoredAt, runId, idempotencyKey,
    run: { run_id: runId, provider_id: 'serpapi-dataforseo-live', data_mode: 'live', status: 'running', idempotency_key: idempotencyKey },
    candidates: candidateRows,
    evidence,
    provenances,
    observations,
    vaultMeasurements,
    canonicalAttention,
    publication,
    // A rejected public board has no snapshot object at all, so persistence
    // cannot accidentally make a partial v2 header visible to public reads.
    snapshot: publication.publishable ? { snapshot_id: snapshotId, ingestion_run_id: runId, cycle_id: cycleId, data_mode: 'live', selected_window: historyWindow, scored_at: scoredAt, snapshot_format_version: 2 } : null,
    snapshotEntries,
    counts: {
      candidates: candidateRows.length,
      evidence: evidence.length,
      provenances: provenances.length,
      observations: observations.length,
      vaultMeasurements: vaultMeasurements.length,
      canonicalArtifacts: canonicalAttention.artifacts.length,
      canonicalAlignments: canonicalAttention.alignments.length,
      canonicalPoints: canonicalAttention.points.length,
      canonicalAttention: canonicalAttention.diagnostics,
      snapshots: publication.publishable ? 1 : 0,
      snapshotEntries: snapshotEntries.length,
      unified: allUnified.length,
      insufficient: scores.length - allUnified.length,
    },
  }
}

export function summarizeLiveDryRun(plan, requestMetrics = {}) {
  return {
    dryRun: true,
    dataMode: 'live',
    cycleId: plan.cycleId,
    idempotencyKey: plan.idempotencyKey,
    historyWindow: plan.historyWindow,
    ...plan.counts,
    providerRequests: requestMetrics.providerRequests ?? {},
    providerCosts: requestMetrics.providerCosts ?? {},
    trendsProvider: requestMetrics.trendsProvider ?? 'dataforseo-trends',
    baselineCache: requestMetrics.baselineCache ?? null,
    graphMeasurements: requestMetrics.graphMeasurements ?? null,
    publication: plan.publication,
    evaluation: requestMetrics.evaluation ?? null,
    publicFunnel: requestMetrics.publicFunnel ?? null,
    vault: requestMetrics.vault ?? null,
    tracking: requestMetrics.tracking ?? null,
  }
}

export async function executeLivePersistence({ dryRun, plan, requestMetrics, repository, ...persistenceOptions }) {
  if (dryRun) return summarizeLiveDryRun(plan, requestMetrics)
  return persistLivePlan({ plan, repository, ...persistenceOptions })
}

/**
 * Defense in depth for plans assembled outside this module: reject malformed
 * live evidence before a repository method can issue a Supabase write.
 */
export function assertLiveEvidenceProviderIds(evidence) {
  if (!Array.isArray(evidence)) throw new Error('Live provider evidence preflight requires an evidence array')
  evidence.forEach((row, index) => {
    requiredLiveEvidenceProviderId(row?.provider_id, {
      kind: row?.evidence_kind ?? `row ${index}`,
      candidateId: row?.candidate_id ?? null,
    })
  })
}

/**
 * Defense in depth for externally assembled plans: fail locally before any
 * repository call can send an invalid provenance CHECK value to Supabase.
 */
export function assertLiveProvenanceComparabilityStatuses(provenances) {
  if (!Array.isArray(provenances)) throw new Error('Live provenance preflight requires a provenances array')
  provenances.forEach((row, index) => {
    requiredLiveProvenanceComparabilityStatus(row?.cross_query_comparability_status, {
      providerId: row?.provider_id,
      normalizedQuery: row?.normalized_query ?? `row ${index}`,
    })
  })
}

function isStale(run, now, staleAfterMinutes) {
  const startedAt = Date.parse(run.started_at)
  return Number.isFinite(startedAt) && Date.parse(now) - startedAt >= staleAfterMinutes * 60_000
}

export async function persistLivePlan({
  plan,
  repository,
  env = process.env,
  now = () => new Date().toISOString(),
  staleAfterMinutes = DEFAULT_INGESTION_STALE_AFTER_MINUTES,
  recoverStaleRun = false,
  observationBatchSize = DEFAULT_OBSERVATION_UPSERT_BATCH_SIZE,
  onProgress,
}) {
  assertLiveDatabaseWriteAllowed(env)
  if (!repository) throw new Error('A live ingestion repository is required')
  assertLiveEvidenceProviderIds(plan?.evidence)
  assertLiveProvenanceComparabilityStatuses(plan?.provenances)
  const existing = await repository.findRunByIdempotencyKey(plan.idempotencyKey)
  if (existing?.status === 'succeeded') return { status: 'already-completed', runId: existing.run_id, ...plan.counts }
  if (existing?.status === 'running') {
    if (!isStale(existing, now(), staleAfterMinutes)) throw new Error(`Live ingestion ${plan.idempotencyKey} is already running and is not stale`)
    if (!recoverStaleRun) throw new Error(`Live ingestion ${plan.idempotencyKey} is stale; set ${LIVE_INGEST_RECOVER_STALE_ENV}=true for explicit recovery`)
  }
  const startedAt = now()
  let claimed = false
  let accepted = 0
  try {
    if (existing) await repository.updateRun(plan.runId, { status: 'running', started_at: startedAt, finished_at: null, records_received: 0, records_accepted: 0, records_rejected: 0, error_summary: null })
    else await repository.createRun({ ...plan.run, started_at: startedAt, records_received: 0, records_accepted: 0, records_rejected: 0 })
    claimed = true
    onProgress?.('ingestion run claimed')
    const resolvedIds = new Map()
    onProgress?.('candidate persistence')
    for (const candidate of plan.candidates) resolvedIds.set(candidate.normalized_query, await repository.upsertCandidate(candidate))
    const resolveCandidate = (row) => ({ ...row, candidate_id: resolvedIds.get(plan.candidates.find((candidate) => candidate.candidate_id === row.candidate_id)?.normalized_query) ?? row.candidate_id })
    onProgress?.('provider evidence')
    await repository.upsertLiveEvidence(plan.evidence.map(resolveCandidate))
    onProgress?.('provenance')
    await repository.upsertLiveProvenance(plan.provenances.map(({ normalized_query, ...row }) => row))
    onProgress?.('observations')
    for (let index = 0; index < plan.observations.length; index += observationBatchSize) {
      const batch = plan.observations.slice(index, index + observationBatchSize).map(resolveCandidate)
      await repository.upsertLiveObservations(batch)
      accepted += batch.length
      onProgress?.({ stage: 'observations', completed: accepted, total: plan.observations.length })
    }
    if (plan.vaultMeasurements.length) {
      onProgress?.('historical vault')
      await repository.upsertLiveHistoricalVaultMeasurements(plan.vaultMeasurements.map(resolveCandidate))
    }
    if (plan.canonicalAttention.artifacts.length) {
      onProgress?.('canonical attention artifacts')
      await repository.upsertLiveProviderCurveArtifacts(plan.canonicalAttention.artifacts.map(resolveCandidate))
      onProgress?.('canonical attention alignments')
      await repository.upsertLiveCanonicalAttentionAlignments(plan.canonicalAttention.alignments.map(resolveCandidate))
      onProgress?.('canonical attention points')
      await repository.upsertLiveCanonicalAttentionPoints(plan.canonicalAttention.points.map(resolveCandidate))
    }
    if (plan.publication?.publishable === false) {
      const finishedAt = now()
      const total = plan.counts.evidence + plan.counts.observations + plan.counts.vaultMeasurements + plan.counts.canonicalArtifacts + plan.counts.canonicalAlignments + plan.counts.canonicalPoints
      const publication = plan.publication
      const errorSummary = `${publication.reason}: required=${publication.requiredCount}; available=${publication.availableCount}; horizon=${publication.historyWindow}; cycle=${publication.cycleId}`
      onProgress?.('public snapshot rejected: insufficient public candidates')
      await repository.updateRun(plan.runId, {
        status: 'partial', finished_at: finishedAt,
        records_received: total, records_accepted: total, records_rejected: 0,
        error_summary: errorSummary,
      })
      return { status: 'partial', runId: plan.runId, publication, ...plan.counts }
    }
    onProgress?.('snapshots')
    await repository.upsertLiveSnapshot(plan.snapshot)
    await repository.upsertLiveSnapshotEntries(plan.snapshotEntries.map(resolveCandidate))
    const finishedAt = now()
    const total = plan.counts.evidence + plan.counts.observations + plan.counts.vaultMeasurements + plan.counts.canonicalArtifacts + plan.counts.canonicalAlignments + plan.counts.canonicalPoints + plan.counts.snapshotEntries
    await repository.updateRun(plan.runId, { status: 'succeeded', finished_at: finishedAt, records_received: total, records_accepted: total, records_rejected: 0, error_summary: null })
    onProgress?.('completion')
    return { status: 'succeeded', runId: plan.runId, ...plan.counts }
  } catch (error) {
    if (claimed) {
      try {
        await repository.updateRun(plan.runId, { status: 'failed', finished_at: now(), records_received: plan.counts.observations, records_accepted: accepted, records_rejected: Math.max(0, plan.counts.observations - accepted), error_summary: formatErrorDiagnostics(error).slice(0, 1000) })
      } catch {
        // Preserve the original error when best-effort run recovery also fails.
      }
    }
    throw new Error(`Live ingestion failed: ${formatErrorDiagnostics(error)}`)
  }
}
