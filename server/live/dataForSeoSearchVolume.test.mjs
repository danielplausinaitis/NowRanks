import { describe, expect, it, vi } from 'vitest'
import { LiveProviderError } from './providerAdapter.mjs'
import { composeLiveMeasurementSignals } from './liveSignalComposition.mjs'
import {
  DATAFORSEO_SEARCH_VOLUME_LIVE_ENDPOINT,
  DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORDS,
  assessSearchVolumeComparability,
  buildDataForSeoSearchVolumeTask,
  createDataForSeoSearchVolumeClient,
  normalizeDataForSeoSearchVolume,
} from './dataForSeoSearchVolume.mjs'

const geography = { kind: 'country', countryCode: 'US' }
const response = {
  status_code: 20000,
  tasks: [{
    status_code: 20000,
    result: [
      { keyword: 'chatgpt', location_code: 2840, language_code: 'en', competition: 'HIGH', competition_index: 92, search_volume: 0, cpc: 2.5, monthly_searches: [{ year: 2026, month: 7, search_volume: 0 }, { year: 2026, month: 6, search_volume: 1200 }] },
      { keyword: 'unknown topic', location_code: 2840, language_code: 'en', competition: null, competition_index: null, search_volume: null, cpc: null, monthly_searches: null },
    ],
  }],
}

describe('DataForSEO Google Ads Search Volume transport', () => {
  it('constructs one explicit-targeting task and one authenticated POST', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }))
    const client = createDataForSeoSearchVolumeClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl, now: () => '2026-09-02T00:00:00.000Z' })
    const result = await client.lookup({ keywords: ['ChatGPT', 'Unknown Topic'], locationCode: 2840, languageCode: 'en', dateFrom: '2025-08-01', dateTo: '2026-07-31', searchPartners: false })
    expect(result.task).toEqual({ keywords: ['ChatGPT', 'Unknown Topic'], location_code: 2840, language_code: 'en', date_from: '2025-08-01', date_to: '2026-07-31', search_partners: false })
    expect(fetchImpl).toHaveBeenCalledWith(DATAFORSEO_SEARCH_VOLUME_LIVE_ENDPOINT, expect.objectContaining({
      method: 'POST', body: JSON.stringify([result.task]), headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from('login:password').toString('base64')}` }),
    }))
    expect(JSON.stringify(result)).not.toContain('password')
  })

  it('requires server credentials and ignores VITE-prefixed lookalikes', async () => {
    const client = createDataForSeoSearchVolumeClient({ env: { VITE_DATAFORSEO_LOGIN: 'browser', VITE_DATAFORSEO_PASSWORD: 'browser-secret' } })
    await expect(client.lookup({ keywords: ['one'], locationCode: 2840 })).rejects.toThrow(/DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD/)
  })

  it('fits a 100-keyword NowRanks cohort in one bounded request and rejects more than 1000', () => {
    const keywords = Array.from({ length: 100 }, (_, index) => `topic ${index}`)
    const task = buildDataForSeoSearchVolumeTask({ keywords, locationName: 'United States', languageName: 'English' })
    expect(task.keywords).toHaveLength(100)
    expect(DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORDS).toBe(1000)
    expect(() => buildDataForSeoSearchVolumeTask({ keywords: Array.from({ length: 1001 }, (_, index) => `topic ${index}`), locationCode: 2840 })).toThrow(/one to 1000/i)
  })

  it('requires exactly one explicit location and accepts only one language selector', () => {
    expect(() => buildDataForSeoSearchVolumeTask({ keywords: ['one'] })).toThrow(/exactly one explicit location/i)
    expect(() => buildDataForSeoSearchVolumeTask({ keywords: ['one'], locationCode: 2840, locationName: 'United States' })).toThrow(/exactly one explicit location/i)
    expect(() => buildDataForSeoSearchVolumeTask({ keywords: ['one'], locationCode: 2840, languageCode: 'en', languageName: 'English' })).toThrow(/not both/i)
  })

  it('preserves legitimate zero separately from missing and parses monthly history', () => {
    const records = normalizeDataForSeoSearchVolume({ response, retrievedAt: '2026-09-02T00:00:00.000Z', geographicScope: geography })
    expect(records[0]).toMatchObject({ query: 'chatgpt', availability: 'available', searchVolume: 0, competition: 'HIGH', competitionIndex: 92, cpc: 2.5 })
    expect(records[0].monthlyHistory).toEqual([
      { period: '2026-07', year: 2026, month: 7, availability: 'available', searchVolume: 0 },
      { period: '2026-06', year: 2026, month: 6, availability: 'available', searchVolume: 1200 },
    ])
    expect(records[1]).toMatchObject({ availability: 'missing', searchVolume: null, competition: null, competitionIndex: null, cpc: null, monthlyHistory: null })
    expect(records[0].provenance).toMatchObject({ providerId: 'dataforseo-google-ads-search-volume', dataMode: 'live', comparability: { status: 'comparable' } })
  })

  it('rejects malformed provider responses and sanitizes provider failures', async () => {
    expect(() => normalizeDataForSeoSearchVolume({ response: { status_code: 20000, tasks: [{ status_code: 20000, result: 'invalid' }] }, retrievedAt: '2026-09-02T00:00:00.000Z', geographicScope: geography })).toThrow(/no result array/i)
    const client = createDataForSeoSearchVolumeClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl: async () => { throw new Error('authorization=secret-value') } })
    await expect(client.lookup({ keywords: ['one'], locationCode: 2840 })).rejects.toBeInstanceOf(LiveProviderError)
    try { await client.lookup({ keywords: ['one'], locationCode: 2840 }) } catch (error) { expect(error.message).not.toContain('secret-value') }
  })

  it('keeps HTTP, top-level, and task diagnostics when an Ok. message masks a failed status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status_code: 20100, status_message: 'Ok.', tasks: [{ status_code: 40602, status_message: 'invalid task', result: null }] }) }))
    const client = createDataForSeoSearchVolumeClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl })
    await expect(client.lookup({ keywords: ['one'], locationCode: 2840 })).rejects.toThrow(/top-level status_code=20100.*task status_code=40602/s)
  })

  it('rejects top-level success with a failed task or missing result before returning it', async () => {
    const failedTask = { status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 40600, status_message: 'failed', result: [] }] }
    const missingResult = { status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 20000, status_message: 'Ok.' }] }
    for (const body of [failedTask, missingResult]) {
      const client = createDataForSeoSearchVolumeClient({ env: { DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'password' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) })
      await expect(client.lookup({ keywords: ['one'], locationCode: 2840 })).rejects.toBeInstanceOf(LiveProviderError)
    }
  })

  it('marks absolute volumes comparable under matching targeting and blocks mixed targeting', () => {
    const one = buildDataForSeoSearchVolumeTask({ keywords: ['one'], locationCode: 2840, languageCode: 'en' })
    const two = buildDataForSeoSearchVolumeTask({ keywords: ['two'], locationCode: 2840, languageCode: 'en' })
    const other = buildDataForSeoSearchVolumeTask({ keywords: ['three'], locationCode: 2826, languageCode: 'en' })
    expect(assessSearchVolumeComparability([one])).toMatchObject({ status: 'comparable', scope: 'single-request-cohort' })
    expect(assessSearchVolumeComparability([one, two])).toMatchObject({ status: 'comparable', scope: 'matched-targeting-requests' })
    expect(assessSearchVolumeComparability([one, other])).toMatchObject({ status: 'not-comparable', scope: 'mixed-targeting-requests' })
  })

  it('keeps the three future live signal families separate without changing scoring', () => {
    const composition = composeLiveMeasurementSignals({
      candidate: { normalizedQuery: 'chatgpt' },
      currentTrendIntensity: { providerId: 'serpapi-google-trends-trending-now', searchVolume: 500000 },
      baselineDemand: { providerId: 'dataforseo-google-ads-search-volume', searchVolume: 1000000 },
      historicalTrendShape: { providerId: 'dataforseo-trends', observations: [] },
    })
    expect(composition.signals).toHaveProperty('currentTrendIntensity')
    expect(composition.signals).toHaveProperty('baselineDemand')
    expect(composition.signals).toHaveProperty('historicalTrendShape')
    expect(composition.futureScoringUse.searchInterest).toEqual(['currentTrendIntensity', 'baselineDemand'])
  })
})
