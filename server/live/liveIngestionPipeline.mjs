import { normalizeDataForSeoSearchVolume } from './dataForSeoSearchVolume.mjs'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'
import { providerReportedCost, retrieveShadowTrendHistories } from './shadowHistoryRetrieval.mjs'
import { baselineCacheKey, classifyBaselineCache, BASELINE_PROVIDER } from './baselineCache.mjs'

function targeting(volumeRequest) {
  return { locationCode: volumeRequest.locationCode ?? null, locationName: volumeRequest.locationName ?? null, locationCoordinate: volumeRequest.locationCoordinate ?? null, languageCode: volumeRequest.languageCode ?? null, languageName: volumeRequest.languageName ?? null, searchPartners: volumeRequest.searchPartners ?? false, dateFrom: volumeRequest.dateFrom ?? null, dateTo: volumeRequest.dateTo ?? null }
}

/** Resolves the provider inputs shared by every scheduled window in one slot. */
export async function collectLiveSharedInputs({ candidateLimit, discoveryRequest, volumeRequest, discoveryClient, volumeClient, baselineCacheRepository, baselineCacheTtlHours = 24, writeBaselineCache = false, onProgress }) {
  if (!discoveryClient?.discover || !volumeClient?.lookup) throw new Error('Live shared ingestion requires discovery and baseline clients')
  onProgress?.('discovery')
  const discovered = await discoveryClient.discover(discoveryRequest)
  const candidates = discovered.filter((candidate) => candidate.category && Number.isFinite(candidate.searchVolume)).slice(0, candidateLimit)
  if (candidates.length < 2) throw new Error('Live discovery returned fewer than two eligible candidates; no persistence plan was created')
  onProgress?.('baseline demand')
  const cacheKeys = candidates.map((candidate) => baselineCacheKey(candidate.normalizedQuery, volumeRequest))
  const cachedRows = baselineCacheRepository ? await baselineCacheRepository.listLiveBaselineDemandCache({ cacheKeys }) : []
  const cache = classifyBaselineCache({ candidates, cachedRows, request: volumeRequest, ttlHours: baselineCacheTtlHours })
  const cachedVolumes = cache.fresh.map(({ candidate, row }) => ({ providerId: BASELINE_PROVIDER, query: candidate.query, normalizedQuery: candidate.normalizedQuery, availability: row.availability, searchVolume: row.search_volume, monthlyHistory: row.monthly_history, retrievedAt: row.retrieved_at, geographicScope: discoveryRequest.geographicScope }))
  let refreshed = []; let volumeCost = 0
  if (cache.refresh.length) {
    const result = await volumeClient.lookup({ ...volumeRequest, keywords: cache.refresh.map(({ candidate }) => candidate.query) })
    refreshed = normalizeDataForSeoSearchVolume({ response: result.response, retrievedAt: result.retrievedAt, geographicScope: discoveryRequest.geographicScope })
    volumeCost = providerReportedCost(result.response)
    if (writeBaselineCache) await baselineCacheRepository.upsertLiveBaselineDemandCache(refreshed.map((record) => ({ cache_key: baselineCacheKey(record.normalizedQuery, volumeRequest), normalized_query: record.normalizedQuery, provider_id: BASELINE_PROVIDER, targeting: targeting(volumeRequest), availability: record.availability, search_volume: record.searchVolume, monthly_history: record.monthlyHistory, retrieved_at: record.retrievedAt })))
  }
  return { candidates, volumes: [...cachedVolumes, ...refreshed], discoveryRequest, sharedMetrics: { providerRequests: { serpApi: 1, dataForSeoSearchVolume: cache.refresh.length ? 1 : 0 }, providerCosts: { searchVolume: volumeCost, serpApi: 'plan-dependent' }, baselineCache: { freshHits: cache.fresh.length, staleOrMissing: cache.refresh.length, requestedKeywords: cache.refresh.length, requestsAvoided: cache.fresh.length ? 1 : 0, rowsRefreshed: refreshed.length, writesSkipped: !writeBaselineCache } } }
}

/** Retrieves and scores only the history that is specific to one selected window. */
export async function collectLiveWindowCycle({ sharedInputs, historyRequest, historyWindow, trendsMode, trendsClient, scoreCycle, onProgress }) {
  if (!sharedInputs?.candidates || !sharedInputs?.volumes) throw new Error('Resolved live shared inputs are required')
  if (!trendsClient?.measure || typeof scoreCycle !== 'function') throw new Error('Live window ingestion requires Trends and scoring clients')
  const { candidates, volumes, discoveryRequest, sharedMetrics } = sharedInputs
  onProgress?.('history')
  const trendResult = await retrieveShadowTrendHistories({ candidates, mode: trendsMode, client: trendsClient, request: historyRequest, geographicScope: discoveryRequest.geographicScope, adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' }) })
  const volumeByQuery = new Map(volumes.map((record) => [record.normalizedQuery, record]))
  const historyByQuery = new Map(trendResult.histories.map((record) => [record.normalizedQuery, record]))
  const scoringInputs = candidates.map((candidate) => ({ topic: candidate.query, normalizedQuery: candidate.normalizedQuery, category: candidate.category, currentTrendIntensity: candidate, baselineDemand: volumeByQuery.get(candidate.normalizedQuery) ?? null, historicalTrendShape: historyByQuery.get(candidate.normalizedQuery) ?? null }))
  onProgress?.('scoring')
  const scores = await scoreCycle({ candidates: scoringInputs, historyWindow, coldStartMaxAgeHours: discoveryRequest.hours ?? 24 })
  const searchVolume = sharedMetrics.providerCosts.searchVolume
  return { candidates, volumes, histories: trendResult.histories, scores, scoredAt: [...candidates.map((x) => x.retrievedAt), ...volumes.map((x) => x.retrievedAt), ...trendResult.histories.map((x) => x.retrievedAt)].filter(Boolean).sort().at(-1), requestMetrics: { providerRequests: { ...sharedMetrics.providerRequests, dataForSeoTrends: trendResult.requestCount }, providerCosts: { ...sharedMetrics.providerCosts, trends: trendResult.providerCost, total: searchVolume + trendResult.providerCost }, baselineCache: sharedMetrics.baselineCache } }
}

/** Standalone ingestion composes the same shared and per-window stages once. */
export async function collectLiveIngestionCycle(args) {
  const sharedInputs = args.sharedInputs ?? await collectLiveSharedInputs(args)
  return collectLiveWindowCycle({ ...args, sharedInputs })
}
