import { describe, expect, it, vi } from 'vitest'
import { baselineCacheKey } from './baselineCache.mjs'
import { buildCanonicalAttentionPersistencePlan } from './canonicalAttentionPersistence.mjs'
import { createDataForSeoGlobalSearchVolumeClient, DATAFORSEO_GLOBAL_SEARCH_VOLUME_LIVE_ENDPOINT, normalizeDataForSeoGlobalSearchVolume } from './dataForSeoSearchVolume.mjs'
import { buildDataForSeoExploreTask, normalizeDataForSeoMeasurementWithDiagnostics } from './dataForSeoTrends.mjs'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'
import { collectGeoDiscoveryGroups, collectLiveSharedInputs, MIN_SUCCESSFUL_MULTI_GEO_DISCOVERY_REQUESTS } from './liveIngestionPipeline.mjs'
import { resolveLiveMeasurementConfig } from './measurementGeography.mjs'
import { buildSerpApiDiscoveryRequestsFromEnv } from './serpApiDiscoveryConfig.mjs'
import { composeUnifiedPublicScore } from './unifiedPublicScoring.mjs'
import { SHADOW_HISTORY_WINDOWS, shadowHistoryRequestForWindow } from './elapsedShadowHistory.mjs'
import { resolveLiveTrendsProvider } from './liveTrendsProvider.mjs'

const usEnv = { DATAFORSEO_LOCATION_NAME: 'United States' }
const globalEnv = { LIVE_MEASUREMENT_MODE: 'global' }
const curve = (scope, target) => ({
  topic: 'Topic', normalizedQuery: 'topic', retrievedAt: '2026-09-13T12:00:00.000Z',
  provenance: { providerId: 'dataforseo-trends', geographicScope: scope, sourceObservedAt: '2026-09-13T12:00:00.000Z', collectionMethod: 'dataforseo-trends-explore-live' },
  historyRequest: { timeRange: 'past_day', measurementMode: target.measurementMode, measurementTarget: target.measurementTarget },
  measurementProvenance: { measurementMode: target.measurementMode, measurementTarget: target.measurementTarget, measurementLocation: scope },
  observations: [0, 4, 8].map((hour, index) => ({ observedAt: `2026-09-13T${String(hour).padStart(2, '0')}:00:00:00.000Z`, availability: 'available', interest: 20 + index * 10 })),
})

function globalPastDayResponse(values) {
  return {
    status_code: 20000,
    tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{
      items: [{ type: 'dataforseo_trends_graph', keywords: ['Topic'], data: values.map((value, hour) => ({
        timestamp: 1_789_084_800 + hour * 3_600,
        values: [value],
      })) }],
    }] }],
  }
}

function globalCandidate() {
  return { sourceId: 'candidate', query: 'Topic', normalizedQuery: 'topic', category: 'Technology' }
}

function discoveryCandidates(geo) {
  return Array.from({ length: 3 }, (_, index) => ({
    providerId: 'serpapi-google-trends-trending-now', query: `Topic ${index + 1}`, normalizedQuery: `topic ${index + 1}`,
    category: 'Technology', searchVolume: 100 - index, increasePercentage: 10, providerDiscoveryRank: index + 1,
    retrievedAt: '2026-09-13T12:00:00.000Z', geographicScope: { kind: 'country', countryCode: geo },
  }))
}

function geoRequests() {
  return ['US', 'IN', 'BR', 'DE', 'JP'].map((geo) => ({ geo, geographicScope: { kind: 'country', countryCode: geo } }))
}

describe('explicit global measurement wiring', () => {
  it('preserves legacy US configuration when the new mode is absent', () => {
    const config = resolveLiveMeasurementConfig(usEnv)
    expect(config).toMatchObject({ mode: 'us', trendsRequest: { measurementMode: 'us', locationName: 'United States' }, baselineRequest: { providerId: 'dataforseo-google-ads-search-volume', locationName: 'United States' } })
  })

  it('uses the separate worldwide baseline and only omits Trends location in explicit global mode', () => {
    const config = resolveLiveMeasurementConfig(globalEnv)
    expect(config).toMatchObject({ mode: 'global', baselineRequest: { providerId: 'dataforseo-clickstream-global-search-volume', geographicScope: { kind: 'global' } }, trendsRequest: { measurementMode: 'global', geographicScope: { kind: 'global' } } })
    expect(buildDataForSeoExploreTask({ keywords: ['topic'], measurementMode: 'global', timeRange: 'past_day' })).toEqual({ keywords: ['topic'], time_range: 'past_day' })
    expect(buildDataForSeoExploreTask({ keywords: ['topic'], measurementMode: 'us', locationName: 'United States' })).toEqual({ keywords: ['topic'], location_name: 'United States' })
    expect(() => buildDataForSeoExploreTask({ keywords: ['topic'], measurementMode: 'global', locationName: 'United States' })).toThrow(/omit location/i)
  })

  it.each([
    ['7D', 'past_7_days', 'daily'],
    ['30D', 'past_30_days', 'daily'],
    ['1Y', 'past_12_months', 'weekly'],
  ])('keeps global %s history on the location-free established provider with its expected %s cadence', (window, timeRange, expectedCadence) => {
    const measurement = resolveLiveMeasurementConfig(globalEnv)
    const request = { ...measurement.trendsRequest, measurementTarget: measurement.target.targetKey, ...shadowHistoryRequestForWindow(window) }
    expect(resolveLiveTrendsProvider({ measurementMode: 'global', historyWindow: window })).toMatchObject({ id: 'dataforseo-trends', transport: 'dataforseo-trends', forcedMode: null })
    expect(SHADOW_HISTORY_WINDOWS[window]).toMatchObject({ providerTimeRange: timeRange, expectedCadence })
    expect(buildDataForSeoExploreTask({ keywords: ['topic'], measurementMode: request.measurementMode, timeRange: request.timeRange })).toEqual({ keywords: ['topic'], time_range: timeRange })
  })

  it('normalizes the global Clickstream response into the existing baseline contract', async () => {
    const response = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ keyword: 'topic', search_volume: 99, country_distribution: [{ country_iso_code: 'IN', search_volume: 70, percentage: 70 }] }] }] }] }
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }))
    const client = createDataForSeoGlobalSearchVolumeClient({ env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, fetchImpl, now: () => '2026-09-13T12:00:00.000Z' })
    const request = { ...resolveLiveMeasurementConfig(globalEnv).baselineRequest, keywords: ['topic'] }
    const result = await client.lookup(request)
    expect(fetchImpl).toHaveBeenCalledWith(DATAFORSEO_GLOBAL_SEARCH_VOLUME_LIVE_ENDPOINT, expect.any(Object))
    expect(normalizeDataForSeoGlobalSearchVolume({ response: result.response, retrievedAt: result.retrievedAt, geographicScope: request.geographicScope })[0]).toMatchObject({ providerId: 'dataforseo-clickstream-global-search-volume', searchVolume: 99, availability: 'available', geographicScope: { kind: 'global' } })
  })

  it('isolates US and global baseline cache keys without deleting legacy rows', () => {
    const us = { ...resolveLiveMeasurementConfig(usEnv).baselineRequest, measurementTarget: resolveLiveMeasurementConfig(usEnv).target.targetKey }
    const global = { ...resolveLiveMeasurementConfig(globalEnv).baselineRequest, measurementTarget: resolveLiveMeasurementConfig(globalEnv).target.targetKey }
    expect(baselineCacheKey('iphone', us)).not.toBe(baselineCacheKey('iphone', global))
  })

  it('merges multi-geo discovery while measurement remains global and the paid cohort stays capped', async () => {
    const requests = buildSerpApiDiscoveryRequestsFromEnv({ SERPAPI_DISCOVERY_GEO: 'US', SERPAPI_DISCOVERY_HOURS: '24', LIVE_DISCOVERY_GEOS: 'US,IN,BR' })
    const discoveryClient = { discover: vi.fn(async (request) => Array.from({ length: 30 }, (_, index) => ({ providerId: 'serpapi-google-trends-trending-now', query: `${request.geo} topic ${index}`, normalizedQuery: `topic ${index}`, category: 'Technology', searchVolume: 100 - index, increasePercentage: 10, providerDiscoveryRank: index + 1, retrievedAt: '2026-09-13T12:00:00.000Z', geographicScope: request.geographicScope }))) }
    const measurement = resolveLiveMeasurementConfig(globalEnv)
    const volumeClient = { providerId: 'dataforseo-clickstream-global-search-volume', normalize: ({ geographicScope }) => Array.from({ length: 50 }, (_, index) => ({ query: `topic ${index}`, normalizedQuery: `topic ${index}`, availability: 'available', searchVolume: 1, monthlyHistory: null, geographicScope })), lookup: vi.fn(async () => ({ response: { cost: 0 }, retrievedAt: '2026-09-13T12:00:00.000Z' })) }
    const shared = await collectLiveSharedInputs({ discoveryRequest: requests[0], discoveryRequests: requests, discoveryLimit: 100, maxPaidCandidates: 50, volumeRequest: { ...measurement.baselineRequest, measurementTarget: measurement.target.targetKey }, discoveryClient, volumeClient })
    expect(shared.measurementTarget).toBe(measurement.target.targetKey)
    expect(shared.candidates.length).toBeLessThanOrEqual(50)
    expect(shared.candidates[0]).toMatchObject({ sourceGeos: ['BR', 'IN', 'US'] })
    expect(discoveryClient.discover).toHaveBeenCalledTimes(3)
  })

  it('continues with four valid geos while retaining the malformed geo diagnostic', async () => {
    const groups = await collectGeoDiscoveryGroups({
      requests: geoRequests(),
      discoveryClient: { discover: vi.fn(async (request) => {
        if (request.geo === 'BR') {
          const error = new Error('malformed response')
          error.discoveryDiagnostic = { geo: 'BR', requestStatus: 200, classification: 'missing-trending-searches', topLevelResponseKeys: ['search_metadata'], trendingSearches: { present: false, isArray: false, count: null }, trendingDataPresent: false, responseEmpty: false, rateLimited: false }
          throw error
        }
        return discoveryCandidates(request.geo)
      }) },
    })
    expect(groups.groups).toHaveLength(4)
    expect(groups.diagnostics).toMatchObject({ requiredSuccessfulGeos: MIN_SUCCESSFUL_MULTI_GEO_DISCOVERY_REQUESTS, successfulGeos: ['US', 'IN', 'DE', 'JP'], failedGeos: ['BR'] })
    expect(groups.diagnostics.requests.find((entry) => entry.geo === 'BR')).toMatchObject({ outcome: 'failed', classification: 'missing-trending-searches', requestStatus: 200, topLevelResponseKeys: ['search_metadata'], trendingSearches: { present: false, isArray: false, count: null } })
  })

  it('keeps a valid-empty geo distinct from failure and permits it toward the success threshold', async () => {
    const groups = await collectGeoDiscoveryGroups({
      requests: geoRequests(),
      discoveryClient: { discover: vi.fn(async (request) => request.geo === 'JP' ? [] : discoveryCandidates(request.geo)) },
    })
    expect(groups.groups).toHaveLength(5)
    expect(groups.diagnostics.requests.find((entry) => entry.geo === 'JP')).toMatchObject({ outcome: 'succeeded', classification: 'valid-empty-response', responseEmpty: true, candidateCount: 0 })
    expect(groups.diagnostics.failedGeos).toEqual([])
  })

  it('fails below the multi-geo minimum before baseline, scoring, or persistence work', async () => {
    const requests = geoRequests()
    const volumeClient = { lookup: vi.fn(), providerId: 'dataforseo-clickstream-global-search-volume' }
    const discoveryClient = { discover: vi.fn(async (request) => {
      if (['US', 'IN'].includes(request.geo)) return discoveryCandidates(request.geo)
      const error = new Error(`network failure for ${request.geo}`)
      error.discoveryDiagnostic = { geo: request.geo, requestStatus: 503, classification: 'network-failure', rateLimited: false }
      throw error
    }) }
    await expect(collectLiveSharedInputs({ discoveryRequest: requests[0], discoveryRequests: requests, discoveryLimit: 50, maxPaidCandidates: 50, volumeRequest: { providerId: volumeClient.providerId, geographicScope: { kind: 'global' } }, discoveryClient, volumeClient })).rejects.toMatchObject({ discoveryDiagnostics: expect.objectContaining({ requiredSuccessfulGeos: 3, successfulGeos: ['US', 'IN'], failedGeos: ['BR', 'DE', 'JP'] }) })
    expect(volumeClient.lookup).not.toHaveBeenCalled()
  })

  it('reports every failed geo when all multi-geo discovery requests fail', async () => {
    await expect(collectGeoDiscoveryGroups({
      requests: geoRequests(),
      discoveryClient: { discover: vi.fn(async (request) => {
        const error = new Error('rate limit; api_key=must-not-leak')
        error.discoveryDiagnostic = { geo: request.geo, requestStatus: 429, classification: 'rate-limited-response', rateLimited: true }
        throw error
      }) },
    })).rejects.toMatchObject({ discoveryDiagnostics: expect.objectContaining({ successfulGeos: [], failedGeos: ['US', 'IN', 'BR', 'DE', 'JP'] }) })
  })

  it('separates global and US canonical artifacts while allowing the same global target to align', () => {
    const global = resolveLiveMeasurementConfig(globalEnv).canonicalTargeting
    const us = resolveLiveMeasurementConfig(usEnv).canonicalTargeting
    const globalPlan = buildCanonicalAttentionPersistencePlan({ histories: [curve({ kind: 'global' }, global)], candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'global-a', scoredAt: '2026-09-13T12:00:00.000Z' })
    const usPlan = buildCanonicalAttentionPersistencePlan({ histories: [curve({ kind: 'country', countryCode: 'US' }, us)], candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'us-a', scoredAt: '2026-09-13T12:00:00.000Z' })
    expect(globalPlan.points[0].series_key).not.toBe(usPlan.points[0].series_key)
    const next = buildCanonicalAttentionPersistencePlan({ histories: [curve({ kind: 'global' }, global)], candidateIdByQuery: new Map([['topic', 'candidate']]), existingByQuery: new Map([['topic', globalPlan.points]]), runId: 'global-b', scoredAt: '2026-09-13T16:00:00.000Z' })
    expect(next.alignments[0]).toMatchObject({ accepted: true })
  })

  it('normalizes a positive global hourly past_day graph and bootstraps a global canonical segment', () => {
    const measurement = resolveLiveMeasurementConfig(globalEnv)
    const normalized = normalizeDataForSeoMeasurementWithDiagnostics({
      response: globalPastDayResponse(Array.from({ length: 24 }, (_, hour) => hour + 1)),
      candidates: [globalCandidate()],
      geographicScope: { kind: 'global' },
      retrievedAt: '2026-09-13T12:00:00.000Z',
      adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' }),
      requestMetadata: { time_range: 'past_day', measurementMode: 'global', measurementTarget: measurement.target.targetKey },
    })
    expect(normalized.histories[0]).toMatchObject({
      historyRequest: { timeRange: 'past_day', measurementMode: 'global', measurementTarget: measurement.target.targetKey },
      measurementProvenance: { measurementMode: 'global', measurementTarget: measurement.target.targetKey, measurementLocation: { kind: 'global' } },
    })
    expect(normalized.diagnostics).toMatchObject({ totalGraphPoints: 24, positiveMeasurements: 24, candidatesWithoutUsablePoints: 0 })
    const plan = buildCanonicalAttentionPersistencePlan({ histories: normalized.histories, candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'global-positive', scoredAt: '2026-09-13T12:00:00.000Z', canonicalTargeting: measurement.canonicalTargeting })
    expect(plan.diagnostics).toMatchObject({ eligibleCandidates: 1, rawArtifacts: 1, bootstrapped: 1, rejected: 0, newPoints: 24 })
    expect(plan.points).toHaveLength(24)
  })

  it('keeps an all-null global graph explicitly unavailable and accounts for every parsed graph cell', () => {
    const measurement = resolveLiveMeasurementConfig(globalEnv)
    const normalized = normalizeDataForSeoMeasurementWithDiagnostics({
      response: globalPastDayResponse(Array.from({ length: 24 }, () => null)),
      candidates: [globalCandidate()],
      geographicScope: { kind: 'global' },
      retrievedAt: '2026-09-13T12:00:00.000Z',
      adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' }),
      requestMetadata: { time_range: 'past_day', measurementMode: 'global', measurementTarget: measurement.target.targetKey },
    })
    const diagnostics = normalized.diagnostics
    expect(diagnostics).toMatchObject({ totalGraphPoints: 24, positiveMeasurements: 0, nullMeasurements: 24, invalidOrMissingMeasurements: 24, affectedCandidates: 1, candidatesWithoutUsablePoints: 1 })
    expect(diagnostics.totalGraphPoints).toBe(diagnostics.positiveMeasurements + diagnostics.zeroMeasurements + diagnostics.nullMeasurements + diagnostics.missingValueMeasurements + diagnostics.negativeMeasurements + diagnostics.invalidNonNumericMeasurements)
    expect(diagnostics.candidateDiagnostics[0]).toMatchObject({ canonicalQuery: 'Topic', measurementMode: 'global', measurementTarget: measurement.target.targetKey, requestTimeRange: 'past_day', providerTaskStatusCode: 20000, graphPointCount: 24, usableCanonicalPoints: 0, nullMeasurements: 24 })
    const plan = buildCanonicalAttentionPersistencePlan({ histories: normalized.histories, candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'global-null', scoredAt: '2026-09-13T12:00:00.000Z', canonicalTargeting: measurement.canonicalTargeting })
    expect(plan.diagnostics).toMatchObject({ rawArtifacts: 1, bootstrapped: 0, rejected: 1, rejectionReasons: { 'no-valid-provider-points': 1 } })
  })

  it('does not change unified scoring or add country-specific public rank fields', () => {
    const inputs = { window: '24H', currentAttention: 50, baselineDemand: 50, historicalGrowth: null, discoveryAcceleration: 70, momentum: null, consistency: null, breakout: null, recency: 80, historyCoverage: 0 }
    const before = composeUnifiedPublicScore(inputs)
    resolveLiveMeasurementConfig(globalEnv)
    expect(composeUnifiedPublicScore(inputs)).toEqual(before)
  })
})
