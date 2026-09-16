import { describe, expect, it, vi } from 'vitest'
import { DATAFORSEO_GOOGLE_TRENDS_EXPLORE_LIVE_ENDPOINT, DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASK_POST_ENDPOINT, DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASKS_READY_ENDPOINT, buildDataForSeoGoogleTrendsExploreTask, createDataForSeoGoogleTrendsClient, createDataForSeoGoogleTrendsStandardClient, googleTrendsProviderReportedCost, inspectDataForSeoGoogleTrendsResponse, mapGoogleTrendsGraphKeywordColumns, normalizeDataForSeoGoogleTrendsMeasurement, normalizeGoogleTrendsProviderEchoKeyword } from './dataForSeoGoogleTrends.mjs'
import { LiveProviderError } from './providerAdapter.mjs'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'

function responseFor(values = [8, 0, null, 33]) {
  return {
    status_code: 20000,
    tasks: [{ status_code: 20000, status_message: 'Ok.', cost: 0.012, result: [{
      location_code: null,
      language_code: 'en',
      items: [{ type: 'google_trends_graph', keywords: ['iphone'], data: values.map((value, index) => ({ timestamp: 1_789_084_800 + index * 3_600, values: [value] })) }],
    }] }],
  }
}

function batchedResponse(keywords, rows) {
  return { tasks: [{ status_code: 20000, result: [{ location_code: null, language_code: 'en', items: [{ type: 'google_trends_graph', keywords, data: rows.map((values, index) => ({ timestamp: 1_789_084_800 + index * 480, values })) }] }] }] }
}
const batchCandidates = [
  { query: 'Bitcoin', normalizedQuery: 'bitcoin', category: 'Finance' },
  { query: 'iPhone', normalizedQuery: 'iphone', category: 'Technology' },
  { query: 'Android', normalizedQuery: 'android', category: 'Technology' },
]
function normalizeBatch(keywords, rows) {
  return normalizeDataForSeoGoogleTrendsMeasurement({ response: batchedResponse(keywords, rows), candidates: batchCandidates, geographicScope: { kind: 'global' }, retrievedAt: '2026-09-14T00:00:00Z', adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-google-trends' }), requestMetadata: { time_range: 'past_day', measurementMode: 'global' }, batch: { id: 'batch', fingerprint: 'stable-fingerprint' } })
}

describe('isolated DataForSEO Google Trends experiment transport', () => {
  it('builds an intentional global past_day request without a location', () => {
    expect(buildDataForSeoGoogleTrendsExploreTask({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global' }))
      .toEqual({ keywords: ['iphone'], time_range: 'past_day', item_types: ['google_trends_graph'] })
  })

  it('requires an explicit location for a country request', () => {
    expect(buildDataForSeoGoogleTrendsExploreTask({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'country', locationCode: 2840 }))
      .toMatchObject({ location_code: 2840, time_range: 'past_day' })
    expect(() => buildDataForSeoGoogleTrendsExploreTask({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'country' }))
      .toThrow(/exactly one location/i)
    expect(() => buildDataForSeoGoogleTrendsExploreTask({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global', locationCode: 2840 }))
      .toThrow(/omit location/i)
  })

  it('parses hourly Google Trends graph values while preserving zero and null semantics', () => {
    const task = buildDataForSeoGoogleTrendsExploreTask({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global' })
    const report = inspectDataForSeoGoogleTrendsResponse({ response: responseFor(), task, query: 'iphone' })
    expect(report).toMatchObject({
      query: 'iphone', taskStatusCode: 20000, graphPresent: true, graphPointCount: 4,
      positive: 2, zero: 1, null: 1, missing: 0, invalid: 0, usableHourlyPoints: 2,
      minimumPositiveValue: 8, maximumValue: 33, returnedLocation: null, returnedLanguage: 'en',
    })
    expect(report.firstTimestamp).toBe('2026-09-11T00:00:00.000Z')
    expect(report.lastTimestamp).toBe('2026-09-11T03:00:00.000Z')
  })

  it('counts missing and invalid values without inventing usable points', () => {
    const task = buildDataForSeoGoogleTrendsExploreTask({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global' })
    const report = inspectDataForSeoGoogleTrendsResponse({ response: responseFor([undefined, '12', -1]), task, query: 'iphone' })
    expect(report).toMatchObject({ graphPointCount: 3, positive: 0, zero: 0, null: 0, missing: 1, invalid: 2, usableHourlyPoints: 0, minimumPositiveValue: null, maximumValue: null })
  })

  it('fails clearly when the Google-specific graph is malformed or absent', () => {
    const task = buildDataForSeoGoogleTrendsExploreTask({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global' })
    const absent = responseFor(); absent.tasks[0].result[0].items = []
    expect(() => inspectDataForSeoGoogleTrendsResponse({ response: absent, task, query: 'iphone' })).toThrow(/no google_trends_graph/i)
    const malformed = responseFor(); malformed.tasks[0].result[0].items[0].data[0].values = []
    expect(() => inspectDataForSeoGoogleTrendsResponse({ response: malformed, task, query: 'iphone' })).toThrow(/values do not match/i)
  })

  it('uses the separate endpoint and never puts credentials in the returned request diagnostics', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => responseFor() }))
    const client = createDataForSeoGoogleTrendsClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl, now: () => '2026-09-13T12:00:00.000Z' })
    const result = await client.explore({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global' })
    expect(fetchImpl).toHaveBeenCalledWith(DATAFORSEO_GOOGLE_TRENDS_EXPLORE_LIVE_ENDPOINT, expect.objectContaining({ method: 'POST', body: JSON.stringify([result.task]) }))
    expect(JSON.stringify(result)).not.toContain('password')
    expect(googleTrendsProviderReportedCost(result.response)).toBe(0.012)
  })

  it('sanitizes credential-shaped transport errors', async () => {
    const client = createDataForSeoGoogleTrendsClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl: async () => { throw new Error('password=secret-value') } })
    await expect(client.explore({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global' })).rejects.toBeInstanceOf(LiveProviderError)
    try { await client.explore({ keywords: ['iphone'], timeRange: 'past_day', measurementTarget: 'global' }) } catch (error) {
      expect(error.message).not.toContain('secret-value')
      expect(error.message).not.toContain('login:password')
    }
  })

  it('exposes the lower-cost Standard task-post, ready-list, and task-get workflow without polling on its own', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({ tasks: [{ id: 'task-id', status_code: 20100 }] }) }))
    const client = createDataForSeoGoogleTrendsStandardClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl })
    await client.postTasks([{ keywords: ['iphone', 'android'], timeRange: 'past_day', measurementTarget: 'global' }])
    await client.listReady(); await client.getTask('task-id')
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASK_POST_ENDPOINT, DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASKS_READY_ENDPOINT, 'https://api.dataforseo.com/v3/keywords_data/google_trends/explore/task_get/task-id'])
    expect(fetchImpl.mock.calls[0][1].body).toContain('iphone')
  })

  it('maps same-order graph columns to their original canonical candidates', () => {
    expect(mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['Bitcoin', 'iPhone', 'Android'], returnedKeywords: ['Bitcoin', 'iPhone', 'Android'] }).returnedIndexByRequestIndex).toEqual([0, 1, 2])
  })

  it('maps reversed provider keyword order and values back to canonical identity before hourly resampling', () => {
    const rows = [[30, 10, 20], [31, 11, 21], [32, 12, 22], [33, 13, 23]]
    const result = normalizeBatch(['Android', 'Bitcoin', 'iPhone'], rows)
    expect(result.histories.map((history) => history.normalizedQuery)).toEqual(['bitcoin', 'iphone', 'android'])
    expect(result.histories.map((history) => history.rawProviderObservations[0].rawProviderValue)).toEqual([10, 20, 30])
    // Hourly resampling averages the four 15-minute provider observations;
    // the raw curve assertion below verifies the per-column mapping exactly.
    expect(result.histories.map((history) => history.observations[0].interest)).toEqual([11.5, 21.5, 31.5])
    expect(result.histories.map((history) => [history.batch.requestIndex, history.batch.returnedKeywordIndex])).toEqual([[0, 1], [1, 2], [2, 0]])
    expect(result.histories.map((history) => history.provenance.crossQueryComparability)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
      status: 'not-comparable', basis: expect.stringMatching(/only within this request batch.*not directly cross-query comparable.*batch fingerprint protects canonical compatibility/i),
    })))
    expect(result.histories.map((history) => history.rawProviderObservations.map((point) => point.rawProviderValue))).toEqual([[10, 11, 12, 13], [20, 21, 22, 23], [30, 31, 32, 33]])
  })

  it('maps an arbitrary five-keyword permutation using returned keyword metadata, not position', () => {
    const requested = ['One', 'Two', 'Three', 'Four', 'Five']
    const returned = ['Four', 'One', 'Five', 'Two', 'Three']
    expect(mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: requested, returnedKeywords: returned }).returnedIndexByRequestIndex).toEqual([1, 3, 4, 0, 2])
  })

  it('accepts only the observed dollar/comma integer echo while retaining submitted lookup identity', () => {
    expect(normalizeGoogleTrendsProviderEchoKeyword('Trump $5,000')).toBe('trump 5000')
    expect(normalizeGoogleTrendsProviderEchoKeyword('trump $5000')).toBe('trump 5000')
    expect(normalizeGoogleTrendsProviderEchoKeyword('TRUMP 5,000')).toBe('trump 5000')
    expect(mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['Trump $5,000', 'Inflation 5,000'], returnedKeywords: ['inflation 5000', 'trump $5000'] }).returnedIndexByRequestIndex).toEqual([1, 0])
  })

  it('uses only conservative Unicode/case/whitespace normalization for response keyword matching', () => {
    expect(mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['  Café   News '], returnedKeywords: ['café news'] }).returnedIndexByRequestIndex).toEqual([0])
    expect(() => mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['man utd'], returnedKeywords: ['manchester united'] })).toThrow(/unexpected keyword/i)
  })

  it('fails safely for duplicate, missing, and extra provider keyword metadata', () => {
    expect(() => mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['Trump $5,000', 'Trump 5000'], returnedKeywords: ['trump $5000', 'trump 5000'] })).toThrow(/ambiguous.*request.*trump 5000/i)
    expect(() => mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['One', 'Two'], returnedKeywords: ['One'] })).toThrow(/count/i)
    expect(() => mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['One', 'Two'], returnedKeywords: ['One', 'Three'] })).toThrow(/unexpected keyword/i)
    expect(() => mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: ['One', 'Two'], returnedKeywords: ['One', ' one '] })).toThrow(/ambiguous.*response.*one/i)
  })
})
