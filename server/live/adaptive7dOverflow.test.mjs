import { describe, expect, it, vi } from 'vitest'
import { ADAPTIVE_7D_OVERFLOW_BATCH_SIZE, collectLiveBaselineInputs, collectLiveSharedInputs, collectLiveWindowCycle } from './liveIngestionPipeline.mjs'
import { baselineCacheKey } from './baselineCache.mjs'
import { buildLivePersistencePlan } from './livePersistence.mjs'

const at = '2026-09-14T11:04:52.000Z'
const global = { kind: 'global' }
const current = Array.from({ length: 52 }, (_, index) => ({ providerId: 'serpapi-google-trends-trending-now', query: `Current ${index + 1}`, normalizedQuery: `current ${index + 1}`, category: 'Technology', searchVolume: 10_000 - index, retrievedAt: at, geographicScope: global }))
const retained = Array.from({ length: 18 }, (_, index) => ({ providerId: 'serpapi-google-trends-trending-now', query: `Retained ${index + 1}`, normalizedQuery: `retained ${index + 1}`, category: 'Technology', retrievedAt: at, trackingOnly: true, geographicScope: global }))
const volume = (candidate) => ({ providerId: 'dataforseo-clickstream-global-search-volume', query: candidate.query, normalizedQuery: candidate.normalizedQuery, availability: 'available', searchVolume: 100, retrievedAt: at, measurementProvenance: { measurementMode: 'global', measurementLocation: global } })
const history = (candidate) => ({ providerId: 'dataforseo-trends', normalizedQuery: candidate.normalizedQuery, retrievedAt: at, observations: [], measurementProvenance: { measurementMode: 'global', measurementLocation: global }, provenance: { providerId: 'dataforseo-trends', sourceObservedAt: at, ingestedAt: at, geographicScope: global, crossQueryComparability: { status: 'not-comparable', basis: 'fixture' } } })

function shared({ reserve = current.slice(32), discovery = current.slice(0, 32) } = {}) {
  return {
    candidates: discovery, overflowReserveCandidates: reserve, volumes: discovery.map(volume), discoveryRequest: { geographicScope: global, hours: 24 },
    sharedMetrics: { providerRequests: { serpApi: 5, dataForSeoSearchVolume: 1 }, providerCosts: { searchVolume: 0.09, serpApi: 'plan-dependent' }, baselineCache: {}, cohort: { discovered: 385 } },
  }
}

function fixture({ eligible = new Set(), missing = new Set(), historyRetriever = null } = {}) {
  const retrieve = historyRetriever ?? vi.fn(async ({ candidates }) => ({ histories: candidates.filter((candidate) => !missing.has(candidate.normalizedQuery)).map(history), requestCount: 1, providerCost: 0.0012, graphMeasurements: {}, cache: null }))
  const scoreCycle = vi.fn(async ({ candidates }) => candidates.map((candidate, index) => ({ topic: candidate.topic, normalizedQuery: candidate.normalizedQuery, unifiedRawScore: eligible.has(candidate.normalizedQuery) ? 100 - index : null, raw: { globalCurrentIntensity: eligible.has(candidate.normalizedQuery) ? { value: 1 } : { value: null, reason: 'fixture' } }, components: {} })))
  const baseline = vi.fn(async (candidates) => ({ volumes: candidates.map(volume), metrics: { providerRequests: 1, providerCost: 0.09, cache: { writesSkipped: true } } }))
  return { retrieve, scoreCycle, baseline }
}

async function run({ eligible, reserve, discovery, tracking = [...current.slice(0, 32), ...retained], missing, historyRetriever, historyWindow = '7D', max = 70 } = {}) {
  const f = fixture({ eligible, missing, historyRetriever })
  const cycle = await collectLiveWindowCycle({
    sharedInputs: shared({ reserve, discovery }), paidTrackingCandidates: tracking, historyRequest: {}, historyWindow,
    trendsMode: 'batch', trendsClient: {}, historyRetriever: f.retrieve, scoreCycle: f.scoreCycle,
    displayLimit: 20, maxPaidCandidates: 50, adaptiveOverflowMaxCandidates: max,
    overflowBaselineResolver: f.baseline,
  })
  return { ...f, cycle }
}

describe('7D adaptive global overflow', () => {
  it('keeps the normal 50-topic tracking cohort unchanged when its first score already has 20 valid current topics', async () => {
    const { cycle, retrieve, baseline } = await run({ eligible: new Set(current.slice(0, 20).map((x) => x.normalizedQuery)) })
    expect(cycle.candidates).toHaveLength(50); expect(retrieve).toHaveBeenCalledTimes(1); expect(baseline).not.toHaveBeenCalled()
    expect(cycle.requestMetrics.evaluation.adaptiveOverflow).toMatchObject({ triggered: false, initialMeasured: 50, initialPublicValid: 20, finalCandidateCount: 50, stopReason: 'initial-board-complete' })
  })

  it('triggers only for a short 7D board, adds the next ten current discoveries, and stops at 60 when they fill 20', async () => {
    const eligible = new Set([...current.slice(0, 14), ...current.slice(32, 38)].map((x) => x.normalizedQuery))
    const { cycle, retrieve, baseline } = await run({ eligible })
    const overflow = cycle.requestMetrics.evaluation.adaptiveOverflow
    expect(retrieve).toHaveBeenCalledTimes(2); expect(baseline).toHaveBeenCalledTimes(1); expect(baseline).toHaveBeenCalledWith(current.slice(32, 42))
    expect(cycle.candidates).toHaveLength(60); expect(cycle.scores.filter((x) => Number.isFinite(x.unifiedRawScore))).toHaveLength(20)
    expect(overflow).toMatchObject({ triggered: true, initialPublicValid: 14, finalCandidateCount: 60, finalPublicValid: 20, stopReason: 'public-board-complete', incrementalProviderRequests: { dataForSeoSearchVolume: 1, dataForSeoTrends: 1 }, incrementalProviderCost: { searchVolume: 0.09, trends: 0.0012, total: 0.0912 } })
    expect(overflow.batches).toEqual([expect.objectContaining({ candidateCount: 10, publicValid: 20, candidates: current.slice(32, 42).map((x) => x.normalizedQuery) })])
  })

  it('continues one more deterministic batch and stops at the hard 70 maximum without lowering the public guard', async () => {
    const eligible = new Set([...current.slice(0, 14), ...current.slice(32, 35), ...current.slice(42, 45)].map((x) => x.normalizedQuery))
    const { cycle, retrieve, baseline } = await run({ eligible })
    const overflow = cycle.requestMetrics.evaluation.adaptiveOverflow
    expect(cycle.candidates).toHaveLength(70); expect(retrieve).toHaveBeenCalledTimes(3); expect(baseline).toHaveBeenCalledTimes(2)
    expect(overflow).toMatchObject({ finalPublicValid: 20, finalCandidateCount: 70, stopReason: 'public-board-complete' })
    expect(overflow.batches.map((batch) => batch.candidates)).toEqual([current.slice(32, 42).map((x) => x.normalizedQuery), current.slice(42, 52).map((x) => x.normalizedQuery)])
  })

  it('reports an insufficient result and leaves persistence publication rejected when even 70 cannot fill 20', async () => {
    const { cycle } = await run({ eligible: new Set(current.slice(0, 14).map((x) => x.normalizedQuery)) })
    const plan = buildLivePersistencePlan({ cycleId: 'adaptive-7d-partial', historyWindow: '7D', displayLimit: 20, scoredAt: at, candidates: cycle.candidates, volumes: cycle.volumes, histories: cycle.histories, scores: cycle.scores.map((score) => ({ ...score, nowScore: score.unifiedRawScore, components: {}, componentDiagnostics: {}, history: {}, topicClassification: 'fixture', confidence: 'fixture', confidenceReason: 'fixture', evidenceStatus: 'fixture' })) })
    expect(cycle.requestMetrics.evaluation.adaptiveOverflow).toMatchObject({ finalCandidateCount: 70, finalPublicValid: 14, stopReason: 'adaptive-maximum-reached' })
    expect(plan.publication).toMatchObject({ publishable: false, requiredCount: 20, availableCount: 14 })
  })

  it('never adds retained-only continuity topics to public scoring and excludes them from the reserve', async () => {
    const { cycle } = await run({ eligible: new Set([...current.slice(0, 14), ...current.slice(32, 38)].map((x) => x.normalizedQuery)), reserve: [retained[0], ...current.slice(32)] })
    expect(cycle.scoringCandidates.map((x) => x.normalizedQuery)).not.toContain(retained[0].normalizedQuery)
    expect(cycle.requestMetrics.evaluation.adaptiveOverflow.batches[0].candidates).toEqual(current.slice(32, 42).map((x) => x.normalizedQuery))
  })

  it('does not trigger overflow for 24H, 30D, or 1Y and leaves their history/scoring behavior unchanged', async () => {
    for (const historyWindow of ['24H', '30D', '1Y']) {
      const { cycle, retrieve, baseline } = await run({ historyWindow, eligible: new Set(current.slice(0, 14).map((x) => x.normalizedQuery)) })
      expect(cycle.candidates).toHaveLength(50); expect(retrieve).toHaveBeenCalledTimes(1); expect(baseline).not.toHaveBeenCalled()
      expect(cycle.requestMetrics.evaluation.adaptiveOverflow).toMatchObject({ enabled: false, triggered: false, stopReason: 'not-applicable' })
    }
  })

  it('does not duplicate reserve candidates, preserves discovery order, and requests baseline/history only for each triggered batch', async () => {
    const reserve = [current[32], current[32], current[33], ...current.slice(34, 52)]
    const eligible = new Set([...current.slice(0, 14), ...current.slice(32, 38)].map((x) => x.normalizedQuery))
    const { cycle, baseline, retrieve } = await run({ eligible, reserve })
    expect(cycle.candidates.map((x) => x.normalizedQuery)).toHaveLength(new Set(cycle.candidates.map((x) => x.normalizedQuery)).size)
    expect(baseline.mock.calls[0][0].map((x) => x.normalizedQuery)).toEqual(current.slice(32, 42).map((x) => x.normalizedQuery))
    expect(retrieve.mock.calls[1][0].candidates.map((x) => x.normalizedQuery)).toEqual(current.slice(32, 42).map((x) => x.normalizedQuery))
  })

  it('counts missing history as not measured, continues safely, and never scores it as a public candidate', async () => {
    const missing = new Set([current[32].normalizedQuery])
    const eligible = new Set([...current.slice(0, 14), ...current.slice(33, 40)].map((x) => x.normalizedQuery))
    const { cycle } = await run({ eligible, missing })
    expect(cycle.histories.map((x) => x.normalizedQuery)).not.toContain(current[32].normalizedQuery)
    expect(cycle.scores.map((x) => x.normalizedQuery)).not.toContain(current[32].normalizedQuery)
    expect(cycle.requestMetrics.evaluation.adaptiveOverflow.batches[0].measured).toBe(9)
  })

  it('uses the shared batch-size constant and fails closed when the configured 7D maximum is outside the bounded range', async () => {
    expect(ADAPTIVE_7D_OVERFLOW_BATCH_SIZE).toBe(10)
    await expect(run({ eligible: new Set(), max: 71 })).rejects.toThrow(/maximum must be between 50 and 70/)
  })

  it('fails closed instead of measuring an overflow batch without the shared baseline-cache resolver', async () => {
    const f = fixture({ eligible: new Set() })
    await expect(collectLiveWindowCycle({ sharedInputs: shared(), paidTrackingCandidates: [...current.slice(0, 32), ...retained], historyRequest: {}, historyWindow: '7D', trendsMode: 'batch', trendsClient: {}, historyRetriever: f.retrieve, scoreCycle: f.scoreCycle, displayLimit: 20, maxPaidCandidates: 50, adaptiveOverflowMaxCandidates: 70 })).rejects.toThrow(/requires the baseline cache resolver/)
    expect(f.retrieve).toHaveBeenCalledTimes(1)
  })

  it('preserves raw ranked current-discovery reserve beyond the unchanged initial 50 without prefetching its baseline', async () => {
    const discovered = Array.from({ length: 70 }, (_, index) => ({ ...current[index % current.length], query: `Discovery ${index + 1}`, normalizedQuery: `discovery ${index + 1}`, searchVolume: 1_000 - index, providerDiscoveryRank: index + 1 }))
    const list = vi.fn(async ({ cacheKeys }) => cacheKeys.map((cache_key) => ({ cache_key, availability: 'available', search_volume: 1, monthly_history: [], retrieved_at: at })))
    const lookup = vi.fn()
    const result = await collectLiveSharedInputs({ candidateLimit: 50, discoveryLimit: 50, maxPaidCandidates: 50, adaptiveOverflowMaxCandidates: 70, discoveryRequest: { geographicScope: global }, volumeRequest: { providerId: 'volume', geographicScope: global }, discoveryClient: { discover: vi.fn(async () => discovered) }, volumeClient: { providerId: 'volume', lookup }, baselineCacheRepository: { listLiveBaselineDemandCache: list } })
    expect(result.candidates).toHaveLength(50); expect(result.overflowReserveCandidates.map((x) => x.normalizedQuery)).toEqual(discovered.slice(50, 70).map((x) => x.normalizedQuery))
    expect(lookup).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledWith({ cacheKeys: discovered.slice(0, 50).map((x) => baselineCacheKey(x.normalizedQuery, { providerId: 'volume', geographicScope: global })) })
  })

  it('uses fresh baseline cache rows without a provider call or cache write in dry/no-write mode', async () => {
    const candidate = current[32]
    const request = { providerId: 'volume', geographicScope: global }
    const upsert = vi.fn()
    const result = await collectLiveBaselineInputs({ candidates: [candidate], volumeRequest: request, volumeClient: { providerId: 'volume', lookup: vi.fn() }, baselineCacheRepository: { listLiveBaselineDemandCache: vi.fn(async () => [{ cache_key: baselineCacheKey(candidate.normalizedQuery, request), availability: 'available', search_volume: 1, monthly_history: [], retrieved_at: at }]), upsertLiveBaselineDemandCache: upsert }, writeBaselineCache: false })
    expect(result.metrics).toMatchObject({ providerRequests: 0, providerCost: 0, cache: { freshHits: 1, writesSkipped: true } })
    expect(upsert).not.toHaveBeenCalled()
  })
})
