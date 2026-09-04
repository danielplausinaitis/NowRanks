import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { DEFAULT_INGESTION_STALE_AFTER_MINUTES, DEFAULT_OBSERVATION_UPSERT_BATCH_SIZE, stableUuid } from '../ingestion/persistence.mjs'

export const ALLOW_LIVE_DATABASE_WRITE_ENV = 'ALLOW_LIVE_DATABASE_WRITE'
export const LIVE_INGEST_DRY_RUN_ENV = 'LIVE_INGEST_DRY_RUN'
export const LIVE_INGEST_CANDIDATE_LIMIT_ENV = 'LIVE_INGEST_CANDIDATE_LIMIT'
export const LIVE_INGEST_CYCLE_ID_ENV = 'LIVE_INGEST_CYCLE_ID'
export const LIVE_INGEST_RECOVER_STALE_ENV = 'LIVE_INGEST_RECOVER_STALE'
export const DEFAULT_LIVE_INGEST_CANDIDATE_LIMIT = 10
export const LIVE_INGEST_CANDIDATE_LIMIT_RANGE = Object.freeze({ minimum: 2, maximum: 20 })

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

export function resolveLiveIngestionSafetyConfig(env = process.env, now = () => new Date().toISOString()) {
  const limitValue = env[LIVE_INGEST_CANDIDATE_LIMIT_ENV]
  const candidateLimit = limitValue === undefined || limitValue === '' ? DEFAULT_LIVE_INGEST_CANDIDATE_LIMIT : Number(limitValue)
  if (!Number.isInteger(candidateLimit)
    || candidateLimit < LIVE_INGEST_CANDIDATE_LIMIT_RANGE.minimum
    || candidateLimit > LIVE_INGEST_CANDIDATE_LIMIT_RANGE.maximum) {
    throw new Error(`${LIVE_INGEST_CANDIDATE_LIMIT_ENV} must be an integer between 2 and 20`)
  }
  const cycleId = env[LIVE_INGEST_CYCLE_ID_ENV]?.trim() || defaultCycleId(now())
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(cycleId)) throw new Error(`${LIVE_INGEST_CYCLE_ID_ENV} contains unsupported characters`)
  return {
    dryRun: booleanValue(env[LIVE_INGEST_DRY_RUN_ENV], LIVE_INGEST_DRY_RUN_ENV, true),
    candidateLimit,
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

export function liveIngestionIdentity({ cycleId, historyWindow }) {
  return { runId: stableUuid(`live-ingestion-run:${cycleId}:${historyWindow}:v1`), idempotencyKey: `live:serpapi-dataforseo:${cycleId}:${historyWindow}:v1` }
}

function evidenceRow({ runId, candidateId, providerId, kind, observedAt, retrievedAt, geographicScope, availability, payload }) {
  return {
    evidence_id: stableUuid(`live-evidence:${runId}:${candidateId}:${providerId}:${kind}`),
    ingestion_run_id: runId,
    candidate_id: candidateId,
    provider_id: providerId,
    data_mode: 'live',
    evidence_kind: kind,
    observed_at: observedAt,
    retrieved_at: retrievedAt,
    geographic_scope: geographicScope,
    availability,
    evidence_payload: safePayload(payload),
  }
}

function rankScores(scores, scoreKey) {
  return scores
    .filter((entry) => Number.isFinite(entry[scoreKey]))
    .sort((left, right) => right[scoreKey] - left[scoreKey] || left.topic.localeCompare(right.topic))
    .map((entry, index) => ({ entry, rank: index + 1 }))
}

function componentAvailability(entry) {
  return Object.fromEntries(Object.entries(entry.components).map(([component, value]) => [component, {
    available: value !== null,
    value,
    reason: entry.componentDiagnostics?.[component]?.reason ?? null,
  }]))
}

export function buildLivePersistencePlan({ cycleId, historyWindow, scoredAt, candidates, volumes, histories, scores }) {
  if (!cycleId || !historyWindow || Number.isNaN(Date.parse(scoredAt))) throw new Error('Live persistence plan requires cycle, window, and scored timestamp')
  if (![candidates, volumes, histories, scores].every(Array.isArray)) throw new Error('Live persistence plan inputs must be arrays')
  const { runId, idempotencyKey } = liveIngestionIdentity({ cycleId, historyWindow })
  const candidateRows = candidates.map((candidate) => ({
    candidate_id: candidateKey(candidate.normalizedQuery),
    query_text: candidate.query,
    normalized_query: candidate.normalizedQuery,
    category: candidate.category,
  }))
  const candidateIdByQuery = new Map(candidateRows.map((row) => [row.normalized_query, row.candidate_id]))
  const volumeByQuery = new Map(volumes.map((record) => [record.normalizedQuery, record]))
  const historyByQuery = new Map(histories.map((record) => [record.normalizedQuery, record]))
  const evidence = []
  const provenances = []
  const observations = []

  for (const candidate of candidates) {
    const candidateId = candidateIdByQuery.get(candidate.normalizedQuery)
    evidence.push(evidenceRow({
      runId, candidateId, providerId: candidate.providerId, kind: 'discovery',
      observedAt: candidate.startedAt ?? candidate.retrievedAt, retrievedAt: candidate.retrievedAt,
      geographicScope: candidate.geographicScope, availability: 'available', payload: candidate,
    }))
    const volume = volumeByQuery.get(candidate.normalizedQuery)
    if (volume) evidence.push(evidenceRow({
      runId, candidateId, providerId: volume.providerId, kind: 'baseline-demand',
      observedAt: volume.retrievedAt, retrievedAt: volume.retrievedAt, geographicScope: volume.geographicScope,
      availability: volume.availability, payload: volume,
    }))
    const history = historyByQuery.get(candidate.normalizedQuery)
    if (!history) continue
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
      cross_query_comparability_status: history.provenance.crossQueryComparability.status,
      cross_query_comparability_basis: history.provenance.crossQueryComparability.basis ?? null,
      normalized_query: candidate.normalizedQuery,
    })
    evidence.push(evidenceRow({
      runId, candidateId, providerId: history.provenance.providerId, kind: 'history-metadata',
      observedAt: history.provenance.sourceObservedAt, retrievedAt: history.retrievedAt,
      geographicScope: history.provenance.geographicScope, availability: 'metadata',
      payload: { historyRequest: history.historyRequest, observationCount: history.observations.length, providerId: history.provenance.providerId },
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

  const snapshotId = stableUuid(`live-snapshot:${cycleId}:${historyWindow}`)
  const established = rankScores(scores, 'shadowTrendingScore')
  const emerging = rankScores(scores, 'shadowEmergingTrendingScore')
  const snapshotEntries = [...established.map(({ entry, rank }) => ({ entry, rank, lane: 'established' })), ...emerging.map(({ entry, rank }) => ({ entry, rank, lane: 'emerging' }))]
    .map(({ entry, rank, lane }) => ({
      snapshot_entry_id: stableUuid(`live-snapshot-entry:${snapshotId}:${entry.normalizedQuery}:${lane}`),
      snapshot_id: snapshotId,
      candidate_id: candidateIdByQuery.get(entry.normalizedQuery),
      score_lane: lane,
      classification: entry.topicClassification,
      confidence: entry.confidence,
      confidence_reason: entry.confidenceReason,
      score_basis: lane === 'established' ? 'historical-trending' : 'current-emerging-evidence',
      overall_score: lane === 'established' ? entry.shadowOverallScore : null,
      established_trending_score: lane === 'established' ? entry.shadowTrendingScore : null,
      emerging_trending_score: lane === 'emerging' ? entry.shadowEmergingTrendingScore : null,
      lane_rank: rank,
      history_observation_count: entry.history.observationCount,
      history_available_count: entry.history.availableCount,
      history_coverage_percentage: entry.history.coveragePercentage,
      search_interest_component: entry.components.searchInterest,
      component_availability: componentAvailability(entry),
    }))

  return {
    cycleId, historyWindow, scoredAt, runId, idempotencyKey,
    run: { run_id: runId, provider_id: 'serpapi-dataforseo-live', data_mode: 'live', status: 'running', idempotency_key: idempotencyKey },
    candidates: candidateRows,
    evidence,
    provenances,
    observations,
    snapshot: { snapshot_id: snapshotId, ingestion_run_id: runId, cycle_id: cycleId, data_mode: 'live', selected_window: historyWindow, scored_at: scoredAt },
    snapshotEntries,
    counts: {
      candidates: candidateRows.length,
      evidence: evidence.length,
      provenances: provenances.length,
      observations: observations.length,
      snapshots: 1,
      snapshotEntries: snapshotEntries.length,
      established: established.length,
      emerging: emerging.length,
      insufficient: scores.length - established.length - emerging.length,
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
    baselineCache: requestMetrics.baselineCache ?? null,
  }
}

export async function executeLivePersistence({ dryRun, plan, requestMetrics, repository, ...persistenceOptions }) {
  if (dryRun) return summarizeLiveDryRun(plan, requestMetrics)
  return persistLivePlan({ plan, repository, ...persistenceOptions })
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
    onProgress?.('snapshots')
    await repository.upsertLiveSnapshot(plan.snapshot)
    await repository.upsertLiveSnapshotEntries(plan.snapshotEntries.map(resolveCandidate))
    const finishedAt = now()
    const total = plan.counts.evidence + plan.counts.observations + plan.counts.snapshotEntries
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
