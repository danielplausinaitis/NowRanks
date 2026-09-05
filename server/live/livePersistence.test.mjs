import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { collectLiveIngestionCycle } from './liveIngestionPipeline.mjs'
import {
  ALLOW_LIVE_DATABASE_WRITE_ENV,
  assertLiveDatabaseWriteAllowed,
  buildLivePersistencePlan,
  executeLivePersistence,
  persistLivePlan,
  resolveLiveIngestionSafetyConfig,
  summarizeLiveDryRun,
} from './livePersistence.mjs'

const geographicScope = { kind: 'country', countryCode: 'US' }
const timestamp = '2026-09-02T12:00:00.000Z'

function candidate(topic, extra = {}) {
  const normalizedQuery = topic.toLowerCase()
  return {
    providerId: 'serpapi-google-trends-trending-now', sourceId: `source:${normalizedQuery}`,
    query: topic, normalizedQuery, category: 'Technology', searchVolume: 10_000,
    increasePercentage: 1_000, active: true, startedAt: '2026-09-02T08:00:00.000Z',
    retrievedAt: timestamp, geographicScope, ...extra,
  }
}

function volume(topic, availability = 'available') {
  return {
    providerId: 'dataforseo-google-ads-search-volume', query: topic, normalizedQuery: topic.toLowerCase(),
    availability, searchVolume: availability === 'available' ? 5_000 : null, retrievedAt: timestamp,
    geographicScope, provenance: { providerId: 'dataforseo-google-ads-search-volume', dataMode: 'live' },
  }
}

function history(topic, availability = 'available', missingReason = 'out-of-range') {
  const normalizedQuery = topic.toLowerCase()
  return {
    id: `dataforseo-trends:${normalizedQuery}`, topic, normalizedQuery, category: 'Technology', retrievedAt: timestamp,
    historyRequest: { timeRange: 'past_12_months' },
    provenance: {
      providerId: 'dataforseo-trends', dataMode: 'live', sourceObservedAt: timestamp, ingestedAt: timestamp,
      sourceVersion: 'dataforseo-trends-v3', collectionMethod: 'dataforseo-trends-explore-live', geographicScope,
      crossQueryComparability: { status: 'comparable', basis: 'single-keyword request' },
    },
    observations: [{
      candidateId: `dataforseo-trends:${normalizedQuery}`, date: '2026-08-31', observedAt: '2026-08-31T00:00:00.000Z',
      availability, interest: availability === 'available' ? 0 : null,
      ...(availability === 'missing' ? { missingReason } : {}),
    }],
  }
}

function score(topic, kind) {
  const common = {
    topic, normalizedQuery: topic.toLowerCase(), components: { searchInterest: 70, growth: null, momentum: null, consistency: null, breakout: null },
    componentDiagnostics: { growth: { reason: 'mock' }, momentum: { reason: 'mock' }, consistency: { reason: 'mock' }, breakout: { reason: 'mock' } },
    history: { observationCount: 52, availableCount: kind === 'emerging' ? 4 : 52, coveragePercentage: kind === 'emerging' ? 7.69 : 100 },
  }
  if (kind === 'established') return {
    ...common, topicClassification: 'established', confidence: 'full', confidenceReason: 'all historical components available',
    shadowOverallScore: 75, shadowTrendingScore: 80, shadowEmergingTrendingScore: null,
  }
  if (kind === 'emerging') return {
    ...common, topicClassification: 'possible-new-trend', confidence: 'emerging', confidenceReason: 'active recent sparse trend',
    shadowOverallScore: null, shadowTrendingScore: null, shadowEmergingTrendingScore: 85,
  }
  return {
    ...common, topicClassification: 'insufficient-provider-data', confidence: 'insufficient', confidenceReason: 'insufficient evidence',
    shadowOverallScore: null, shadowTrendingScore: null, shadowEmergingTrendingScore: null,
  }
}

function fixturePlan() {
  const candidates = [candidate('Established', { apiKey: 'must-not-persist' }), candidate('Emerging'), candidate('Insufficient')]
  return buildLivePersistencePlan({
    cycleId: '2026-09-02T12Z', historyWindow: '1Y', scoredAt: timestamp,
    candidates, volumes: candidates.map(({ query }) => volume(query)), histories: candidates.map(({ query }) => history(query)),
    scores: [score('Established', 'established'), score('Emerging', 'emerging'), score('Insufficient', 'insufficient')],
  })
}

function mockRepository({ failSnapshotsOnce = false } = {}) {
  const stores = {
    runs: new Map(), candidates: new Map(), evidence: new Map(), provenances: new Map(), observations: new Map(), snapshots: new Map(), entries: new Map(),
  }
  let shouldFailSnapshots = failSnapshotsOnce
  return {
    stores,
    async findRunByIdempotencyKey(key) { return [...stores.runs.values()].find((run) => run.idempotency_key === key) ?? null },
    async createRun(run) { stores.runs.set(run.run_id, { ...run }) },
    async updateRun(id, patch) { Object.assign(stores.runs.get(id), patch) },
    async upsertCandidate(row) {
      const existing = [...stores.candidates.values()].find((candidateRow) => candidateRow.normalized_query === row.normalized_query)
      const resolved = existing?.candidate_id ?? row.candidate_id
      stores.candidates.set(resolved, { ...row, candidate_id: resolved })
      return resolved
    },
    async upsertLiveEvidence(rows) { rows.forEach((row) => stores.evidence.set(row.evidence_id, row)) },
    async upsertLiveProvenance(rows) { rows.forEach((row) => stores.provenances.set(row.provenance_id, row)) },
    async upsertLiveObservations(rows) { rows.forEach((row) => stores.observations.set(row.observation_id, row)) },
    async upsertLiveSnapshot(row) {
      if (shouldFailSnapshots) { shouldFailSnapshots = false; throw new Error('snapshot write failed') }
      stores.snapshots.set(row.snapshot_id, row)
    },
    async upsertLiveSnapshotEntries(rows) { rows.forEach((row) => stores.entries.set(row.snapshot_entry_id, row)) },
  }
}

const writeEnv = { [ALLOW_LIVE_DATABASE_WRITE_ENV]: 'true' }
const fixedNow = () => timestamp

describe('live ingestion safety configuration', () => {
  it('defaults to dry-run with a bounded candidate count and refuses writes by default', () => {
    expect(resolveLiveIngestionSafetyConfig({}, fixedNow)).toMatchObject({ dryRun: true, candidateLimit: 50, displayLimit: 10, discoveryLimit: 50, initialPaidCandidates: 15, maxPaidCandidates: 50, cycleId: '2026-09-02T12:00Z' })
    expect(() => assertLiveDatabaseWriteAllowed({})).toThrow(/ALLOW_LIVE_DATABASE_WRITE=true/)
    expect(() => assertLiveDatabaseWriteAllowed({ ALLOW_REPLAY_DATABASE_WRITE: 'true' })).toThrow(/ALLOW_LIVE_DATABASE_WRITE=true/)
  })

  it('accepts only the independent exact live gate and conservative candidate range', () => {
    expect(() => assertLiveDatabaseWriteAllowed(writeEnv)).not.toThrow()
    expect(resolveLiveIngestionSafetyConfig({ LIVE_INGEST_DRY_RUN: 'false', LIVE_INGEST_CANDIDATE_LIMIT: '21' }, fixedNow)).toMatchObject({ candidateLimit: 21, discoveryLimit: 21, initialPaidCandidates: 21, maxPaidCandidates: 21 })
    expect(resolveLiveIngestionSafetyConfig({ LIVE_INGEST_DRY_RUN: 'false', LIVE_INGEST_CANDIDATE_LIMIT: '2' }, fixedNow)).toMatchObject({ dryRun: false, candidateLimit: 2 })
  })
})

describe('live persistence plan', () => {
  it('uses deterministic candidate, observation, provenance, evidence, and snapshot identities', () => {
    expect(fixturePlan()).toEqual(fixturePlan())
    const plan = fixturePlan()
    expect(new Set(plan.candidates.map(({ candidate_id }) => candidate_id)).size).toBe(3)
    expect(new Set(plan.observations.map(({ observation_id }) => observation_id)).size).toBe(3)
    expect(new Set(plan.evidence.map(({ evidence_id }) => evidence_id)).size).toBe(9)
    expect(plan.run).toMatchObject({ data_mode: 'live', provider_id: 'serpapi-dataforseo-live' })
  })

  it('keeps provenance and observations idempotent when a failed cycle is refetched at a later retrieval time', () => {
    const first = fixturePlan()
    const candidates = [candidate('Established'), candidate('Emerging'), candidate('Insufficient')]
    const laterHistories = candidates.map(({ query }) => ({ ...history(query), retrievedAt: '2026-09-02T12:05:00.000Z' }))
    const second = buildLivePersistencePlan({
      cycleId: '2026-09-02T12Z', historyWindow: '1Y', scoredAt: '2026-09-02T12:05:00.000Z',
      candidates, volumes: candidates.map(({ query }) => volume(query)), histories: laterHistories,
      scores: [score('Established', 'established'), score('Emerging', 'emerging'), score('Insufficient', 'insufficient')],
    })
    expect(second.provenances.map(({ provenance_id }) => provenance_id)).toEqual(first.provenances.map(({ provenance_id }) => provenance_id))
    expect(second.observations.map(({ observation_id }) => observation_id)).toEqual(first.observations.map(({ observation_id }) => observation_id))
  })

  it('preserves zero versus missing and stores credential-free normalized evidence', () => {
    const plan = fixturePlan()
    expect(plan.observations[0]).toMatchObject({ availability: 'available', interest_value: 0, missing_reason: null })
    expect(JSON.stringify(plan)).not.toContain('must-not-persist')
    expect(plan.evidence.every((row) => row.data_mode === 'live')).toBe(true)
  })

  it('persists invalid provider measurements as the explicit missing state', () => {
    const item = candidate('Invalid graph value')
    const plan = buildLivePersistencePlan({ cycleId: 'invalid-cell', historyWindow: '1Y', scoredAt: timestamp, candidates: [item], volumes: [volume(item.query)], histories: [history(item.query, 'missing', 'invalid-provider-measurement')], scores: [score(item.query, 'insufficient')] })
    expect(plan.observations[0]).toMatchObject({ availability: 'missing', interest_value: null, missing_reason: 'invalid-provider-measurement' })
  })

  it('stores truthful established and emerging snapshot contracts without a unified rank', () => {
    const plan = fixturePlan()
    const established = plan.snapshotEntries.find((entry) => entry.score_lane === 'established')
    const emerging = plan.snapshotEntries.find((entry) => entry.score_lane === 'emerging')
    expect(established).toMatchObject({ overall_score: 75, established_trending_score: 80, emerging_trending_score: null, lane_rank: 1, confidence: 'full', classification: 'established', score_basis: 'historical-trending' })
    expect(emerging).toMatchObject({ overall_score: null, established_trending_score: null, emerging_trending_score: 85, lane_rank: 1, confidence: 'emerging', classification: 'possible-new-trend', score_basis: 'current-emerging-evidence' })
    expect(plan.snapshotEntries.every((entry) => !('trending_rank' in entry) && !('unified_rank' in entry))).toBe(true)
    expect(plan.counts).toMatchObject({ established: 1, emerging: 1, insufficient: 1, snapshotEntries: 2 })
  })

  it('dry-run returns a complete plan summary and performs zero repository writes', async () => {
    const repository = Object.fromEntries(['findRunByIdempotencyKey', 'createRun', 'updateRun', 'upsertCandidate'].map((name) => [name, vi.fn(() => { throw new Error('must not write') })]))
    const result = await executeLivePersistence({ dryRun: true, plan: fixturePlan(), repository, requestMetrics: { providerRequests: { serpApi: 1 }, providerCosts: { total: 0.1 } } })
    expect(result).toMatchObject({ dryRun: true, dataMode: 'live', candidates: 3, observations: 3, snapshotEntries: 2 })
    expect(Object.values(repository).every((mock) => mock.mock.calls.length === 0)).toBe(true)
    expect(summarizeLiveDryRun(fixturePlan()).idempotencyKey).toMatch(/^live:serpapi-dataforseo:/)
    expect(summarizeLiveDryRun(fixturePlan(), { baselineCache: { freshHits: 2, writesSkipped: true } }).baselineCache).toEqual({ freshHits: 2, writesSkipped: true })
  })
})

describe('idempotent live writes and recovery', () => {
  it('persists one established and one emerging lane entry, then makes a duplicate completed cycle a no-op', async () => {
    const repository = mockRepository()
    const plan = fixturePlan()
    const first = await persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })
    const second = await persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })
    expect(first.status).toBe('succeeded')
    expect(second.status).toBe('already-completed')
    expect(repository.stores.candidates.size).toBe(3)
    expect(repository.stores.observations.size).toBe(3)
    expect(repository.stores.provenances.size).toBe(3)
    expect(repository.stores.evidence.size).toBe(9)
    expect(repository.stores.snapshots.size).toBe(1)
    expect(repository.stores.entries.size).toBe(2)
  })

  it('marks a partial failure failed and retries safely with identical rows', async () => {
    const repository = mockRepository({ failSnapshotsOnce: true })
    const plan = fixturePlan()
    await expect(persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })).rejects.toThrow(/snapshot write failed/)
    expect(repository.stores.runs.get(plan.runId)).toMatchObject({ status: 'failed', error_summary: 'snapshot write failed' })
    const result = await persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })
    expect(result.status).toBe('succeeded')
    expect(repository.stores.observations.size).toBe(3)
    expect(repository.stores.evidence.size).toBe(9)
    expect(repository.stores.entries.size).toBe(2)
  })

  it('safely retries after a committed observation batch fails later without cleanup', async () => {
    const repository = mockRepository(); const plan = fixturePlan(); let calls = 0
    repository.upsertLiveObservations = async (rows) => {
      calls += 1
      if (calls === 2) throw new Error('observation constraint failed')
      rows.forEach((row) => repository.stores.observations.set(row.observation_id, row))
    }
    await expect(persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow, observationBatchSize: 1 })).rejects.toThrow(/observation constraint failed/)
    expect(repository.stores.observations.size).toBe(1)
    expect(repository.stores.runs.get(plan.runId)).toMatchObject({ status: 'failed', records_accepted: 1 })
    repository.upsertLiveObservations = async (rows) => rows.forEach((row) => repository.stores.observations.set(row.observation_id, row))
    await expect(persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow, observationBatchSize: 1 })).resolves.toMatchObject({ status: 'succeeded' })
    expect(repository.stores.observations.size).toBe(3)
  })
})

describe('provider and production isolation', () => {
  it('stops on a provider error without fallback, scoring, or persistence-shaped output', async () => {
    const error = new Error('provider unavailable')
    const volumeClient = { lookup: vi.fn() }
    const trendsClient = { measure: vi.fn() }
    const scoreCycle = vi.fn()
    await expect(collectLiveIngestionCycle({
      candidateLimit: 10, discoveryRequest: { geographicScope }, volumeRequest: {}, historyRequest: {}, historyWindow: '1Y', trendsMode: 'single',
      discoveryClient: { discover: vi.fn(async () => { throw error }) }, volumeClient, trendsClient, scoreCycle,
    })).rejects.toThrow('provider unavailable')
    expect(volumeClient.lookup).not.toHaveBeenCalled()
    expect(trendsClient.measure).not.toHaveBeenCalled()
    expect(scoreCycle).not.toHaveBeenCalled()
    expect(readFileSync('server/live/liveIngestionPipeline.mjs', 'utf8')).not.toMatch(/from\s+['"][^'"]*replay/i)
  })

  it('keeps replay persistence and production scoring unchanged and the new schema additive', () => {
    const replay = readFileSync('server/ingestion/persistence.mjs', 'utf8')
    const production = readFileSync('src/domain/scoring.ts', 'utf8')
    const migration = readFileSync('db/migrations/002_live_persistence.sql', 'utf8')
    expect(replay).not.toMatch(/ALLOW_LIVE_DATABASE_WRITE|live_leaderboard/)
    expect(production).not.toMatch(/livePersistence|live_leaderboard/)
    expect(migration).not.toMatch(/ALTER TABLE (candidates|observations|source_provenance|ingestion_runs|leaderboard_snapshots|leaderboard_snapshot_entries)/i)
    expect(migration).not.toMatch(/trending_rank/i)
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/g)
  })
})
