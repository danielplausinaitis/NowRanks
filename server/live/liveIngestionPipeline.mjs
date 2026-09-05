import { normalizeDataForSeoSearchVolume } from './dataForSeoSearchVolume.mjs'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'
import { providerReportedCost, retrieveShadowTrendHistories } from './shadowHistoryRetrieval.mjs'
import { baselineCacheKey, classifyBaselineCache, BASELINE_PROVIDER } from './baselineCache.mjs'

function targeting(volumeRequest) {
  return { locationCode: volumeRequest.locationCode ?? null, locationName: volumeRequest.locationName ?? null, locationCoordinate: volumeRequest.locationCoordinate ?? null, languageCode: volumeRequest.languageCode ?? null, languageName: volumeRequest.languageName ?? null, searchPartners: volumeRequest.searchPartners ?? false, dateFrom: volumeRequest.dateFrom ?? null, dateTo: volumeRequest.dateTo ?? null }
}

/** Resolves the provider inputs shared by every scheduled window in one slot. */
function discoveryOrder(left, right) {
  return (right.searchVolume - left.searchVolume)
    || ((right.increasePercentage ?? -1) - (left.increasePercentage ?? -1))
    || left.query.localeCompare(right.query)
}

/**
 * Discovery is deliberately wider than Trends evaluation. Search Volume is pre-warmed for the
 * bounded maximum cohort in one bulk request: its documented task price is request-level, while
 * postponing portions would turn one cache refresh into several paid bulk requests.
 */
export async function collectLiveSharedInputs({ candidateLimit, discoveryLimit = candidateLimit, maxPaidCandidates = candidateLimit, discoveryRequest, volumeRequest, discoveryClient, volumeClient, baselineCacheRepository, baselineCacheTtlHours = 24, writeBaselineCache = false, onProgress }) {
  if (!discoveryClient?.discover || !volumeClient?.lookup) throw new Error('Live shared ingestion requires discovery and baseline clients')
  onProgress?.('discovery')
  const discovered = await discoveryClient.discover(discoveryRequest)
  const discoveryPool = discovered
    .filter((candidate) => candidate.category && Number.isFinite(candidate.searchVolume))
    .sort(discoveryOrder)
    .slice(0, discoveryLimit)
  // Cached available baselines are useful cheap evidence for prioritisation; they do not make a
  // topic eligible, and stale/missing records are never treated as usable baselines.
  const poolCacheKeys = discoveryPool.map((candidate) => baselineCacheKey(candidate.normalizedQuery, volumeRequest))
  const poolCachedRows = baselineCacheRepository ? await baselineCacheRepository.listLiveBaselineDemandCache({ cacheKeys: poolCacheKeys }) : []
  const poolCache = classifyBaselineCache({ candidates: discoveryPool, cachedRows: poolCachedRows, request: volumeRequest, ttlHours: baselineCacheTtlHours })
  const freshAvailable = new Set(poolCache.fresh.filter(({ row }) => row.availability === 'available').map(({ candidate }) => candidate.normalizedQuery))
  const candidates = [...discoveryPool].sort((left, right) => Number(freshAvailable.has(right.normalizedQuery)) - Number(freshAvailable.has(left.normalizedQuery)) || discoveryOrder(left, right)).slice(0, maxPaidCandidates)
  if (candidates.length < 2) throw new Error('Live discovery returned fewer than two eligible candidates; no persistence plan was created')
  onProgress?.('baseline demand')
  const cache = classifyBaselineCache({ candidates, cachedRows: poolCachedRows, request: volumeRequest, ttlHours: baselineCacheTtlHours })
  const cachedVolumes = cache.fresh.map(({ candidate, row }) => ({ providerId: BASELINE_PROVIDER, query: candidate.query, normalizedQuery: candidate.normalizedQuery, availability: row.availability, searchVolume: row.search_volume, monthlyHistory: row.monthly_history, retrievedAt: row.retrieved_at, geographicScope: discoveryRequest.geographicScope }))
  let refreshed = []; let volumeCost = 0
  if (cache.refresh.length) {
    const result = await volumeClient.lookup({ ...volumeRequest, keywords: cache.refresh.map(({ candidate }) => candidate.query) })
    refreshed = normalizeDataForSeoSearchVolume({ response: result.response, retrievedAt: result.retrievedAt, geographicScope: discoveryRequest.geographicScope })
    volumeCost = providerReportedCost(result.response)
    if (writeBaselineCache) await baselineCacheRepository.upsertLiveBaselineDemandCache(refreshed.map((record) => ({ cache_key: baselineCacheKey(record.normalizedQuery, volumeRequest), normalized_query: record.normalizedQuery, provider_id: BASELINE_PROVIDER, targeting: targeting(volumeRequest), availability: record.availability, search_volume: record.searchVolume, monthly_history: record.monthlyHistory, retrieved_at: record.retrievedAt })))
  }
  return { candidates, volumes: [...cachedVolumes, ...refreshed], discoveryRequest, sharedMetrics: { providerRequests: { serpApi: 1, dataForSeoSearchVolume: cache.refresh.length ? 1 : 0 }, providerCosts: { searchVolume: volumeCost, serpApi: 'plan-dependent' }, baselineCache: { freshHits: cache.fresh.length, staleOrMissing: cache.refresh.length, requestedKeywords: cache.refresh.length, requestsAvoided: cache.fresh.length ? 1 : 0, rowsRefreshed: refreshed.length, writesSkipped: !writeBaselineCache }, cohort: { discovered: discovered.length, discoveryPool: discoveryPool.length, baselinePrepared: candidates.length } } }
}

/** Retrieves and scores only the history that is specific to one selected window. */
export async function collectLiveWindowCycle({ sharedInputs, historyRequest, historyWindow, trendsMode, trendsClient, scoreCycle, displayLimit = 10, initialPaidCandidates, maxPaidCandidates, onProgress }) {
  if (!sharedInputs?.candidates || !sharedInputs?.volumes) throw new Error('Resolved live shared inputs are required')
  if (!trendsClient?.measure || typeof scoreCycle !== 'function') throw new Error('Live window ingestion requires Trends and scoring clients')
  const { candidates: availableCandidates, volumes, discoveryRequest, sharedMetrics } = sharedInputs
  onProgress?.('history')
  const maximum = Math.min(maxPaidCandidates ?? availableCandidates.length, availableCandidates.length)
  const initial = Math.min(initialPaidCandidates ?? maximum, maximum)
  const evaluated = []; const histories = []; let trendsRequests = 0; let trendsCost = 0; let scores = []
  const graphMeasurements = { invalidOrMissingMeasurements: 0, affectedCandidates: 0 }
  const volumeByQuery = new Map(volumes.map((record) => [record.normalizedQuery, record]))
  while (evaluated.length < maximum) {
    const batchSize = evaluated.length === 0 ? initial : Math.min(initial, maximum - evaluated.length)
    const batch = availableCandidates.slice(evaluated.length, evaluated.length + batchSize)
    const trendResult = await retrieveShadowTrendHistories({ candidates: batch, mode: trendsMode, client: trendsClient, request: historyRequest, geographicScope: discoveryRequest.geographicScope, adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' }) })
    evaluated.push(...batch); histories.push(...trendResult.histories); trendsRequests += trendResult.requestCount; trendsCost += trendResult.providerCost
    graphMeasurements.invalidOrMissingMeasurements += trendResult.graphMeasurements.invalidOrMissingMeasurements
    graphMeasurements.affectedCandidates += trendResult.graphMeasurements.affectedCandidates
    const historyByQuery = new Map(histories.map((record) => [record.normalizedQuery, record]))
    const scoringInputs = evaluated.map((candidate) => ({ topic: candidate.query, normalizedQuery: candidate.normalizedQuery, category: candidate.category, currentTrendIntensity: candidate, baselineDemand: volumeByQuery.get(candidate.normalizedQuery) ?? null, historicalTrendShape: historyByQuery.get(candidate.normalizedQuery) ?? null }))
    onProgress?.('scoring')
    scores = await scoreCycle({ candidates: scoringInputs, historyWindow, coldStartMaxAgeHours: discoveryRequest.hours ?? 24 })
    const ranked = scores.filter((entry) => Number.isFinite(entry.shadowTrendingScore) || Number.isFinite(entry.shadowEmergingTrendingScore)).length
    if (ranked >= displayLimit) break
  }
  const searchVolume = sharedMetrics.providerCosts.searchVolume
  const evaluatedVolumes = volumes.filter((record) => evaluated.some((candidate) => candidate.normalizedQuery === record.normalizedQuery))
  return { candidates: evaluated, volumes: evaluatedVolumes, histories, scores, scoredAt: [...evaluated.map((x) => x.retrievedAt), ...evaluatedVolumes.map((x) => x.retrievedAt), ...histories.map((x) => x.retrievedAt)].filter(Boolean).sort().at(-1), requestMetrics: { providerRequests: { ...sharedMetrics.providerRequests, dataForSeoTrends: trendsRequests }, providerCosts: { ...sharedMetrics.providerCosts, trends: trendsCost, total: searchVolume + trendsCost }, baselineCache: sharedMetrics.baselineCache, graphMeasurements, evaluation: { actualPaidCandidates: evaluated.length, maximumPaidCandidates: maximum, displayLimit } } }
}

/** Standalone ingestion composes the same shared and per-window stages once. */
export async function collectLiveIngestionCycle(args) {
  const sharedInputs = args.sharedInputs ?? await collectLiveSharedInputs(args)
  return collectLiveWindowCycle({ ...args, sharedInputs })
}
