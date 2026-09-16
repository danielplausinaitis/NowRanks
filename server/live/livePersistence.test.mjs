import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { collectLiveIngestionCycle } from './liveIngestionPipeline.mjs'
import {
  ALLOW_LIVE_DATABASE_WRITE_ENV,
  assertLiveDatabaseWriteAllowed,
  assertLiveEvidenceProviderIds,
  assertLiveProvenanceComparabilityStatuses,
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
    presentation: { growthPercent: 10_902, growthSource: 'provider-history', growthSaturated: false, trendHeat: 'surging' },
  }
  if (kind === 'established') return {
    ...common, topicClassification: 'established', confidence: 'full', confidenceReason: 'all historical components available',
    evidenceStatus: 'established', unifiedRawScore: 80, nowScore: 90, shadowOverallScore: 75, shadowTrendingScore: 80, shadowEmergingTrendingScore: null,
  }
  if (kind === 'emerging') return {
    ...common, topicClassification: 'possible-new-trend', confidence: 'emerging', confidenceReason: 'active recent sparse trend',
    evidenceStatus: 'emerging', unifiedRawScore: 85, nowScore: 92.25, shadowOverallScore: null, shadowTrendingScore: null, shadowEmergingTrendingScore: 85,
  }
  return {
    ...common, topicClassification: 'insufficient-provider-data', confidence: 'insufficient', confidenceReason: 'insufficient evidence',
    evidenceStatus: 'emerging', unifiedRawScore: null, nowScore: null, shadowOverallScore: null, shadowTrendingScore: null, shadowEmergingTrendingScore: null,
  }
}

function fixturePlan(options = {}) {
  const candidates = [candidate('Established', { apiKey: 'must-not-persist' }), candidate('Emerging'), candidate('Insufficient')]
  return buildLivePersistencePlan({
    cycleId: '2026-09-02T12Z', historyWindow: '1Y', scoredAt: timestamp, displayLimit: 2,
    candidates, volumes: candidates.map(({ query }) => volume(query)), histories: candidates.map(({ query }) => history(query)),
    scores: [score('Established', 'established'), score('Emerging', 'emerging'), score('Insufficient', 'insufficient')], ...options,
  })
}

function mockRepository({ failSnapshotsOnce = false } = {}) {
  const stores = {
    runs: new Map(), candidates: new Map(), evidence: new Map(), provenances: new Map(), observations: new Map(), vaultMeasurements: new Map(), canonicalArtifacts: new Map(), canonicalAlignments: new Map(), canonicalPoints: new Map(), snapshots: new Map(), entries: new Map(),
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
    async upsertLiveHistoricalVaultMeasurements(rows) { rows.forEach((row) => stores.vaultMeasurements.set(row.measurement_id, row)) },
    async upsertLiveProviderCurveArtifacts(rows) { rows.forEach((row) => stores.canonicalArtifacts.set(row.artifact_id, row)) },
    async upsertLiveCanonicalAttentionAlignments(rows) { rows.forEach((row) => stores.canonicalAlignments.set(row.alignment_id, row)) },
    async upsertLiveCanonicalAttentionPoints(rows) { rows.forEach((row) => stores.canonicalPoints.set(row.point_id, row)) },
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
    expect(resolveLiveIngestionSafetyConfig({}, fixedNow)).toMatchObject({ dryRun: true, candidateLimit: 50, displayLimit: 20, discoveryLimit: 100, initialPaidCandidates: 15, maxPaidCandidates: 50, adaptive7dMaxCandidates: 70, cycleId: '2026-09-02T12:00Z' })
    expect(() => assertLiveDatabaseWriteAllowed({})).toThrow(/ALLOW_LIVE_DATABASE_WRITE=true/)
    expect(() => assertLiveDatabaseWriteAllowed({ ALLOW_REPLAY_DATABASE_WRITE: 'true' })).toThrow(/ALLOW_LIVE_DATABASE_WRITE=true/)
  })

  it('accepts only the independent exact live gate and conservative candidate range', () => {
    expect(() => assertLiveDatabaseWriteAllowed(writeEnv)).not.toThrow()
    expect(resolveLiveIngestionSafetyConfig({ LIVE_INGEST_DRY_RUN: 'false', LIVE_INGEST_CANDIDATE_LIMIT: '21' }, fixedNow)).toMatchObject({ candidateLimit: 21, discoveryLimit: 21, initialPaidCandidates: 21, maxPaidCandidates: 21, adaptive7dMaxCandidates: 21 })
    expect(resolveLiveIngestionSafetyConfig({ LIVE_INGEST_DRY_RUN: 'false', LIVE_INGEST_CANDIDATE_LIMIT: '2' }, fixedNow)).toMatchObject({ dryRun: false, candidateLimit: 2 })
    expect(() => resolveLiveIngestionSafetyConfig({ LIVE_DISCOVERY_LIMIT: '100', LIVE_MAX_PAID_CANDIDATES: '51' }, fixedNow)).toThrow(/LIVE_MAX_PAID_CANDIDATES.*between 2 and 50/)
    expect(() => resolveLiveIngestionSafetyConfig({ LIVE_7D_ADAPTIVE_MAX_CANDIDATES: '71' }, fixedNow)).toThrow(/LIVE_7D_ADAPTIVE_MAX_CANDIDATES.*between 50 and 70/)
    expect(() => resolveLiveIngestionSafetyConfig({ LIVE_MAX_PAID_CANDIDATES: '50', LIVE_7D_ADAPTIVE_MAX_CANDIDATES: '49' }, fixedNow)).toThrow(/LIVE_7D_ADAPTIVE_MAX_CANDIDATES.*between 50 and 70/)
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

  it('stores a v2 unified public contract without legacy score fields', () => {
    const plan = fixturePlan()
    expect(plan.snapshot).toMatchObject({ snapshot_format_version: 2 })
    expect(plan.snapshotEntries).toEqual(expect.arrayContaining([expect.objectContaining({ score_lane: 'unified', score_basis: 'unified-public', lane_rank: null, public_rank: 1, public_score: 92.25, evidence_status: 'emerging', overall_score: null, established_trending_score: null, emerging_trending_score: null })]))
    expect(plan.snapshotEntries.map((entry) => entry.public_rank)).toEqual([1, 2])
    expect(plan.counts).toMatchObject({ unified: 2, insufficient: 1, snapshotEntries: 2 })
  })

  it('keeps explicit provider identity through discovery, baseline, and Google Trends history evidence', () => {
    const item = candidate('Google Trends topic')
    const googleHistory = {
      ...history(item.query),
      historyRequest: { timeRange: 'past_day' },
      provenance: { ...history(item.query).provenance, providerId: 'dataforseo-google-trends' },
    }
    const plan = buildLivePersistencePlan({
      cycleId: 'provider-identities', historyWindow: '24H', scoredAt: timestamp,
      candidates: [item], discoveryCandidates: [item], volumes: [volume(item.query)], histories: [googleHistory], scores: [score(item.query, 'established')],
    })
    expect(plan.evidence.map((row) => [row.evidence_kind, row.provider_id])).toEqual([
      ['discovery', 'serpapi-google-trends-trending-now'],
      ['baseline-demand', 'dataforseo-google-ads-search-volume'],
      ['history-metadata', 'dataforseo-google-trends'],
    ])
    expect(plan.evidence.find((row) => row.evidence_kind === 'discovery').evidence_payload.providerId).toBe('serpapi-google-trends-trending-now')
  })

  it('rejects a discovery record without provider identity while constructing the persistence plan', () => {
    const item = candidate('Missing discovery provider', { providerId: null })
    expect(() => buildLivePersistencePlan({
      cycleId: 'missing-discovery-provider', historyWindow: '24H', scoredAt: timestamp,
      candidates: [item], discoveryCandidates: [item], volumes: [volume(item.query)], histories: [], scores: [score(item.query, 'established')],
    })).toThrow(/discovery evidence.*non-empty provider ID/i)
  })

  it('persists unselected current discovery evidence for later breadth diagnostics without measuring it', () => {
    const selected = candidate('Measured Technology')
    const unselected = candidate('Unselected Finance', { category: 'Finance', providerDiscoveryRank: 52, normalizedDiscoveryPosition: 52, rawProviderResultCount: 58 })
    const plan = buildLivePersistencePlan({
      cycleId: 'discovery-breadth', historyWindow: '24H', scoredAt: timestamp,
      candidates: [selected], discoveryCandidates: [selected, unselected], volumes: [volume(selected.query)], histories: [], scores: [score(selected.query, 'established')],
    })
    expect(plan.candidates).toHaveLength(2)
    const discovery = plan.evidence.filter((row) => row.evidence_kind === 'discovery')
    expect(discovery).toHaveLength(2)
    expect(discovery.find((row) => row.candidate_id === 'live:unselected finance').evidence_payload).toMatchObject({
      category: 'Finance', providerDiscoveryRank: 52, normalizedDiscoveryPosition: 52, rawProviderResultCount: 58,
      paidTrackingSelected: false, paidTrackingSelectionReason: 'not-selected-for-paid-tracking',
    })
    expect(plan.evidence.filter((row) => row.evidence_kind === 'baseline-demand')).toHaveLength(1)
  })

  it('persists Growth value, availability, source, promotion decision, fallback reason, and saturation for diagnostics', () => {
    const scores = [score('Established', 'established'), score('Emerging', 'emerging'), score('Insufficient', 'insufficient')]
    scores[0].presentation.growthDiagnostics = {
      value: 10_902, availability: true, source: 'provider-history', saturation: false,
      promotion: { promotionOutcome: 'fallback', reason: 'unsupported-window' }, fallbackReason: 'unsupported-window',
    }
    const plan = fixturePlan({ scores })
    const presentation = plan.snapshotEntries.find((entry) => entry.candidate_id === 'live:established').component_availability.presentation
    expect(presentation).toMatchObject({
      growthPercent: 10_902, growthSource: 'provider-history', growthSaturated: false,
      growthDiagnostics: { value: 10_902, availability: true, source: 'provider-history', saturation: false, fallbackReason: 'unsupported-window', promotion: { promotionOutcome: 'fallback' } },
    })
  })

  it('persists a credential-free unified score diagnostic for every measured candidate, including non-public candidates', () => {
    const plan = fixturePlan()
    const diagnostics = plan.evidence.filter((row) => row.evidence_kind === 'history-metadata')
      .map((row) => row.evidence_payload.unifiedScoreDiagnostic)
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 'unified-public-score-diagnostic-v1', wouldBeRank: 1, unifiedRawScore: 85, publicScore: 92.25 }),
      expect.objectContaining({ version: 'unified-public-score-diagnostic-v1', wouldBeRank: 2, unifiedRawScore: 80, publicScore: 90 }),
      expect.objectContaining({ wouldBeRank: null, unifiedRawScore: null, publicScore: null }),
    ]))
  })

  it('persists the computed Heat decision without changing the public score', () => {
    const scores = [score('Established', 'established'), score('Emerging', 'emerging'), score('Insufficient', 'insufficient')]
    scores[0].presentation.heatDiagnostics = {
      heatStatus: 'available', heatLevel: 'stable', heatEvidenceAvailable: true,
      heatEvidenceSource: 'current-intensity', heatFallbackUsed: true, heatPendingReason: null,
    }
    scores[0].presentation.trendHeat = 'stable'
    const entry = fixturePlan({ scores }).snapshotEntries.find((item) => item.candidate_id === 'live:established')
    expect(entry.public_score).toBe(90)
    expect(entry.component_availability.presentation).toMatchObject({ trendHeat: 'stable', heatDiagnostics: scores[0].presentation.heatDiagnostics })
  })

  it('writes one idempotent UTC-slot vault artifact per evaluated discovery candidate only when enabled', async () => {
    const plan = fixturePlan({ vaultConfig: { enabled: true, growthMode: 'shadow', slotMinutes: 240 }, vaultDiscoveryRequest: { geo: 'US', language: 'en', hours: 24 } })
    expect(plan.vaultMeasurements).toHaveLength(3)
    expect(plan.vaultMeasurements.every((row) => row.comparability_status === 'unknown' && row.quality.growthEligible === false)).toBe(true)
    expect(plan.vaultMeasurements.map((row) => row.slot_at)).toEqual([timestamp, timestamp, timestamp])
    const repository = mockRepository()
    await persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })
    expect(repository.stores.vaultMeasurements.size).toBe(3)
  })

  it('writes the raw 24H curve before its alignment and immutable canonical points only in shadow/preferred modes', async () => {
    const canonicalHistory = {
      ...history('Established'), historyRequest: { timeRange: 'past_day' },
      observations: [0, 4, 8, 12].map((hour, index) => ({ candidateId: 'dataforseo-trends:established', date: '2026-09-02', observedAt: `2026-09-02T${String(hour).padStart(2, '0')}:00:00.000Z`, availability: 'available', interest: (index + 1) * 10 })),
    }
    const plan = buildLivePersistencePlan({ cycleId: 'canonical-shadow', historyWindow: '24H', scoredAt: timestamp, candidates: [candidate('Established')], volumes: [volume('Established')], histories: [canonicalHistory], scores: [score('Established', 'established')], vaultConfig: { enabled: true, growthMode: 'shadow', slotMinutes: 240 } })
    expect(plan.canonicalAttention.diagnostics).toMatchObject({ bootstrapped: 1, newPoints: 4 })
    const repository = mockRepository()
    await persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })
    expect(repository.stores.canonicalArtifacts.size).toBe(1)
    expect(repository.stores.canonicalAlignments.size).toBe(1)
    expect(repository.stores.canonicalPoints.size).toBe(4)
    const off = buildLivePersistencePlan({ cycleId: 'canonical-off', historyWindow: '24H', scoredAt: timestamp, candidates: [candidate('Established')], volumes: [volume('Established')], histories: [canonicalHistory], scores: [score('Established', 'established')], vaultConfig: { enabled: true, growthMode: 'off', slotMinutes: 240 } })
    expect(off.canonicalAttention.artifacts).toHaveLength(0)
  })

  it('persists final growth source metadata with the same value supplied to the reader', () => {
    const entry = fixturePlan().snapshotEntries.find((item) => item.candidate_id.includes('established'))
    expect(entry.component_availability.presentation).toEqual({ growthPercent: 10_902, growthSource: 'provider-history', growthSaturated: false, vaultGrowth: null, trendHeat: 'surging' })
  })

  it('supports a full public Top 20 with sequential unified ranks', () => {
    const candidates = Array.from({ length: 20 }, (_, index) => candidate(`Topic ${index + 1}`))
    const scores = candidates.map((item, index) => ({ ...score(item.query, 'established'), unifiedRawScore: 100 - index, nowScore: 99 - index * .45 }))
    const plan = buildLivePersistencePlan({ cycleId: 'top-20', historyWindow: '7D', scoredAt: timestamp, candidates, volumes: candidates.map(({ query }) => volume(query)), histories: [], scores })
    expect(plan.snapshotEntries).toHaveLength(20)
    expect(plan.snapshotEntries.map((entry) => entry.public_rank)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })

  it('publishes only the Top 20 when more than 20 candidates have finite unified scores', () => {
    const candidates = Array.from({ length: 23 }, (_, index) => candidate(`Overflow ${index + 1}`))
    const scores = candidates.map((item, index) => ({ ...score(item.query, 'established'), unifiedRawScore: 100 - index, nowScore: 99 - index * .45 }))
    const plan = buildLivePersistencePlan({ cycleId: 'top-20-overflow', historyWindow: '7D', scoredAt: timestamp, candidates, volumes: [], histories: [], scores, displayLimit: 20 })
    expect(plan.publication).toEqual({ publishable: true, requiredCount: 20, availableCount: 23, historyWindow: '7D', cycleId: 'top-20-overflow', reason: null })
    expect(plan.snapshotEntries).toHaveLength(20)
  })

  it.each(['7D', '30D', '1Y'])('rejects a %s partial public board before any snapshot is constructed', (historyWindow) => {
    const candidates = Array.from({ length: 14 }, (_, index) => candidate(`${historyWindow} partial ${index + 1}`))
    const scores = candidates.map((item, index) => ({ ...score(item.query, 'established'), unifiedRawScore: 100 - index, nowScore: 99 - index * .45 }))
    const plan = buildLivePersistencePlan({ cycleId: `${historyWindow}-partial`, historyWindow, scoredAt: timestamp, candidates, volumes: [], histories: [], scores, displayLimit: 20 })
    expect(plan.publication).toEqual({ publishable: false, requiredCount: 20, availableCount: 14, historyWindow, cycleId: `${historyWindow}-partial`, reason: 'insufficient-public-candidates' })
    expect(plan.snapshot).toBeNull()
    expect(plan.snapshotEntries).toEqual([])
    expect(plan.counts).toMatchObject({ snapshots: 0, snapshotEntries: 0, unified: 14 })
  })

  it('records an insufficient board as partial without replacing a previously published Top 20', async () => {
    const fullCandidates = Array.from({ length: 20 }, (_, index) => candidate(`Published ${index + 1}`))
    const fullScores = fullCandidates.map((item, index) => ({ ...score(item.query, 'established'), unifiedRawScore: 100 - index, nowScore: 99 - index * .45 }))
    const full = buildLivePersistencePlan({ cycleId: 'published-20', historyWindow: '7D', scoredAt: timestamp, candidates: fullCandidates, volumes: [], histories: [], scores: fullScores, displayLimit: 20 })
    const partialCandidates = Array.from({ length: 14 }, (_, index) => candidate(`Insufficient ${index + 1}`))
    const partialScores = partialCandidates.map((item, index) => ({ ...score(item.query, 'established'), unifiedRawScore: 100 - index, nowScore: 99 - index * .45 }))
    const partial = buildLivePersistencePlan({ cycleId: 'insufficient-14', historyWindow: '7D', scoredAt: '2026-09-02T13:00:00.000Z', candidates: partialCandidates, volumes: [], histories: [], scores: partialScores, displayLimit: 20 })
    const repository = mockRepository()
    await persistLivePlan({ plan: full, repository, env: writeEnv, now: fixedNow })
    const result = await persistLivePlan({ plan: partial, repository, env: writeEnv, now: fixedNow })
    expect(result).toMatchObject({ status: 'partial', publication: { reason: 'insufficient-public-candidates', requiredCount: 20, availableCount: 14, historyWindow: '7D', cycleId: 'insufficient-14' } })
    expect(repository.stores.snapshots.size).toBe(1)
    expect(repository.stores.entries.size).toBe(20)
    expect(repository.stores.runs.get(partial.runId)).toMatchObject({ status: 'partial', error_summary: 'insufficient-public-candidates: required=20; available=14; horizon=7D; cycle=insufficient-14' })
  })

  it('keeps a diversified candidate pool in one score-ordered public ranking without category quotas', () => {
    const candidates = [
      candidate('Sports highest', { category: 'Sports' }),
      candidate('Sports second', { category: 'Sports' }),
      candidate('Technology third', { category: 'Technology' }),
      candidate('Health fourth', { category: 'Health' }),
    ]
    const scores = candidates.map((item, index) => ({ ...score(item.query, 'established'), unifiedRawScore: 100 - index, nowScore: 99 - index }))
    const plan = buildLivePersistencePlan({ cycleId: 'unified-no-category-quota', historyWindow: '7D', scoredAt: timestamp, candidates, volumes: [], histories: [], scores, displayLimit: 4 })
    expect(plan.snapshotEntries.map((entry) => entry.candidate_id)).toEqual([
      'live:sports highest', 'live:sports second', 'live:technology third', 'live:health fourth',
    ])
    expect(plan.snapshotEntries.map((entry) => entry.public_rank)).toEqual([1, 2, 3, 4])
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
  it('accepts every database-supported provenance comparability status', () => {
    expect(() => assertLiveProvenanceComparabilityStatuses(['comparable', 'not-comparable', 'unknown'].map((cross_query_comparability_status) => ({
      provider_id: 'dataforseo-google-trends', normalized_query: `topic-${cross_query_comparability_status}`, cross_query_comparability_status,
    })))).not.toThrow()
  })

  it('rejects null evidence provider IDs before any repository operation', async () => {
    const plan = fixturePlan()
    plan.evidence[0].provider_id = null
    const repository = mockRepository()
    await expect(persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })).rejects.toThrow(/discovery evidence.*non-empty provider ID/i)
    expect(repository.stores.runs.size).toBe(0)
    expect(repository.stores.candidates.size).toBe(0)
    expect(repository.stores.evidence.size).toBe(0)
    expect(() => assertLiveEvidenceProviderIds([{ evidence_kind: 'discovery', candidate_id: 'candidate', provider_id: '  ' }])).toThrow(/discovery evidence.*non-empty provider ID/i)
  })

  it('rejects an unsupported provenance comparability value before any repository operation', async () => {
    const plan = fixturePlan()
    plan.provenances[0].cross_query_comparability_status = 'not-comparable-across-batches'
    const repository = mockRepository()
    await expect(persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })).rejects.toThrow(/unsupported cross-query comparability status.*not-comparable-across-batches/i)
    expect(repository.stores.runs.size).toBe(0)
    expect(repository.stores.candidates.size).toBe(0)
    expect(repository.stores.evidence.size).toBe(0)
    expect(repository.stores.provenances.size).toBe(0)
  })

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

  it('reuses the same failed cycle identity when provider-evidence persistence is retried', async () => {
    const repository = mockRepository()
    const plan = fixturePlan()
    let failEvidenceOnce = true
    repository.upsertLiveEvidence = async (rows) => {
      if (failEvidenceOnce) { failEvidenceOnce = false; throw new Error('provider evidence write failed') }
      rows.forEach((row) => repository.stores.evidence.set(row.evidence_id, row))
    }
    await expect(persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })).rejects.toThrow(/provider evidence write failed/)
    expect(repository.stores.runs.get(plan.runId)).toMatchObject({ status: 'failed' })
    await expect(persistLivePlan({ plan, repository, env: writeEnv, now: fixedNow })).resolves.toMatchObject({ status: 'succeeded', runId: plan.runId })
    expect(repository.stores.runs).toHaveLength(1)
    expect(repository.stores.evidence.size).toBe(plan.evidence.length)
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
