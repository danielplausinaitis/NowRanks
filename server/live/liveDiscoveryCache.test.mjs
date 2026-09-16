import { describe, expect, it } from 'vitest'
import { discoveryCachePayload, hydrateLiveDiscoveryCache, isFreshLiveDiscoveryCache, liveDiscoveryCacheKey } from './liveDiscoveryCache.mjs'
import { collectLiveSharedInputs } from './liveIngestionPipeline.mjs'
import { baselineCacheKey } from './baselineCache.mjs'
import { prepareLiveSchedulerShared } from '../scripts/ingestLive.mjs'

const candidate = { query: 'Topic', normalizedQuery: 'topic', category: 'Technology', searchVolume: 10 }
const request = { geographicScope: { kind: 'multi-country', countryCodes: ['US', 'IN', 'BR', 'DE', 'JP'] } }

describe('daily live discovery cache', () => {
  it('has stable target-isolated identity and accepts only a 24-hour artifact', () => {
    const first = liveDiscoveryCacheKey({ discoveryRequests: [{ ...request, geo: 'US' }], measurementTarget: 'global' })
    expect(first).toBe(liveDiscoveryCacheKey({ discoveryRequests: [{ ...request, geo: 'US' }], measurementTarget: 'global' }))
    expect(first).not.toBe(liveDiscoveryCacheKey({ discoveryRequests: [{ ...request, geo: 'US' }], measurementTarget: 'us' }))
    expect(first).not.toBe(liveDiscoveryCacheKey({ discoveryRequests: [{ ...request, geo: 'IN' }], measurementTarget: 'global' }))
    expect(isFreshLiveDiscoveryCache({ discovered_at: '2026-09-15T00:00:00Z' }, { now: new Date('2026-09-16T00:00:00Z') })).toBe(true)
    expect(isFreshLiveDiscoveryCache({ discovered_at: '2026-09-15T00:00:00Z' }, { now: new Date('2026-09-16T00:00:01Z') })).toBe(false)
  })

  it('rehydrates a valid artifact without discovery I/O and rejects malformed/stale-unusable state', () => {
    const payload = discoveryCachePayload({ discoveryCandidates: [candidate], discoveryRequest: request, discoveryRequests: [request], sharedMetrics: { discovery: { successfulGeos: ['US', 'IN', 'BR', 'DE', 'JP'] } } })
    expect(hydrateLiveDiscoveryCache({ ...payload, discovered_at: '2026-09-15T00:00:00Z' })).toMatchObject({ candidates: [candidate], discoveryRequest: request })
    expect(() => hydrateLiveDiscoveryCache({ candidate_universe: [], discovery_request: request })).toThrow(/malformed/)
    expect(() => hydrateLiveDiscoveryCache({ candidate_universe: [{ query: 'bad' }], discovery_request: request })).toThrow(/invalid candidate/)
  })

  it('reuses a fresh artifact for a later horizon and reuses fresh baseline cache rows', async () => {
    const cachedDiscovery = { candidates: [candidate, { ...candidate, query: 'Other', normalizedQuery: 'other' }], discoveryRequest: request, discoveryRequests: [request], discoveryDiagnostics: { successfulGeos: ['US'] } }
    const volumeRequest = { providerId: 'volume', geographicScope: request.geographicScope }
    const discover = async () => { throw new Error('discovery must not run') }
    const lookup = async () => { throw new Error('baseline provider must not run') }
    const shared = await collectLiveSharedInputs({ candidateLimit: 2, discoveryLimit: 2, maxPaidCandidates: 2, cachedDiscovery, discoveryRequest: request, volumeRequest, discoveryClient: { discover }, volumeClient: { providerId: 'volume', lookup }, baselineCacheRepository: { listLiveBaselineDemandCache: async ({ cacheKeys }) => cacheKeys.map((cache_key) => ({ cache_key, availability: 'available', search_volume: 1, monthly_history: [], retrieved_at: '2099-01-01T00:00:00Z' })) } })
    expect(shared.sharedMetrics.providerRequests).toMatchObject({ serpApi: 0, dataForSeoSearchVolume: 0 })
    expect(shared.volumes.map((row) => row.normalizedQuery)).toEqual(expect.arrayContaining(['topic', 'other']))
    expect(baselineCacheKey('topic', volumeRequest)).toBeTruthy()
  })

  it('falls back to a still-fresh prior artifact when the forced daily refresh fails, and fails without one', async () => {
    const discoveries = ['One', 'Two'].map((query, index) => ({ providerId: 'serpapi', query, normalizedQuery: query.toLowerCase(), category: 'Technology', searchVolume: 100 - index, increasePercentage: 10, providerDiscoveryRank: index + 1, retrievedAt: '2026-09-15T00:00:00Z', geographicScope: { kind: 'country', countryCode: 'US' } }))
    const rows = new Map()
    const repository = {
      getLiveDailyDiscoveryCache: async () => rows.get('daily') ?? null,
      upsertLiveDailyDiscoveryCache: async (row) => rows.set('daily', row),
      listLiveBaselineDemandCache: async ({ cacheKeys }) => cacheKeys.map((cache_key) => ({ cache_key, availability: 'available', search_volume: 1, monthly_history: [], retrieved_at: '2099-01-01T00:00:00Z' })),
    }
    const env = { LIVE_INGEST_DRY_RUN: 'false', ALLOW_LIVE_DATABASE_WRITE: 'true', LIVE_MEASUREMENT_MODE: 'global', SERPAPI_DISCOVERY_GEO: 'US', LIVE_DISCOVERY_GEOS: 'US,IN,BR,DE,JP' }
    const first = await prepareLiveSchedulerShared({ env, dependencies: { repository, discoveryClient: { discover: async (request) => discoveries.map((item) => ({ ...item, geographicScope: request.geographicScope })) }, volumeClient: { providerId: 'volume', lookup: async () => { throw new Error('no baseline call') } } }, forceFreshDiscovery: true })
    expect(first.sharedInputs.sharedMetrics.discoveryCache.status).toBe('refreshed')
    const fallback = await prepareLiveSchedulerShared({ env, dependencies: { repository, discoveryClient: { discover: async () => { throw new Error('SerpApi failed') } }, volumeClient: { providerId: 'volume', lookup: async () => { throw new Error('no baseline call') } } }, forceFreshDiscovery: true })
    expect(fallback.sharedInputs.sharedMetrics.discoveryCache.status).toBe('reused-after-refresh-failure')
    await expect(prepareLiveSchedulerShared({ env, dependencies: { repository: { ...repository, getLiveDailyDiscoveryCache: async () => null }, discoveryClient: { discover: async () => { throw new Error('SerpApi failed') } }, volumeClient: { providerId: 'volume', lookup: async () => { throw new Error('no baseline call') } } }, forceFreshDiscovery: true })).rejects.toThrow(/requires at least 3 successful/)
  })
})
