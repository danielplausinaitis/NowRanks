import { describe, expect, it, vi } from 'vitest'
import { assessDataForSeoBatchComparability, assertGlobalDataForSeoComparable } from './comparability.mjs'
import { buildDataForSeoExploreTask, createDataForSeoTrendsClient, normalizeDataForSeoMeasurement } from './dataForSeoTrends.mjs'
import { createLiveTrendProviderAdapter, LiveProviderError } from './providerAdapter.mjs'
import { buildSerpApiTrendingNowUrl, createSerpApiTrendingNowClient, mapSerpApiCategory, normalizeSerpApiTrendingNow, requireSerpApiApiKey } from './serpApiTrendingNow.mjs'

const geography = { kind: 'country', countryCode: 'US' }
const serpResponse = {
  search_metadata: { id: 'search-123', status: 'Success' },
  trending_searches: [
    { query: ' Space   Launch ', start_timestamp: 1_724_608_000, end_timestamp: 1_724_611_600, active: false, search_volume: 500_000, increase_percentage: 900, categories: [{ id: 18, name: 'Technology' }], trend_breakdown: ['launch time'] },
    { query: 'space launch', categories: [{ id: 999, name: 'Mystery vertical' }] },
  ],
}
const dataForSeoResponse = {
  status_code: 20000,
  tasks: [{ status_code: 20000, result: [{ items: [{ type: 'dataforseo_trends_graph', keywords: ['Space Launch', 'Orbit'], data: [
    { timestamp: 1_724_608_000, values: [65, 0] }, { timestamp: 1_724_694_400, values: [70, 12] },
  ] }] }] }],
}

function adapter() {
  return createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends', mapCategory: (category) => category })
}

describe('SerpApi Trending Now server transport', () => {
  it('builds the documented endpoint with explicit discovery controls and keeps the key server-side', () => {
    const url = new URL(buildSerpApiTrendingNowUrl({ apiKey: 'secret', geo: 'US', hours: 24, language: 'en', onlyActive: true, categoryId: 18 }))
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search.json')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ engine: 'google_trends_trending_now', geo: 'US', hours: '24', hl: 'en', only_active: 'true', category_id: '18', api_key: 'secret' })
    expect(() => requireSerpApiApiKey({ VITE_SERPAPI_API_KEY: 'browser-secret' })).toThrow(/SERPAPI_API_KEY is required/)
  })

  it('normalizes and deduplicates mocked discovery results with explicit unknown categories', () => {
    const candidates = normalizeSerpApiTrendingNow(serpResponse, { retrievedAt: '2026-08-26T00:00:00.000Z', geographicScope: geography })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ query: 'Space   Launch', normalizedQuery: 'space launch', category: 'Technology', categories: ['Technology'], searchVolume: 500000, increasePercentage: 900, active: false, startedAt: '2024-08-25T17:46:40.000Z', endedAt: '2024-08-25T18:46:40.000Z', relatedQueries: ['launch time'], retrievedAt: '2026-08-26T00:00:00.000Z', geographicScope: geography })
    expect(mapSerpApiCategory('Mystery vertical')).toBeNull()
  })

  it('surfaces sanitized authentication/provider failures without returning the request URL or key', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'authorization=sb_secret_should_not_leak' }) }))
    const client = createSerpApiTrendingNowClient({ env: { SERPAPI_API_KEY: 'private-key' }, fetchImpl })
    await expect(client.discover({ geo: 'US', geographicScope: geography })).rejects.toBeInstanceOf(LiveProviderError)
    try { await client.discover({ geo: 'US', geographicScope: geography }) } catch (error) {
      expect(error.message).not.toContain('sb_secret_should_not_leak')
      expect(error.message).not.toContain('private-key')
    }
  })

  it('preserves safe Node fetch cause diagnostics without leaking credentials', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND serpapi.com'), { code: 'ENOTFOUND' })
    const fetchImpl = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause }) })
    const client = createSerpApiTrendingNowClient({ env: { SERPAPI_API_KEY: 'private-key' }, fetchImpl })

    await expect(client.discover({ geo: 'US', geographicScope: geography })).rejects.toThrow(/code: ENOTFOUND/)
    try { await client.discover({ geo: 'US', geographicScope: geography }) } catch (error) {
      expect(error.message).toContain('getaddrinfo ENOTFOUND serpapi.com')
      expect(error.message).not.toContain('private-key')
    }
  })
})

describe('DataForSEO Trends server transport', () => {
  it('uses Basic auth and a one-task POST without leaking credentials', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => dataForSeoResponse }))
    const client = createDataForSeoTrendsClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl, now: () => '2026-08-26T00:05:00.000Z' })
    const result = await client.measure({ keywords: ['Space Launch', 'Orbit'], locationCode: 2840, dateFrom: '2024-08-01', dateTo: '2024-08-31' })
    expect(result.task).toEqual({ keywords: ['Space Launch', 'Orbit'], location_code: 2840, date_from: '2024-08-01', date_to: '2024-08-31' })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.dataforseo.com/v3/keywords_data/dataforseo_trends/explore/live', expect.objectContaining({ method: 'POST', body: JSON.stringify([result.task]), headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from('login:password').toString('base64')}` }) }))
    expect(JSON.stringify(result)).not.toContain('password')
  })

  it('requires credentials and enforces the five-keyword and explicit-location limits', async () => {
    const client = createDataForSeoTrendsClient({ env: {} })
    await expect(client.measure({ keywords: ['one'], locationCode: 1 })).rejects.toThrow(/DATAFORSEO_LOGIN/)
    const browserOnlyClient = createDataForSeoTrendsClient({ env: { VITE_DATAFORSEO_LOGIN: 'browser-login', VITE_DATAFORSEO_PASSWORD: 'browser-password' } })
    await expect(browserOnlyClient.measure({ keywords: ['one'], locationCode: 1 })).rejects.toThrow(/DATAFORSEO_LOGIN/)
    expect(() => buildDataForSeoExploreTask({ keywords: ['1', '2', '3', '4', '5', '6'], locationCode: 1 })).toThrow(/one to 5/i)
    expect(() => buildDataForSeoExploreTask({ keywords: ['one'], locationCode: 1, locationName: 'United States' })).toThrow(/exactly one explicit/i)
    expect(buildDataForSeoExploreTask({ keywords: ['one'], locationCode: 1, timeRange: 'past_12_months' }))
      .toMatchObject({ time_range: 'past_12_months' })
    expect(() => buildDataForSeoExploreTask({ keywords: ['one'], locationCode: 1, timeRange: 'past_day', dateFrom: '2026-01-01' }))
      .toThrow(/cannot be combined/)
  })

  it('normalizes one mocked provider batch through the live adapter, preserving positive values and documented zero-as-missing', () => {
    const response = structuredClone(dataForSeoResponse)
    response.tasks[0].result[0].items[0].data[0].date_from = '2024-08-26'
    response.tasks[0].result[0].items[0].data[0].date_to = '2024-09-01'
    const data = normalizeDataForSeoMeasurement({ response, candidates: [
      { sourceId: 'serp:space', query: 'Space Launch', normalizedQuery: 'space launch', category: 'Technology' },
      { sourceId: 'serp:orbit', query: 'Orbit', normalizedQuery: 'orbit', category: 'Technology' },
    ], geographicScope: geography, retrievedAt: '2026-08-26T00:05:00.000Z', adapter: adapter(), requestMetadata: { time_range: 'past_12_months' } })
    expect(data[0].provenance).toMatchObject({ providerId: 'dataforseo-trends', dataMode: 'live', geographicScope: geography, crossQueryComparability: { status: 'comparable' } })
    expect(data[0].observations[0]).toMatchObject({ availability: 'available', interest: 65 })
    expect(data[1].observations[0]).toMatchObject({ availability: 'missing', interest: null, missingReason: 'out-of-range' })
    expect(data[0]).toMatchObject({ historyRequest: { timeRange: 'past_12_months', dateFrom: null, dateTo: null }, retrievedAt: '2026-08-26T00:05:00.000Z' })
    expect(data[0].observations[0]).toMatchObject({ providerBucketStart: '2024-08-26', providerBucketEnd: '2024-09-01' })
  })

  it('rejects malformed responses, including valid result envelopes without a trends graph, and sanitizes provider errors', async () => {
    expect(() => normalizeDataForSeoMeasurement({ response: { status_code: 20000, tasks: [] }, candidates: [{ query: 'One', normalizedQuery: 'one', category: 'Technology' }], geographicScope: geography, retrievedAt: '2026-08-26T00:05:00.000Z', adapter: adapter() })).toThrow(/one successful task/i)
    const noGraph = structuredClone(dataForSeoResponse)
    noGraph.tasks[0].result[0].items = [{ type: 'dataforseo_trends_map' }]
    expect(() => normalizeDataForSeoMeasurement({ response: noGraph, candidates: [{ query: 'Space Launch', normalizedQuery: 'space launch', category: 'Technology' }, { query: 'Orbit', normalizedQuery: 'orbit', category: 'Technology' }], geographicScope: geography, retrievedAt: '2026-08-26T00:05:00.000Z', adapter: adapter() })).toThrow(/structurally valid.*no dataforseo_trends_graph/i)
    const client = createDataForSeoTrendsClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl: async () => { throw new Error('password=secret-value') } })
    await expect(client.measure({ keywords: ['One'], locationCode: 1 })).rejects.toBeInstanceOf(LiveProviderError)
  })

  it('preserves safe envelope diagnostics when Ok. masks a task failure or graph is missing', async () => {
    const failed = { status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 40602, status_message: 'bad task', result: null }] }
    const noGraph = structuredClone(dataForSeoResponse); noGraph.tasks[0].result[0].items = []
    for (const body of [failed, noGraph]) {
      const client = createDataForSeoTrendsClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) })
      await expect(client.measure({ keywords: ['One'], locationCode: 1 })).rejects.toThrow(/top-level status_code=20000.*task status_code=/s)
    }
  })
})

describe('DataForSEO cross-batch comparability guard', () => {
  it('allows only one provider-normalized keyword set for scoring and rejects anchor assumptions across batches', () => {
    expect(assessDataForSeoBatchComparability(1)).toMatchObject({ status: 'comparable', scope: 'single-batch' })
    expect(assessDataForSeoBatchComparability(2)).toMatchObject({ status: 'not-comparable', scope: 'multi-batch' })
    expect(() => assertGlobalDataForSeoComparable(2)).toThrow(/cannot be used for global scoring/i)
  })
})
