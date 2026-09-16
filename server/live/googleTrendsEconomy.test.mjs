import { describe, expect, it, vi } from 'vitest'
import { buildGoogleTrendsBatches, retrieveGoogleTrendsHistories } from './googleTrendsHistoryRetrieval.mjs'
import { classifyGoogleTrendsHistoryCache, googleTrendsHistoryCacheKey, hasValidGoogleTrendsCacheProvenance } from './googleTrendsCache.mjs'
import { readFileSync } from 'node:fs'
import { buildCanonicalAttentionPersistencePlan } from './canonicalAttentionPersistence.mjs'

const scope = { kind: 'global' }
const request = { timeRange: 'past_day', measurementMode: 'global', measurementTarget: { mode: 'common-global' } }
const candidates = Array.from({ length: 50 }, (_, index) => ({ query: `Topic ${String(index + 1).padStart(2, '0')}`, normalizedQuery: `topic ${String(index + 1).padStart(2, '0')}`, category: 'Technology' }))
function response(keywords) { return { tasks: [{ status_code: 20000, cost: .011, result: [{ location_code: null, language_code: 'en', items: [{ type: 'google_trends_graph', keywords, data: Array.from({ length: 181 }, (_, index) => ({ timestamp: 1_789_084_800 + index * 480, values: keywords.map((_, keywordIndex) => 10 + keywordIndex) })) }] }] }] } }

describe('economical global Google Trends history', () => {
  it('makes exactly ten deterministic five-keyword batches for fifty candidates and retains a final short batch', () => {
    expect(buildGoogleTrendsBatches(candidates)).toHaveLength(10)
    expect(buildGoogleTrendsBatches(candidates).every((batch) => batch.candidates.length === 5)).toBe(true)
    expect(buildGoogleTrendsBatches(candidates.slice(0, 12)).map((batch) => batch.candidates.length)).toEqual([5, 5, 2])
  })

  it('sends sixteen distinct canonical candidates in exactly four provider requests of at most five keywords', async () => {
    const explore = vi.fn(async ({ keywords }) => ({ task: { keywords, time_range: 'past_day' }, response: response(keywords), retrievedAt: '2026-09-14T00:00:00Z' }))
    const result = await retrieveGoogleTrendsHistories({ candidates: candidates.slice(0, 16), client: { explore }, request, geographicScope: scope })
    expect(explore).toHaveBeenCalledTimes(4)
    expect(explore.mock.calls.map(([input]) => input.keywords.length)).toEqual([5, 5, 5, 1])
    expect(explore.mock.calls.flatMap(([input]) => input.keywords)).toHaveLength(16)
    expect(result.histories).toHaveLength(16)
    const multiKeywordHistories = result.histories.filter((history) => history.batch)
    expect(multiKeywordHistories).toHaveLength(15)
    expect(multiKeywordHistories.every((history) => history.provenance.crossQueryComparability.status === 'not-comparable')).toBe(true)
    expect(result.histories.find((history) => !history.batch).provenance.crossQueryComparability.status).toBe('comparable')
    expect(new Set(multiKeywordHistories.map((history) => history.batch.fingerprint)).size).toBe(3)
  })

  it('rejects a canonical identity collision rather than merging candidates', () => {
    expect(() => buildGoogleTrendsBatches([candidates[0], { ...candidates[0], query: 'Different spelling' }])).toThrow(/identity collision/i)
  })

  it('deduplicates an exact provider lookup while retaining distinct canonical candidates', () => {
    const batches = buildGoogleTrendsBatches([
      { query: 'Bitcoin', normalizedQuery: 'bitcoin' },
      { query: ' bitcoin ', normalizedQuery: 'bitcoin-news' },
    ])
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ keywords: ['Bitcoin'], candidates: [{ normalizedQuery: 'bitcoin' }, { normalizedQuery: 'bitcoin-news' }] })
    expect(batches[0].requestMap).toEqual([expect.objectContaining({
      requestIndex: 0,
      providerKeyword: 'Bitcoin',
      canonicalCandidates: [
        { canonicalCandidateIdentity: 'bitcoin', canonicalQuery: 'Bitcoin' },
        { canonicalCandidateIdentity: 'bitcoin-news', canonicalQuery: ' bitcoin ' },
      ],
    })])
  })

  it('maps every graph column back to its exact canonical candidate and batch keyword index', async () => {
    const explore = vi.fn(async ({ keywords }) => ({ task: { keywords, time_range: 'past_day' }, response: response(keywords), retrievedAt: '2026-09-14T00:00:00Z' }))
    const result = await retrieveGoogleTrendsHistories({ candidates: candidates.slice(0, 5), client: { explore }, request, geographicScope: scope })
    expect(explore).toHaveBeenCalledTimes(1); expect(result.histories).toHaveLength(5)
    expect(result.histories.map((history) => [history.normalizedQuery, history.batch.keywordIndex, history.batch.providerKeyword])).toEqual(candidates.slice(0, 5).map((candidate, index) => [candidate.normalizedQuery, index, candidate.query]))
    expect(new Set(result.histories.map((history) => history.normalizedQuery)).size).toBe(5)
    expect(result.histories.every((history) => history.measurementProvenance.measurementMode === 'global')).toBe(true)
  })

  it('fans one proven provider curve out to duplicate canonical candidates without adding a request', async () => {
    const duplicateCandidates = [
      { query: 'Bitcoin', normalizedQuery: 'bitcoin', category: 'Finance' },
      { query: ' bitcoin ', normalizedQuery: 'bitcoin-news', category: 'News & Politics' },
    ]
    const explore = vi.fn(async ({ keywords }) => ({ task: { keywords, time_range: 'past_day' }, response: response(['bitcoin']), retrievedAt: '2026-09-14T00:00:00Z' }))
    const result = await retrieveGoogleTrendsHistories({ candidates: duplicateCandidates, client: { explore }, request, geographicScope: scope })
    expect(explore).toHaveBeenCalledTimes(1)
    expect(explore).toHaveBeenCalledWith(expect.objectContaining({ keywords: ['Bitcoin'] }))
    expect(result.histories.map((history) => history.normalizedQuery)).toEqual(['bitcoin', 'bitcoin-news'])
    expect(result.histories.map((history) => history.rawProviderObservations[0].rawProviderValue)).toEqual([10, 10])
    expect(result.histories.map((history) => [history.batch.requestIndex, history.batch.canonicalCandidateIdentity])).toEqual([[0, 'bitcoin'], [0, 'bitcoin-news']])
  })

  it('reuses only a fresh global cache identity and never turns missing history into zero', () => {
    const key = googleTrendsHistoryCacheKey({ normalizedQuery: candidates[0].normalizedQuery, providerId: 'dataforseo-google-trends', measurementMode: 'global', measurementTarget: request.measurementTarget, timeRange: 'past_day' })
    const cachedRows = [{ cache_key: key, retrieved_at: '2026-09-14T00:00:00Z', history: { normalizedQuery: candidates[0].normalizedQuery, provenance: { providerId: 'dataforseo-google-trends', crossQueryComparability: { status: 'comparable' } }, observations: [{ availability: 'missing', interest: null }] } }]
    const fresh = classifyGoogleTrendsHistoryCache({ candidates: [candidates[0]], cachedRows, request, now: new Date('2026-09-14T07:59:59Z') })
    const stale = classifyGoogleTrendsHistoryCache({ candidates: [candidates[0]], cachedRows, request, now: new Date('2026-09-14T08:00:00Z') })
    expect(fresh.fresh).toHaveLength(1); expect(stale.refresh).toHaveLength(1)
    expect(cachedRows[0].history.observations[0]).toEqual({ availability: 'missing', interest: null })
    const us = classifyGoogleTrendsHistoryCache({ candidates: [candidates[0]], cachedRows, request: { ...request, measurementMode: 'us', measurementTarget: { country: 'US' } }, now: new Date('2026-09-14T01:00:00Z') })
    expect(us.fresh).toHaveLength(0)
  })

  it('revalidates a cached batched provider echo before rehydration without changing batch identity', () => {
    const history = {
      normalizedQuery: 'trump-5000',
      provenance: { providerId: 'dataforseo-google-trends', crossQueryComparability: { status: 'not-comparable' } },
      batch: { providerKeyword: 'Trump $5,000', returnedProviderKeyword: 'trump $5000', fingerprint: 'existing-fingerprint' },
      observations: [],
    }
    expect(hasValidGoogleTrendsCacheProvenance(history)).toBe(true)
    expect(history.batch.fingerprint).toBe('existing-fingerprint')
    expect(hasValidGoogleTrendsCacheProvenance({ ...history, batch: { ...history.batch, returnedProviderKeyword: 'unrelated keyword' } })).toBe(false)
  })

  it('fails closed on a fresh cache row with the retired provenance value and remeasures it locally', async () => {
    const key = googleTrendsHistoryCacheKey({ normalizedQuery: candidates[0].normalizedQuery, providerId: 'dataforseo-google-trends', measurementMode: 'global', measurementTarget: request.measurementTarget, timeRange: 'past_day' })
    const retiredHistory = {
      normalizedQuery: candidates[0].normalizedQuery,
      provenance: { providerId: 'dataforseo-google-trends', crossQueryComparability: { status: 'not-comparable-across-batches' } },
      observations: [],
    }
    expect(hasValidGoogleTrendsCacheProvenance(retiredHistory)).toBe(false)
    expect(classifyGoogleTrendsHistoryCache({ candidates: [candidates[0]], cachedRows: [{ cache_key: key, retrieved_at: '2026-09-14T00:00:00Z', history: retiredHistory }], request, now: new Date('2026-09-14T04:00:00Z') })).toMatchObject({ fresh: [], refresh: [expect.objectContaining({ candidate: candidates[0] })] })
    const explore = vi.fn(async ({ keywords }) => ({ task: { keywords, time_range: 'past_day' }, response: response(keywords), retrievedAt: '2026-09-14T04:00:00Z' }))
    const result = await retrieveGoogleTrendsHistories({ candidates: candidates.slice(0, 2), client: { explore }, request, geographicScope: scope, cacheRepository: { listLiveGoogleTrendsHistoryCache: async () => [{ cache_key: key, retrieved_at: '2026-09-14T00:00:00Z', history: retiredHistory }] }, writeCache: false, now: new Date('2026-09-14T04:00:00Z') })
    expect(explore).toHaveBeenCalledTimes(1)
    expect(result.histories.every((history) => history.provenance.crossQueryComparability.status === 'not-comparable')).toBe(true)
  })

  it('contains no retired provenance literal in the Google Trends production path', () => {
    const runtimeFiles = [
      'server/live/dataForSeoGoogleTrends.mjs',
      'server/live/googleTrendsHistoryRetrieval.mjs',
      'server/live/googleTrendsCache.mjs',
      'server/live/canonicalAttentionPersistence.mjs',
      'server/live/livePersistence.mjs',
    ]
    expect(runtimeFiles.map((file) => readFileSync(file, 'utf8')).join('\n')).not.toContain('not-comparable-across-batches')
  })

  it('avoids all paid Trends requests inside the eight-hour cache freshness window', async () => {
    const key = googleTrendsHistoryCacheKey({ normalizedQuery: candidates[0].normalizedQuery, providerId: 'dataforseo-google-trends', measurementMode: 'global', measurementTarget: request.measurementTarget, timeRange: 'past_day' })
    const cache = { listLiveGoogleTrendsHistoryCache: vi.fn(async () => [{ cache_key: key, retrieved_at: '2026-09-14T00:00:00Z', history: { normalizedQuery: candidates[0].normalizedQuery, topic: candidates[0].query, provenance: { providerId: 'dataforseo-google-trends', crossQueryComparability: { status: 'comparable' } }, observations: [] } }]) }
    const explore = vi.fn()
    const result = await retrieveGoogleTrendsHistories({ candidates: [candidates[0]], client: { explore }, request, geographicScope: scope, cacheRepository: cache, now: new Date('2026-09-14T04:00:00Z') })
    expect(explore).not.toHaveBeenCalled(); expect(result.requestCount).toBe(0); expect(result.cache.freshHits).toBe(1)
  })

  it('uses no cache repository operation when the caller supplies the dry-run no-cache path', async () => {
    const explore = vi.fn(async ({ keywords }) => ({ task: { keywords, time_range: 'past_day' }, response: response(keywords), retrievedAt: '2026-09-14T00:00:00Z' }))
    const result = await retrieveGoogleTrendsHistories({ candidates: [candidates[0]], client: { explore }, request, geographicScope: scope, cacheRepository: null, writeCache: false })
    expect(result.cache).toMatchObject({ writesSkipped: true, freshHits: 0 }); expect(explore).toHaveBeenCalledTimes(1)
  })

  it('starts a new canonical compatibility series when a candidate batch composition changes', async () => {
    const client = { explore: async ({ keywords }) => ({ task: { keywords, time_range: 'past_day' }, response: response(keywords), retrievedAt: '2026-09-14T00:00:00Z' }) }
    const ids = new Map(candidates.map((candidate) => [candidate.normalizedQuery, `id:${candidate.normalizedQuery}`]))
    const first = await retrieveGoogleTrendsHistories({ candidates: candidates.slice(0, 5), client, request, geographicScope: scope })
    const initial = buildCanonicalAttentionPersistencePlan({ histories: first.histories, candidateIdByQuery: ids, runId: 'first', scoredAt: '2026-09-14T00:00:00Z' })
    const changed = await retrieveGoogleTrendsHistories({ candidates: [candidates[0], ...candidates.slice(5, 9)], client, request, geographicScope: scope })
    const later = buildCanonicalAttentionPersistencePlan({ histories: changed.histories, candidateIdByQuery: ids, existingByQuery: new Map([[candidates[0].normalizedQuery, initial.points.filter((point) => point.candidate_id === ids.get(candidates[0].normalizedQuery))]]), runId: 'second', scoredAt: '2026-09-14T08:00:00Z' })
    const firstSeries = initial.points.find((point) => point.candidate_id === ids.get(candidates[0].normalizedQuery)).series_key
    const laterSeries = later.points.find((point) => point.candidate_id === ids.get(candidates[0].normalizedQuery)).series_key
    expect(laterSeries).not.toBe(firstSeries)
  })

  it('keeps batch membership and canonical compatibility stable when input order changes', async () => {
    const firstBatch = buildGoogleTrendsBatches(candidates.slice(0, 5))[0]
    const reversedBatch = buildGoogleTrendsBatches([...candidates.slice(0, 5)].reverse())[0]
    expect(reversedBatch.fingerprint).toBe(firstBatch.fingerprint)
    expect(reversedBatch.requestMap).toEqual(firstBatch.requestMap)
    const client = { explore: async ({ keywords }) => ({ task: { keywords, time_range: 'past_day' }, response: response(keywords), retrievedAt: '2026-09-14T00:00:00Z' }) }
    const ids = new Map(candidates.map((candidate) => [candidate.normalizedQuery, `id:${candidate.normalizedQuery}`]))
    const first = await retrieveGoogleTrendsHistories({ candidates: candidates.slice(0, 5), client, request, geographicScope: scope })
    const second = await retrieveGoogleTrendsHistories({ candidates: [...candidates.slice(0, 5)].reverse(), client, request, geographicScope: scope })
    const firstPlan = buildCanonicalAttentionPersistencePlan({ histories: first.histories, candidateIdByQuery: ids, runId: 'first-order', scoredAt: '2026-09-14T00:00:00Z' })
    const secondPlan = buildCanonicalAttentionPersistencePlan({ histories: second.histories, candidateIdByQuery: ids, runId: 'second-order', scoredAt: '2026-09-14T08:00:00Z' })
    expect(secondPlan.points.map((point) => point.series_key).sort()).toEqual(firstPlan.points.map((point) => point.series_key).sort())
  })

  it('does not write the Trends cache when one response batch fails closed', async () => {
    const cache = {
      listLiveGoogleTrendsHistoryCache: vi.fn(async () => []),
      upsertLiveGoogleTrendsHistoryCache: vi.fn(),
    }
    const client = {
      explore: async ({ keywords }) => ({
        task: { keywords, time_range: 'past_day' },
        response: { tasks: [{ status_code: 20000, result: [{ items: [{ type: 'google_trends_graph', keywords: ['unexpected'], data: [{ timestamp: 1_789_084_800, values: [10] }] }] }] }] },
        retrievedAt: '2026-09-14T00:00:00Z',
      }),
    }
    await expect(retrieveGoogleTrendsHistories({ candidates: candidates.slice(0, 5), client, request, geographicScope: scope, cacheRepository: cache, writeCache: true })).rejects.toThrow(/keyword count|unexpected keyword/i)
    expect(cache.upsertLiveGoogleTrendsHistoryCache).not.toHaveBeenCalled()
  })
})
