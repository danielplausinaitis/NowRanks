import { createHash } from 'node:crypto'
import { formatErrorDiagnostics } from './errorDiagnostics.mjs'

export const ALLOW_REPLAY_DATABASE_WRITE_ENV = 'ALLOW_REPLAY_DATABASE_WRITE'
export const INGESTION_STALE_AFTER_MINUTES_ENV = 'INGESTION_STALE_AFTER_MINUTES'
export const DEFAULT_INGESTION_STALE_AFTER_MINUTES = 15
export const DEFAULT_OBSERVATION_UPSERT_BATCH_SIZE = 500

function errorMessage(error) {
  return formatErrorDiagnostics(error)
}

/** Produces a stable UUID so a retried failed ingestion writes the same database records. */
export function stableUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function assertReplayDatabaseWriteAllowed(env = process.env) {
  if (env[ALLOW_REPLAY_DATABASE_WRITE_ENV] !== 'true') {
    throw new Error(`${ALLOW_REPLAY_DATABASE_WRITE_ENV}=true is required before replay data can be written to the database`)
  }
}

export function getIngestionStaleAfterMinutes(env = process.env) {
  const configured = env[INGESTION_STALE_AFTER_MINUTES_ENV]
  if (configured === undefined || configured === '') return DEFAULT_INGESTION_STALE_AFTER_MINUTES
  const minutes = Number(configured)
  if (!Number.isFinite(minutes) || minutes < 1) throw new Error(`${INGESTION_STALE_AFTER_MINUTES_ENV} must be a positive number of minutes`)
  return minutes
}

function isStaleRun(run, nowMs, staleAfterMinutes) {
  const startedAt = Date.parse(run.started_at)
  return Number.isFinite(startedAt) && nowMs - startedAt >= staleAfterMinutes * 60_000
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Ingestion interrupted')
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`)
}

function assertTopicData(data) {
  if (!Array.isArray(data) || data.length === 0) throw new Error('At least one normalized SearchTopicData item is required')
  const first = data[0]
  if (!first?.provenance?.providerId || !first?.provenance?.dataMode) throw new Error('Normalized topic data requires provider provenance')

  for (const topic of data) {
    if (!topic?.id?.trim() || !topic?.topic?.trim() || !topic?.normalizedQuery?.trim()) throw new Error('Candidate identity is incomplete')
    if (topic.provenance.providerId !== first.provenance.providerId || topic.provenance.dataMode !== first.provenance.dataMode) {
      throw new Error('Each ingestion must contain one provider and data mode')
    }
    assertTimestamp(topic.provenance.sourceObservedAt, 'Provenance sourceObservedAt')
    assertTimestamp(topic.provenance.ingestedAt, 'Provenance ingestedAt')
    if (!topic.provenance.geographicScope || typeof topic.provenance.geographicScope !== 'object') throw new Error('Provenance geographicScope is required')

    for (const observation of topic.observations ?? []) {
      if (observation.candidateId !== topic.id) throw new Error(`Observation candidateId does not match ${topic.id}`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(observation.date)) throw new Error(`Observation has an invalid date: ${observation.date}`)
      assertTimestamp(observation.observedAt, 'Observation observedAt')
      if (observation.availability === 'available') {
        if (!Number.isFinite(observation.interest) || observation.interest < 0) throw new Error('Available interest must be a finite non-negative number')
      } else if (observation.availability !== 'missing' || observation.interest !== null || !observation.missingReason) {
        throw new Error('Missing interest must be null and include a missing reason')
      }
    }
  }
  return { providerId: first.provenance.providerId, dataMode: first.provenance.dataMode }
}

function provenanceKey(provenance) {
  return JSON.stringify({
    providerId: provenance.providerId,
    dataMode: provenance.dataMode,
    sourceObservedAt: provenance.sourceObservedAt,
    ingestedAt: provenance.ingestedAt,
    geographicScope: provenance.geographicScope,
    sourceVersion: provenance.sourceVersion ?? null,
    collectionMethod: provenance.collectionMethod ?? null,
    comparability: provenance.crossQueryComparability,
  })
}

/**
 * Persists canonical normalized topic data. The repository is deliberately small
 * so tests can mock it and the Supabase Data API stays at the server boundary.
 */
export async function ingestNormalizedTopicData({
  data,
  idempotencyKey,
  repository,
  now = () => new Date().toISOString(),
  staleAfterMinutes = DEFAULT_INGESTION_STALE_AFTER_MINUTES,
  recoverStaleRun = false,
  onProgress,
  observationBatchSize = DEFAULT_OBSERVATION_UPSERT_BATCH_SIZE,
  signal,
}) {
  if (!idempotencyKey?.trim()) throw new Error('An idempotency key is required')
  if (!repository) throw new Error('An ingestion repository is required')
  if (!Number.isInteger(observationBatchSize) || observationBatchSize < 1) throw new Error('Observation batch size must be a positive integer')

  const { providerId, dataMode } = assertTopicData(data)
  const existing = await repository.findRunByIdempotencyKey(idempotencyKey)
  if (existing?.status === 'succeeded') {
    return { status: 'already-completed', runId: existing.run_id, candidates: 0, observations: 0 }
  }
  if (existing?.status === 'running') {
    if (!isStaleRun(existing, Date.parse(now()), staleAfterMinutes)) {
      throw new Error(`Ingestion ${idempotencyKey} is already running and is not stale (recovery threshold: ${staleAfterMinutes} minutes)`)
    }
    if (!recoverStaleRun) {
      throw new Error(`Ingestion ${idempotencyKey} is stale; rerun with explicit stale-run recovery enabled`)
    }
  }

  const runId = existing?.run_id ?? stableUuid(`ingestion-run:${idempotencyKey}`)
  const startedAt = now()
  let accepted = 0
  const received = data.reduce((total, topic) => total + (topic.observations?.length ?? 0), 0)
  let observationBatches = 0
  const startedAtMs = Date.now()
  let runClaimed = false
  try {
    assertNotAborted(signal)
    if (existing) {
      await repository.updateRun(runId, {
        status: 'running',
        started_at: startedAt,
        finished_at: null,
        records_received: 0,
        records_accepted: 0,
        records_rejected: 0,
        error_summary: existing.status === 'running' ? `Recovering stale run started at ${existing.started_at}` : null,
      })
    } else {
      await repository.createRun({ run_id: runId, provider_id: providerId, data_mode: dataMode, status: 'running', idempotency_key: idempotencyKey, started_at: startedAt, records_received: 0, records_accepted: 0, records_rejected: 0 })
    }
    runClaimed = true
    onProgress?.('ingestion run claimed')
    onProgress?.('candidates')
    let provenanceStarted = false
    let observationsStarted = false
    let observationBatch = []
    const flushObservationBatch = async () => {
      if (observationBatch.length === 0) return
      assertNotAborted(signal)
      const batch = observationBatch
      observationBatch = []
      await repository.upsertObservations(batch)
      accepted += batch.length
      observationBatches += 1
      onProgress?.({ stage: 'observations', completed: accepted, total: received, batches: observationBatches })
    }
    for (const topic of data) {
      assertNotAborted(signal)
      const candidateId = await repository.upsertCandidate({
        candidate_id: topic.id,
        query_text: topic.topic,
        normalized_query: topic.normalizedQuery,
        category: topic.category,
      })
      const provenanceId = stableUuid(`provenance:${runId}:${provenanceKey(topic.provenance)}`)
      if (!provenanceStarted) {
        onProgress?.('provenance')
        provenanceStarted = true
      }
      await repository.upsertProvenance({
        provenance_id: provenanceId,
        ingestion_run_id: runId,
        provider_id: topic.provenance.providerId,
        data_mode: topic.provenance.dataMode,
        source_observed_at: topic.provenance.sourceObservedAt,
        ingested_at: topic.provenance.ingestedAt,
        source_version: topic.provenance.sourceVersion ?? null,
        collection_method: topic.provenance.collectionMethod ?? null,
        geographic_scope: topic.provenance.geographicScope,
        cross_query_comparability_status: topic.provenance.crossQueryComparability.status,
        cross_query_comparability_basis: topic.provenance.crossQueryComparability.basis ?? null,
      })
      for (const observation of topic.observations) {
        if (!observationsStarted) {
          onProgress?.('observations')
          observationsStarted = true
        }
        observationBatch.push({
          observation_id: stableUuid(`observation:${candidateId}:${provenanceId}:${observation.observedAt}`),
          candidate_id: candidateId,
          provenance_id: provenanceId,
          observation_date: observation.date,
          observed_at: observation.observedAt,
          availability: observation.availability,
          interest_value: observation.availability === 'available' ? observation.interest : null,
          missing_reason: observation.availability === 'missing' ? observation.missingReason : null,
          ingested_at: topic.provenance.ingestedAt,
        })
        if (observationBatch.length >= observationBatchSize) await flushObservationBatch()
      }
    }
    await flushObservationBatch()
    assertNotAborted(signal)
    const finishedAt = now()
    await repository.updateRun(runId, { status: 'succeeded', finished_at: finishedAt, records_received: received, records_accepted: accepted, records_rejected: 0, error_summary: null })
    onProgress?.('completion')
    return { status: 'succeeded', runId, candidates: data.length, observations: accepted, observationBatches, elapsedMs: Date.now() - startedAtMs }
  } catch (error) {
    if (runClaimed) {
      try {
        await repository.updateRun(runId, { status: 'failed', finished_at: now(), records_received: received, records_accepted: accepted, records_rejected: Math.max(0, received - accepted), error_summary: errorMessage(error).slice(0, 1000) })
      } catch {
        // Preserve the original persistence failure; a second failure cannot make it successful.
      }
    }
    throw new Error(`Ingestion failed: ${errorMessage(error)}`)
  }
}
