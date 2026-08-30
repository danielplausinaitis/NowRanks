import { describe, expect, it } from 'vitest'
import { ALLOW_REPLAY_DATABASE_WRITE_ENV, assertReplayDatabaseWriteAllowed, ingestNormalizedTopicData } from './persistence.mjs'
import { SupabaseOperationError, formatErrorDiagnostics } from './errorDiagnostics.mjs'

function topic({ id = 'google:zero', interest = 0, missing = false } = {}) {
  return {
    id,
    topic: id === 'google:zero' ? 'Zero interest query' : 'Missing interest query',
    normalizedQuery: id,
    category: 'Technology',
    provenance: {
      providerId: 'google-trending-now',
      dataMode: 'replay',
      sourceObservedAt: '2026-08-25T00:00:00.000Z',
      ingestedAt: '2026-08-25T00:00:00.000Z',
      geographicScope: { kind: 'global' },
      collectionMethod: 'local-deterministic-replay-fixture',
      crossQueryComparability: { status: 'comparable', basis: 'fixture' },
    },
    observations: [{
      candidateId: id,
      date: '2026-08-25',
      observedAt: '2026-08-25T00:00:00.000Z',
      availability: missing ? 'missing' : 'available',
      interest: missing ? null : interest,
      ...(missing ? { missingReason: 'not-reported' } : {}),
    }],
  }
}

function mockRepository({ candidateId, failObservation = false } = {}) {
  const runs = new Map()
  const candidates = []
  const provenances = []
  const observations = []
  return {
    runs, candidates, provenances, observations,
    async findRunByIdempotencyKey(key) { return [...runs.values()].find((run) => run.idempotency_key === key) ?? null },
    async createRun(run) { runs.set(run.run_id, { ...run }) },
    async updateRun(runId, patch) { Object.assign(runs.get(runId), patch) },
    async upsertCandidate(candidate) { candidates.push(candidate); return candidateId ?? candidate.candidate_id },
    async upsertProvenance(provenance) { provenances.push(provenance) },
    async upsertObservations(batch) {
      if (failObservation) throw new Error('database write failed')
      observations.push(...batch)
    },
  }
}

const fixedNow = () => '2026-08-26T00:00:00.000Z'

function runningRun({ startedAt = '2026-08-26T00:00:00.000Z', status = 'running' } = {}) {
  return {
    run_id: 'existing-run',
    idempotency_key: 'test-running',
    provider_id: 'google-trending-now',
    data_mode: 'replay',
    status,
    started_at: startedAt,
    records_received: 0,
    records_accepted: 0,
    records_rejected: 0,
    error_summary: null,
  }
}

describe('normalized server ingestion', () => {
  it('persists normalized candidates, replay provenance, and valid zero-interest observations', async () => {
    const repository = mockRepository()
    const result = await ingestNormalizedTopicData({ data: [topic()], idempotencyKey: 'test-zero', repository, now: fixedNow })

    expect(result).toMatchObject({ status: 'succeeded', candidates: 1, observations: 1 })
    expect(repository.candidates[0]).toMatchObject({ candidate_id: 'google:zero', normalized_query: 'google:zero' })
    expect(repository.provenances[0]).toMatchObject({ data_mode: 'replay', provider_id: 'google-trending-now' })
    expect(repository.observations[0]).toMatchObject({ availability: 'available', interest_value: 0, missing_reason: null })
    expect([...repository.runs.values()][0]).toMatchObject({ status: 'succeeded', records_received: 1, records_accepted: 1 })
  })

  it('uses the repository candidate ID so an existing normalized candidate is updated rather than duplicated', async () => {
    const repository = mockRepository({ candidateId: 'existing-candidate-id' })
    await ingestNormalizedTopicData({ data: [topic()], idempotencyKey: 'test-existing-candidate', repository, now: fixedNow })
    expect(repository.observations[0].candidate_id).toBe('existing-candidate-id')
  })

  it('keeps a missing observation NULL instead of converting it to zero', async () => {
    const repository = mockRepository()
    await ingestNormalizedTopicData({ data: [topic({ id: 'google:missing', missing: true })], idempotencyKey: 'test-missing', repository, now: fixedNow })
    expect(repository.observations[0]).toMatchObject({ availability: 'missing', interest_value: null, missing_reason: 'not-reported' })
  })

  it('returns an already-completed no-op for a successful idempotency key', async () => {
    const repository = mockRepository()
    await ingestNormalizedTopicData({ data: [topic()], idempotencyKey: 'test-idempotent', repository, now: fixedNow })
    const result = await ingestNormalizedTopicData({ data: [topic()], idempotencyKey: 'test-idempotent', repository, now: fixedNow })
    expect(result.status).toBe('already-completed')
    expect(repository.observations).toHaveLength(1)
  })

  it('blocks a recent running ingestion instead of allowing concurrent work', async () => {
    const repository = mockRepository()
    repository.runs.set('existing-run', runningRun())
    await expect(ingestNormalizedTopicData({
      data: [topic()], idempotencyKey: 'test-running', repository,
      now: () => '2026-08-26T00:10:00.000Z', staleAfterMinutes: 15,
    })).rejects.toThrow(/already running and is not stale/)
    expect(repository.observations).toHaveLength(0)
  })

  it('recovers a stale running ingestion only when explicitly requested', async () => {
    const repository = mockRepository()
    repository.runs.set('existing-run', runningRun())
    const result = await ingestNormalizedTopicData({
      data: [topic()], idempotencyKey: 'test-running', repository,
      now: () => '2026-08-26T00:16:00.000Z', staleAfterMinutes: 15, recoverStaleRun: true,
    })
    expect(result).toMatchObject({ status: 'succeeded', runId: 'existing-run' })
    expect(repository.observations).toHaveLength(1)
  })

  it('requires explicit recovery for a stale run', async () => {
    const repository = mockRepository()
    repository.runs.set('existing-run', runningRun())
    await expect(ingestNormalizedTopicData({
      data: [topic()], idempotencyKey: 'test-running', repository,
      now: () => '2026-08-26T00:16:00.000Z', staleAfterMinutes: 15,
    })).rejects.toThrow(/stale; rerun with explicit stale-run recovery/)
  })

  it('marks the run failed with a useful summary when persistence fails', async () => {
    const repository = mockRepository({ failObservation: true })
    await expect(ingestNormalizedTopicData({ data: [topic()], idempotencyKey: 'test-failure', repository, now: fixedNow }))
      .rejects.toThrow(/database write failed/)
    expect([...repository.runs.values()][0]).toMatchObject({ status: 'failed', records_received: 1, records_accepted: 0, error_summary: 'database write failed' })
  })

  it('retries a failed run with the same identity without duplicating observations', async () => {
    const repository = mockRepository({ failObservation: true })
    await expect(ingestNormalizedTopicData({ data: [topic()], idempotencyKey: 'test-retry', repository, now: fixedNow }))
      .rejects.toThrow(/database write failed/)
    repository.upsertObservations = async (batch) => { repository.observations.push(...batch) }
    const result = await ingestNormalizedTopicData({ data: [topic()], idempotencyKey: 'test-retry', repository, now: fixedNow })
    expect(result).toMatchObject({ status: 'succeeded', observations: 1 })
    expect(repository.observations).toHaveLength(1)
    expect([...repository.runs.values()][0]).toMatchObject({ status: 'succeeded' })
  })
})

describe('batched observation persistence', () => {
  function topicWithObservations(count) {
    const item = topic()
    item.observations = Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString()
      return { candidateId: item.id, date: date.slice(0, 10), observedAt: date, availability: 'available', interest: index }
    })
    return item
  }

  it('writes observations in bounded batches and reports batch progress', async () => {
    const repository = mockRepository()
    const batches = []
    const progress = []
    repository.upsertObservations = async (batch) => { batches.push(batch); repository.observations.push(...batch) }
    const result = await ingestNormalizedTopicData({
      data: [topicWithObservations(5)], idempotencyKey: 'test-batches', repository, now: fixedNow,
      observationBatchSize: 2, onProgress: (event) => progress.push(event),
    })
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1])
    expect(result).toMatchObject({ observations: 5, observationBatches: 3 })
    expect(progress.filter((event) => typeof event === 'object').map((event) => event.completed)).toEqual([2, 4, 5])
  })

  it('safely retries partial batch persistence with deterministic observation IDs', async () => {
    const repository = mockRepository()
    const stored = new Map()
    let calls = 0
    repository.upsertObservations = async (batch) => {
      calls += 1
      if (calls === 2) throw new Error('second batch failed')
      for (const observation of batch) stored.set(observation.observation_id, observation)
    }
    const data = [topicWithObservations(5)]
    await expect(ingestNormalizedTopicData({ data, idempotencyKey: 'test-partial-batches', repository, now: fixedNow, observationBatchSize: 2 }))
      .rejects.toThrow(/second batch failed/)
    repository.upsertObservations = async (batch) => { for (const observation of batch) stored.set(observation.observation_id, observation) }
    const result = await ingestNormalizedTopicData({ data, idempotencyKey: 'test-partial-batches', repository, now: fixedNow, observationBatchSize: 2 })
    expect(result.status).toBe('succeeded')
    expect(stored.size).toBe(5)
  })
})

describe('replay database-write safety gate', () => {
  it('refuses replay writes unless explicitly opted in', () => {
    expect(() => assertReplayDatabaseWriteAllowed({})).toThrow(new RegExp(`${ALLOW_REPLAY_DATABASE_WRITE_ENV}=true`))
    expect(() => assertReplayDatabaseWriteAllowed({ [ALLOW_REPLAY_DATABASE_WRITE_ENV]: 'false' })).toThrow()
  })

  it('allows only the explicit true value', () => {
    expect(() => assertReplayDatabaseWriteAllowed({ [ALLOW_REPLAY_DATABASE_WRITE_ENV]: 'true' })).not.toThrow()
  })
})

describe('Supabase error diagnostics', () => {
  it('formats structured Supabase errors with useful fields instead of object coercion', () => {
    const diagnostic = formatErrorDiagnostics({
      message: 'permission denied for table candidates',
      code: '42501',
      details: 'Role service_role is not permitted',
      hint: 'Check table privileges',
      status: 403,
    })
    expect(diagnostic).toContain('permission denied for table candidates')
    expect(diagnostic).toContain('code: 42501')
    expect(diagnostic).toContain('details: Role service_role is not permitted')
    expect(diagnostic).toContain('hint: Check table privileges')
    expect(diagnostic).toContain('status: 403')
    expect(diagnostic).not.toContain('[object Object]')
  })

  it('adds failed Data API operation and table while redacting credential-shaped text', () => {
    const error = new SupabaseOperationError({
      operation: 'upsert',
      table: 'observations',
      error: { message: 'api_key=sb_secret_not-for-output', code: 'PGRST000', status: 401 },
    })
    expect(error.message).toContain('Supabase Data API upsert on observations failed')
    expect(error.message).toContain('api_key=[REDACTED]')
    expect(error.message).toContain('code: PGRST000')
    expect(error.message).toContain('status: 401')
    expect(error.message).not.toContain('sb_secret_not-for-output')
  })
})
