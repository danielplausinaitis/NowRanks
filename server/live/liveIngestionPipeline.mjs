import { normalizeDataForSeoSearchVolume } from './dataForSeoSearchVolume.mjs'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'
import { createDataForSeoGraphDiagnostics, mergeDataForSeoGraphDiagnostics } from './dataForSeoTrends.mjs'
import { providerReportedCost, retrieveShadowTrendHistories } from './shadowHistoryRetrieval.mjs'
import { baselineCacheKey, classifyBaselineCache, BASELINE_PROVIDER } from './baselineCache.mjs'
import { mergeGlobalDiscoveryCandidates, rankGlobalDiscoveryCandidates } from './globalDiscovery.mjs'
import { mapSearchVolumeRecordsToCandidates, prepareSearchVolumeKeyword, prepareSearchVolumeLookups } from './searchVolumeKeyword.mjs'

export const MIN_SUCCESSFUL_MULTI_GEO_DISCOVERY_REQUESTS = 3
export const ADAPTIVE_7D_OVERFLOW_BATCH_SIZE = 10
export const ADAPTIVE_7D_OVERFLOW_HARD_MAX_CANDIDATES = 70

function targeting(volumeRequest) {
  return { measurementMode: volumeRequest.measurementMode ?? 'us', measurementTarget: volumeRequest.measurementTarget ?? null, locationCode: volumeRequest.locationCode ?? null, locationName: volumeRequest.locationName ?? null, locationCoordinate: volumeRequest.locationCoordinate ?? null, languageCode: volumeRequest.languageCode ?? null, languageName: volumeRequest.languageName ?? null, searchPartners: volumeRequest.searchPartners ?? false, dateFrom: volumeRequest.dateFrom ?? null, dateTo: volumeRequest.dateTo ?? null }
}

/** Resolves the provider inputs shared by every scheduled window in one slot. */
function discoveryOrder(left, right) {
  return (right.searchVolume - left.searchVolume)
    || ((right.increasePercentage ?? -1) - (left.increasePercentage ?? -1))
    || ((left.providerDiscoveryRank ?? Number.POSITIVE_INFINITY) - (right.providerDiscoveryRank ?? Number.POSITIVE_INFINITY))
    || left.query.localeCompare(right.query)
}

/**
 * Builds a measurement candidate pool from a wider already-discovered universe.
 * The first available candidate from each observed category is included solely
 * to keep discovery opportunities from being erased by source concentration;
 * remaining places use the existing provider-strength order. This is not a
 * score, public-rank, or public-category allocation.
 */
export function selectDiscoveryCoveragePool({ candidates = [], maxPaidCandidates }) {
  if (!Number.isInteger(maxPaidCandidates) || maxPaidCandidates < 1) throw new Error('Discovery coverage selection requires a positive paid-candidate limit')
  const ranked = [...candidates].sort(discoveryOrder)
  const selected = []
  const selectedKeys = new Set()
  const observedCategories = new Set()
  const add = (candidate, discoverySelectionReason) => {
    if (selected.length >= maxPaidCandidates || selectedKeys.has(candidate.normalizedQuery)) return false
    selectedKeys.add(candidate.normalizedQuery)
    selected.push({ ...candidate, discoveryPoolPosition: selected.length + 1, discoverySelectionReason })
    return true
  }
  for (const candidate of ranked) {
    if (!candidate.category || observedCategories.has(candidate.category)) continue
    observedCategories.add(candidate.category)
    add(candidate, 'category-coverage')
  }
  for (const candidate of ranked) add(candidate, 'provider-strength')
  const exclusions = ranked.filter((candidate) => !selectedKeys.has(candidate.normalizedQuery)).map((candidate) => ({
    query: candidate.normalizedQuery,
    category: candidate.category ?? null,
    providerDiscoveryRank: candidate.providerDiscoveryRank ?? null,
    reason: 'paid-discovery-capacity',
  }))
  return {
    candidates: selected,
    diagnostics: {
      observedCategories: [...observedCategories].sort(),
      selectedCategories: [...new Set(selected.map((candidate) => candidate.category).filter(Boolean))].sort(),
      categoryCoverageSelected: selected.filter((candidate) => candidate.discoverySelectionReason === 'category-coverage').length,
      providerStrengthSelected: selected.filter((candidate) => candidate.discoverySelectionReason === 'provider-strength').length,
      discardedBeforePaidMeasurement: exclusions.length,
      exclusions,
    },
  }
}

function uniqueCandidates(candidates, label) {
  const seen = new Set()
  const unique = []
  for (const candidate of candidates ?? []) {
    const key = candidate?.normalizedQuery
    if (!key) throw new Error(`${label} candidates require normalizedQuery`)
    if (seen.has(key)) continue
    seen.add(key); unique.push(candidate)
  }
  return unique
}

/**
 * Resolves baseline rows for exactly the supplied candidates.  The initial
 * 50-topic cohort uses this once; the 7D reserve invokes it only after its
 * first score cannot fill the public board.  This keeps the normal path's
 * provider work unchanged while still reusing the same cache contract.
 */
export async function collectLiveBaselineInputs({ candidates, volumeRequest, volumeClient, baselineCacheRepository, baselineCacheTtlHours = 24, writeBaselineCache = false }) {
  if (!volumeClient?.lookup) throw new Error('Live baseline resolution requires a baseline client')
  const selected = uniqueCandidates(candidates, 'Baseline')
  const cacheKeys = selected.map((candidate) => baselineCacheKey(candidate.normalizedQuery, volumeRequest))
  const cachedRows = baselineCacheRepository ? await baselineCacheRepository.listLiveBaselineDemandCache({ cacheKeys }) : []
  const cache = classifyBaselineCache({ candidates: selected, cachedRows, request: volumeRequest, ttlHours: baselineCacheTtlHours })
  const providerId = volumeRequest.providerId ?? volumeClient.providerId ?? BASELINE_PROVIDER
  const baselineMeasurement = { measurementMode: volumeRequest.measurementMode ?? 'us', measurementTarget: volumeRequest.measurementTarget ?? null, measurementLocation: volumeRequest.geographicScope, measurementLanguage: volumeRequest.languageCode ?? volumeRequest.languageName ?? null }
  const cachedVolumes = cache.fresh.map(({ candidate, row }) => {
    const providerKeywordDiagnostics = prepareSearchVolumeKeyword(candidate)
    return { providerId, query: candidate.query, normalizedQuery: candidate.normalizedQuery, availability: row.availability, searchVolume: row.search_volume, monthlyHistory: row.monthly_history, retrievedAt: row.retrieved_at, geographicScope: volumeRequest.geographicScope, providerKeywordDiagnostics, measurementProvenance: baselineMeasurement, provenance: { providerId, geographicScope: volumeRequest.geographicScope, ...baselineMeasurement, providerKeywordDiagnostics } }
  })
  let refreshed = []; let providerCost = 0
  if (cache.refresh.length) {
    const prepared = prepareSearchVolumeLookups(cache.refresh.map(({ candidate }) => candidate))
    const result = await volumeClient.lookup({ ...volumeRequest, keywords: prepared.providerKeywords })
    const normalize = volumeClient.normalize ?? normalizeDataForSeoSearchVolume
    const providerRecords = normalize({ response: result.response, retrievedAt: result.retrievedAt, geographicScope: volumeRequest.geographicScope })
    refreshed = mapSearchVolumeRecordsToCandidates({ records: providerRecords, preparations: prepared.preparations, providerId, retrievedAt: result.retrievedAt, geographicScope: volumeRequest.geographicScope }).map((record) => ({ ...record, measurementProvenance: { ...baselineMeasurement, providerReturnedLocation: record.providerLocationCode ?? null, providerReturnedLanguage: record.providerLanguageCode ?? null } }))
    providerCost = providerReportedCost(result.response)
    if (writeBaselineCache) await baselineCacheRepository.upsertLiveBaselineDemandCache(refreshed.map((record) => ({ cache_key: baselineCacheKey(record.normalizedQuery, volumeRequest), normalized_query: record.normalizedQuery, provider_id: providerId, targeting: targeting(volumeRequest), availability: record.availability, search_volume: record.searchVolume, monthly_history: record.monthlyHistory, retrieved_at: record.retrievedAt })))
  }
  return {
    volumes: [...cachedVolumes, ...refreshed],
    metrics: {
      providerRequests: cache.refresh.length ? 1 : 0,
      providerCost,
      cache: { freshHits: cache.fresh.length, staleOrMissing: cache.refresh.length, requestedKeywords: cache.refresh.length, requestsAvoided: cache.fresh.length ? 1 : 0, rowsRefreshed: refreshed.length, writesSkipped: !writeBaselineCache },
    },
  }
}

function scoreInputs({ candidates, histories, volumes, vaultGrowthByQuery, vaultGrowthMode }) {
  const volumeByQuery = new Map(volumes.map((record) => [record.normalizedQuery, record]))
  const historyByQuery = new Map(histories.map((record) => [record.normalizedQuery, record]))
  return candidates.map((candidate) => ({
    topic: candidate.query, normalizedQuery: candidate.normalizedQuery, category: candidate.category,
    currentTrendIntensity: candidate, baselineDemand: volumeByQuery.get(candidate.normalizedQuery) ?? null,
    historicalTrendShape: historyByQuery.get(candidate.normalizedQuery) ?? null,
    vaultGrowth: vaultGrowthByQuery.get(candidate.normalizedQuery) ?? null, vaultGrowthMode,
  }))
}

function uniqueKeys(rows) { return new Set((rows ?? []).map((row) => row?.normalizedQuery).filter(Boolean)) }

function hasGlobalMeasurement(record) {
  return record?.measurementProvenance?.measurementMode === 'global'
    && record?.measurementProvenance?.measurementLocation?.kind === 'global'
}

function countReasons(rows) {
  const counts = new Map()
  for (const row of rows) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function safeDiscoveryErrorMessage(error) {
  return String(error?.message ?? error ?? 'unknown discovery failure')
    .replace(/\b(sb_secret_[A-Za-z0-9._-]+|service_role_[A-Za-z0-9._-]+)\b/gi, '[REDACTED]')
    .replace(/\b(authorization|api[ _-]?key|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[REDACTED_URL]')
}

function failureDiagnostic(request, error) {
  const source = error?.discoveryDiagnostic && typeof error.discoveryDiagnostic === 'object' ? error.discoveryDiagnostic : {}
  return {
    geo: request.geo,
    outcome: 'failed',
    requestStatus: source.requestStatus ?? error?.status ?? null,
    classification: source.classification ?? 'unknown-discovery-failure',
    providerError: source.providerError ?? null,
    providerStatus: source.providerStatus ?? null,
    topLevelResponseKeys: Array.isArray(source.topLevelResponseKeys) ? source.topLevelResponseKeys : [],
    trendingSearches: source.trendingSearches ?? { present: false, isArray: false, count: null },
    trendingDataPresent: source.trendingDataPresent === true,
    responseEmpty: source.responseEmpty === true,
    rateLimited: source.rateLimited === true,
    attempts: source.attempts ?? 1,
    maxAttempts: source.maxAttempts ?? 1,
    error: safeDiscoveryErrorMessage(error),
  }
}

function successfulDiscoveryDiagnostic(request, candidates) {
  return {
    geo: request.geo,
    outcome: 'succeeded',
    requestStatus: 'success',
    classification: candidates.length === 0 ? 'valid-empty-response' : 'valid-response',
    candidateCount: candidates.length,
    trendingSearches: { present: true, isArray: true, count: candidates.length },
    trendingDataPresent: true,
    responseEmpty: candidates.length === 0,
    rateLimited: false,
  }
}

function minimumSuccessfulDiscoveryGeos(requestCount) {
  return requestCount > 1 ? Math.min(MIN_SUCCESSFUL_MULTI_GEO_DISCOVERY_REQUESTS, requestCount) : 1
}

/**
 * Discovery geography only selects candidates; the public score uses separate
 * global measurements. A partial feed is defensible only when a three-geo
 * minimum succeeded, and failures remain explicit diagnostics.
 */
export async function collectGeoDiscoveryGroups({ requests, discoveryClient }) {
  const settled = await Promise.allSettled(requests.map(async (request) => {
    const candidates = await discoveryClient.discover(request)
    if (!Array.isArray(candidates)) {
      const error = new Error(`SerpApi discovery for geo ${request.geo} returned a non-array candidate payload`)
      error.discoveryDiagnostic = { geo: request.geo, requestStatus: null, classification: 'malformed-client-discovery-result' }
      throw error
    }
    return { request, candidates }
  }))
  const groups = []
  const diagnostics = settled.map((result, index) => {
    const request = requests[index]
    if (result.status === 'fulfilled') {
      groups.push({ geo: request.geo, language: request.language, candidates: result.value.candidates })
      return successfulDiscoveryDiagnostic(request, result.value.candidates)
    }
    return failureDiagnostic(request, result.reason)
  })
  const requiredSuccessfulGeos = minimumSuccessfulDiscoveryGeos(requests.length)
  const successfulGeos = diagnostics.filter((item) => item.outcome === 'succeeded').map((item) => item.geo)
  const failedGeos = diagnostics.filter((item) => item.outcome === 'failed').map((item) => item.geo)
  const summary = { requestedGeos: requests.map((request) => request.geo), requiredSuccessfulGeos, successfulGeos, failedGeos, requests: diagnostics }
  if (groups.length < requiredSuccessfulGeos) {
    if (requests.length === 1) throw settled[0].reason
    const error = new Error(`Live multi-geo discovery requires at least ${requiredSuccessfulGeos} successful geo responses; received ${groups.length}`)
    error.details = JSON.stringify(summary)
    error.discoveryDiagnostics = summary
    error.retryable = diagnostics.some((item) => item.rateLimited || item.classification === 'network-failure' || [408, 425, 429].includes(item.requestStatus) || Number(item.requestStatus) >= 500)
    throw error
  }
  return { groups, diagnostics: summary }
}

/**
 * This is intentionally a reporting-only view of the exact public 24H funnel.
 * It does not alter tracking, provider requests, or score calculations.
 */
export function publicFunnelDiagnostics({ discoveryCandidates, trackingCandidates, volumes = [], histories, scores, displayLimit, sharedMetrics, trackingDiagnostics = null, selectedPaidTrackingCount = null }) {
  const discovered = sharedMetrics?.cohort?.discovered ?? discoveryCandidates.length
  const discoveryKeys = uniqueKeys(discoveryCandidates)
  const selectedKeys = uniqueKeys(trackingCandidates)
  const measuredKeys = uniqueKeys(histories)
  const historyByQuery = new Map((histories ?? []).map((history) => [history.normalizedQuery, history]))
  const volumeByQuery = new Map((volumes ?? []).map((volume) => [volume.normalizedQuery, volume]))
  const scoreByQuery = new Map((scores ?? []).map((entry) => [entry.normalizedQuery, entry]))
  const unified = (scores ?? []).filter((entry) => Number.isFinite(entry.unifiedRawScore))
  const publicKeys = new Set([...unified]
    .sort((left, right) => right.unifiedRawScore - left.unifiedRawScore || left.topic.localeCompare(right.topic))
    .slice(0, displayLimit)
    .map((entry) => entry.normalizedQuery))
  const selectedByQuery = new Map((trackingDiagnostics?.selected ?? []).map((entry) => [entry.query, entry]))
  const excludedByQuery = new Map((trackingDiagnostics?.exclusions ?? []).map((entry) => [entry.query, entry]))
  const currentDiscoveryExclusions = discoveryCandidates.flatMap((candidate) => {
    const key = candidate.normalizedQuery
    if (!selectedKeys.has(key)) return [{ query: key, reason: excludedByQuery.get(key)?.reason ?? 'not-selected-for-paid-tracking' }]
    if (!measuredKeys.has(key)) return [{ query: key, reason: 'not-measured' }]
    const score = scoreByQuery.get(key)
    if (!score) return [{ query: key, reason: 'not-scored' }]
    if (!Number.isFinite(score.unifiedRawScore)) return [{ query: key, reason: 'unified-score-unavailable' }]
    if (!publicKeys.has(key)) return [{ query: key, reason: 'outside-public-top-20' }]
    return []
  })
  // This is intentionally reporting-only. It makes a partial long-horizon
  // board auditable without relaxing a single global-scoring requirement.
  const candidateEligibility = trackingCandidates.map((candidate) => {
    const key = candidate.normalizedQuery
    const history = historyByQuery.get(key) ?? null
    const baseline = volumeByQuery.get(key) ?? null
    const score = scoreByQuery.get(key) ?? null
    const current = score?.raw?.globalCurrentIntensity ?? null
    const measured = measuredKeys.has(key)
    const currentDiscovery = discoveryKeys.has(key)
    const globalHistory = hasGlobalMeasurement(history)
    const globalBaseline = baseline?.availability === 'available' && hasGlobalMeasurement(baseline)
    const currentIntensityAvailable = Number.isFinite(current?.value)
    const accelerationAvailable = Number.isFinite(score?.components?.growth)
    const momentumAvailable = Number.isFinite(score?.components?.momentum)
    const consistencyAvailable = Number.isFinite(score?.components?.consistency)
    const breakoutAvailable = Number.isFinite(score?.components?.breakout)
    const scoreCalculable = Number.isFinite(score?.unifiedRawScore)
    const publicSelected = publicKeys.has(key)
    let reason = 'public-selected'
    if (!currentDiscovery) reason = 'retained-tracking-not-current-discovery'
    else if (!measured) reason = 'not-measured'
    else if (!score) reason = 'not-scored'
    else if (!currentIntensityAvailable) reason = `current-intensity-unavailable:${current?.reason ?? 'unknown'}`
    else if (!scoreCalculable) reason = 'unified-score-unavailable'
    else if (!publicSelected) reason = 'outside-public-display-limit'
    return {
      query: key,
      currentDiscovery,
      measured,
      validGlobalBaseline: globalBaseline,
      validGlobalHistory: globalHistory,
      currentIntensityAvailable,
      accelerationAvailable,
      momentumAvailable,
      consistencyAvailable,
      breakoutAvailable,
      scoreCalculable,
      unifiedEligible: scoreCalculable,
      publicSelected,
      reason,
    }
  })
  return {
    discovered,
    currentDiscoveryEligible: discoveryCandidates.length,
    protectedFreshDiscovery: (trackingDiagnostics?.selected ?? []).filter((entry) => entry.reservedFreshDiscovery === true).length,
    selectedPaidTracking: selectedPaidTrackingCount ?? trackingCandidates.length,
    actuallyMeasured: trackingCandidates.filter((candidate) => measuredKeys.has(candidate.normalizedQuery)).length,
    measuredCurrentDiscovery: discoveryCandidates.filter((candidate) => selectedKeys.has(candidate.normalizedQuery) && measuredKeys.has(candidate.normalizedQuery)).length,
    scorable: scores.length,
    unified: unified.length,
    publicSelected: publicKeys.size,
    validGlobalBaseline: candidateEligibility.filter((item) => item.validGlobalBaseline).length,
    validGlobalHistory: candidateEligibility.filter((item) => item.validGlobalHistory).length,
    currentIntensityAvailable: candidateEligibility.filter((item) => item.currentIntensityAvailable).length,
    accelerationAvailable: candidateEligibility.filter((item) => item.accelerationAvailable).length,
    momentumAvailable: candidateEligibility.filter((item) => item.momentumAvailable).length,
    consistencyAvailable: candidateEligibility.filter((item) => item.consistencyAvailable).length,
    breakoutAvailable: candidateEligibility.filter((item) => item.breakoutAvailable).length,
    scoreCalculable: candidateEligibility.filter((item) => item.scoreCalculable).length,
    unifiedEligible: candidateEligibility.filter((item) => item.unifiedEligible).length,
    reasonCounts: countReasons(candidateEligibility),
    candidateEligibility,
    currentDiscoveryExclusions,
    selectedCurrentDiscovery: discoveryCandidates.filter((candidate) => selectedByQuery.has(candidate.normalizedQuery)).length,
  }
}

function cycleResult({ candidates, scoringCandidates, discoveryCandidates, volumes, histories, scores, scoredAt, sharedMetrics, trendsRequests, trendsCost, graphMeasurements, trendsCache = null, trendProviderId = 'dataforseo-trends', maximumPaidCandidates, displayLimit, selectedPaidTrackingCount = null, trackedCandidatesAbsentFromCurrentDiscovery = 0, trackingDiagnostics = null, adaptiveOverflow = null, overflowBaselineMetrics = null, overflowCandidates = [] }) {
  const overflowBaseline = overflowBaselineMetrics ?? { providerRequests: 0, providerCost: 0, cache: null }
  const searchVolume = sharedMetrics.providerCosts.searchVolume + overflowBaseline.providerCost
  const measured = new Set(histories.map((record) => record.normalizedQuery))
  return {
    candidates, scoringCandidates, volumes, histories, scores, scoredAt,
    requestMetrics: {
      providerRequests: { ...sharedMetrics.providerRequests, dataForSeoSearchVolume: (sharedMetrics.providerRequests.dataForSeoSearchVolume ?? 0) + overflowBaseline.providerRequests, dataForSeoTrends: trendsRequests },
      providerCosts: { ...sharedMetrics.providerCosts, trends: trendsCost, total: searchVolume + trendsCost },
      baselineCache: sharedMetrics.baselineCache,
      discovery: sharedMetrics.discovery ?? null,
      trendsCache,
      graphMeasurements,
      trendsProvider: trendProviderId,
      evaluation: {
        actualPaidCandidates: candidates.length, maximumPaidCandidates, displayLimit,
        discoveryCandidateCount: discoveryCandidates.length,
        scoringDiscoveryCandidateCount: scoringCandidates.length,
        selectedPaidTrackingCount: selectedPaidTrackingCount ?? candidates.length,
        actualTrendsRequestCount: trendsRequests,
        trackedCandidatesAbsentFromCurrentDiscovery,
        selectedButNotMeasuredCount: candidates.filter((candidate) => !measured.has(candidate.normalizedQuery)).length,
        adaptiveOverflow,
      },
      publicFunnel: publicFunnelDiagnostics({ discoveryCandidates: [...discoveryCandidates, ...overflowCandidates], trackingCandidates: candidates, volumes, histories, scores, displayLimit, sharedMetrics, trackingDiagnostics, selectedPaidTrackingCount }),
    },
  }
}

/**
 * Discovery is deliberately wider than Trends evaluation. Search Volume is pre-warmed for the
 * bounded maximum cohort in one bulk request: its documented task price is request-level, while
 * postponing portions would turn one cache refresh into several paid bulk requests.
 */
export async function collectLiveSharedInputs({ candidateLimit, discoveryLimit = candidateLimit, maxPaidCandidates = candidateLimit, adaptiveOverflowMaxCandidates = maxPaidCandidates, baselineCandidates = null, baselineCandidateLimit = null, discoveryRequest, discoveryRequests = null, cachedDiscovery = null, volumeRequest, discoveryClient, volumeClient, baselineCacheRepository, baselineCacheTtlHours = 24, writeBaselineCache = false, onProgress }) {
  if (!volumeClient?.lookup || (!cachedDiscovery && !discoveryClient?.discover)) throw new Error('Live shared ingestion requires discovery and baseline clients')
  let discovered; let sourceDiscoveryRequest; let requests; let discoveryDiagnostics; let rawProviderResults
  if (cachedDiscovery) {
    discovered = cachedDiscovery.candidates
    sourceDiscoveryRequest = cachedDiscovery.discoveryRequest
    requests = cachedDiscovery.discoveryRequests
    discoveryDiagnostics = cachedDiscovery.discoveryDiagnostics
    rawProviderResults = discovered.length
    onProgress?.('discovery cache')
  } else {
    onProgress?.('discovery')
    requests = discoveryRequests?.length ? discoveryRequests : [discoveryRequest]
    const discovery = await collectGeoDiscoveryGroups({ requests, discoveryClient })
    const groups = discovery.groups
    discovered = groups.length === 1 ? groups[0].candidates : rankGlobalDiscoveryCandidates(mergeGlobalDiscoveryCandidates(groups))
    sourceDiscoveryRequest = groups.length === 1 ? discoveryRequest : {
      ...discoveryRequest, geo: null, geographicScope: { kind: 'multi-country', countryCodes: groups.map((group) => group.geo) },
    }
    discoveryDiagnostics = discovery.diagnostics
    rawProviderResults = groups.reduce((sum, group) => sum + (group.candidates[0]?.rawProviderResultCount ?? group.candidates.length), 0)
  }
  const rankedEligibleDiscovery = discovered
    .filter((candidate) => candidate.category && Number.isFinite(candidate.searchVolume))
    .sort(discoveryOrder)
  const discoveryPool = rankedEligibleDiscovery.slice(0, discoveryLimit)
  const discoveryCoverage = selectDiscoveryCoveragePool({ candidates: discoveryPool, maxPaidCandidates })
  // Preserve coverage selection order. Cache freshness is useful baseline
  // evidence but must not move a source-concentrated category ahead of the
  // current discovery opportunities selected above.
  const candidates = discoveryCoverage.candidates
  if (candidates.length < 2) throw new Error('Live discovery returned fewer than two eligible candidates; no persistence plan was created')
  onProgress?.('baseline demand')
  // Keep a raw, deterministic current-discovery reserve. It is intentionally
  // not baseline-looked-up or history-measured unless the 7D public board is
  // short after the unchanged normal 50-topic tracking cohort.
  const selectedKeys = uniqueKeys(candidates)
  const overflowReserveCandidates = rankedEligibleDiscovery
    .filter((candidate) => !selectedKeys.has(candidate.normalizedQuery))
    .slice(0, Math.max(0, adaptiveOverflowMaxCandidates - maxPaidCandidates))
  // Scheduler preparation may refresh the 7D reserve in the same daily bulk
  // request. Manual ingestion deliberately keeps the old initial-cohort shape.
  const baselineRefreshCandidates = uniqueCandidates(baselineCandidates ?? [...candidates, ...overflowReserveCandidates].slice(0, baselineCandidateLimit ?? candidates.length), 'Baseline refresh')
  const baseline = await collectLiveBaselineInputs({ candidates: baselineRefreshCandidates, volumeRequest, volumeClient, baselineCacheRepository, baselineCacheTtlHours, writeBaselineCache })
  return { candidates, overflowReserveCandidates, discoveryCandidates: discovered, volumes: baseline.volumes, discoveryRequest: sourceDiscoveryRequest, discoveryRequests: requests, measurementTarget: volumeRequest.measurementTarget ?? null, sharedMetrics: { providerRequests: { serpApi: cachedDiscovery ? 0 : requests.length, dataForSeoSearchVolume: baseline.metrics.providerRequests }, providerCosts: { searchVolume: baseline.metrics.providerCost, serpApi: 'plan-dependent' }, discovery: discoveryDiagnostics, baselineCache: baseline.metrics.cache, cohort: { rawProviderResults, normalizedCandidates: discovered.length, classifiedCandidates: discovered.filter((candidate) => candidate.category).length, discovered: discovered.length, discoveryPool: discoveryPool.length, paidDiscoverySelected: candidates.length, baselinePrepared: baselineRefreshCandidates.length, adaptiveOverflowReserve: overflowReserveCandidates.length, discoveryCoverage: discoveryCoverage.diagnostics } } }
}

/** Retrieves and scores only the history that is specific to one selected window. */
export async function collectLiveWindowCycle({ sharedInputs, paidTrackingCandidates = null, trackingDiagnostics = null, historyRequest, historyWindow, trendsMode, trendsClient, historyRetriever = null, trendProviderId = 'dataforseo-trends', trendsCacheRepository = null, trendsRefreshMinutes = 480, writeTrendsCache = false, scoreCycle, displayLimit = 10, initialPaidCandidates, maxPaidCandidates, adaptiveOverflowMaxCandidates = maxPaidCandidates, adaptiveOverflowBatchSize = ADAPTIVE_7D_OVERFLOW_BATCH_SIZE, overflowBaselineResolver = null, vaultGrowthByQuery = new Map(), vaultGrowthMode = 'off', onProgress }) {
  if (!sharedInputs?.candidates || !sharedInputs?.volumes) throw new Error('Resolved live shared inputs are required')
  if ((!historyRetriever && !trendsClient?.measure) || typeof scoreCycle !== 'function') throw new Error('Live window ingestion requires Trends and scoring clients')
  const { candidates: discoveryCandidates, volumes, discoveryRequest, sharedMetrics } = sharedInputs
  const trackingCandidates = paidTrackingCandidates === null ? null : uniqueCandidates(paidTrackingCandidates, 'Paid tracking')
  if (trackingCandidates && trackingCandidates.length > maxPaidCandidates) throw new Error(`Selected paid tracking cohort exceeds configured maximum of ${maxPaidCandidates}`)
  onProgress?.('history')
  // Tracking and public scoring are intentionally separate. A selected continuity or
  // retry topic must always get its paid curve, but it is never promoted into public
  // scoring merely because it was retained for historical continuity.
  const retrieveHistories = (candidates) => historyRetriever
    ? historyRetriever({ candidates, mode: trendsMode, client: trendsClient, request: historyRequest, geographicScope: historyRequest.geographicScope ?? discoveryRequest.geographicScope, cacheRepository: trendsCacheRepository, refreshMinutes: trendsRefreshMinutes, writeCache: writeTrendsCache })
    : retrieveShadowTrendHistories({ candidates, mode: trendsMode, client: trendsClient, request: historyRequest, geographicScope: historyRequest.geographicScope ?? discoveryRequest.geographicScope, adapter: createLiveTrendProviderAdapter({ providerId: trendProviderId }) })
  if (trackingCandidates) {
    const trendResult = await retrieveHistories(trackingCandidates)
    const trackingKeys = uniqueKeys(trackingCandidates)
    const measuredTrackingKeys = uniqueKeys(trendResult.histories)
    // Public scoring is strictly current discovery intersected with the paid
    // cohort that actually produced a provider-history record. Retained-only
    // tracking may be measured for continuity but cannot become a public row.
    let overflowCandidates = []
    let histories = [...trendResult.histories]
    let allVolumes = [...volumes]
    let trendsRequests = trendResult.requestCount
    let trendsCost = trendResult.providerCost
    let trendsCache = trendResult.cache ?? null
    const graphMeasurements = createDataForSeoGraphDiagnostics()
    mergeDataForSeoGraphDiagnostics(graphMeasurements, trendResult.graphMeasurements)
    let overflowBaselineMetrics = null
    const scoringCurrentCandidates = () => [...discoveryCandidates, ...overflowCandidates]
      .filter((candidate) => uniqueKeys(histories).has(candidate.normalizedQuery))
    let scoringCandidates = scoringCurrentCandidates()
    onProgress?.('scoring')
    let scores = scoringCandidates.length
      ? await scoreCycle({ candidates: scoreInputs({ candidates: scoringCandidates, histories, volumes: allVolumes, vaultGrowthByQuery, vaultGrowthMode }), historyWindow, coldStartMaxAgeHours: discoveryRequest.hours ?? 24 })
      : []
    const initialPublicValid = scores.filter((entry) => Number.isFinite(entry.unifiedRawScore)).length
    const reserve = uniqueCandidates(sharedInputs.overflowReserveCandidates ?? [], 'Adaptive 7D overflow')
      .filter((candidate) => !trackingKeys.has(candidate.normalizedQuery))
    const adaptiveOverflow = {
      enabled: historyWindow === '7D', triggered: false, initialMeasured: trendResult.histories.length,
      initialPublicValid, targetPublicValid: displayLimit, maxTotalCandidates: adaptiveOverflowMaxCandidates,
      reserveAvailable: reserve.length, initialTrendsRequests: trendResult.requestCount, initialTrendsCost: trendResult.providerCost,
      incrementalProviderRequests: { dataForSeoSearchVolume: 0, dataForSeoTrends: 0 }, incrementalProviderCost: { searchVolume: 0, trends: 0, total: 0 },
      batches: [], stopReason: initialPublicValid >= displayLimit ? 'initial-board-complete' : 'not-applicable',
    }
    if (historyWindow === '7D' && initialPublicValid < displayLimit) {
      if (!Number.isInteger(adaptiveOverflowMaxCandidates) || adaptiveOverflowMaxCandidates < trackingCandidates.length || adaptiveOverflowMaxCandidates > ADAPTIVE_7D_OVERFLOW_HARD_MAX_CANDIDATES) throw new Error(`7D adaptive overflow maximum must be between ${trackingCandidates.length} and ${ADAPTIVE_7D_OVERFLOW_HARD_MAX_CANDIDATES}`)
      if (!Number.isInteger(adaptiveOverflowBatchSize) || adaptiveOverflowBatchSize < 1) throw new Error('7D adaptive overflow batch size must be positive')
      adaptiveOverflow.triggered = true
      if (reserve.length && trackingCandidates.length < adaptiveOverflowMaxCandidates && typeof overflowBaselineResolver !== 'function') throw new Error('7D adaptive overflow requires the baseline cache resolver')
      let cursor = 0
      while (trackingCandidates.length + overflowCandidates.length < adaptiveOverflowMaxCandidates && cursor < reserve.length) {
        const available = adaptiveOverflowMaxCandidates - trackingCandidates.length - overflowCandidates.length
        const batch = reserve.slice(cursor, cursor + Math.min(adaptiveOverflowBatchSize, available))
        cursor += batch.length
        if (!batch.length) break
        // Baselines are resolved only for a triggered reserve batch. The same
        // resolver uses the normal cache and never needs to re-request the
        // initial cohort.
        const baseline = overflowBaselineResolver ? await overflowBaselineResolver(batch) : { volumes: [], metrics: { providerRequests: 0, providerCost: 0, cache: null } }
        overflowBaselineMetrics = {
          providerRequests: (overflowBaselineMetrics?.providerRequests ?? 0) + (baseline.metrics?.providerRequests ?? 0),
          providerCost: (overflowBaselineMetrics?.providerCost ?? 0) + (baseline.metrics?.providerCost ?? 0),
          cache: baseline.metrics?.cache ?? overflowBaselineMetrics?.cache ?? null,
        }
        allVolumes = [...allVolumes, ...(baseline.volumes ?? [])]
        const batchTrendResult = await retrieveHistories(batch)
        overflowCandidates.push(...batch)
        histories.push(...batchTrendResult.histories)
        trendsRequests += batchTrendResult.requestCount
        trendsCost += batchTrendResult.providerCost
        trendsCache = batchTrendResult.cache ?? trendsCache
        mergeDataForSeoGraphDiagnostics(graphMeasurements, batchTrendResult.graphMeasurements)
        adaptiveOverflow.incrementalProviderRequests.dataForSeoSearchVolume += baseline.metrics?.providerRequests ?? 0
        adaptiveOverflow.incrementalProviderRequests.dataForSeoTrends += batchTrendResult.requestCount
        adaptiveOverflow.incrementalProviderCost.searchVolume += baseline.metrics?.providerCost ?? 0
        adaptiveOverflow.incrementalProviderCost.trends += batchTrendResult.providerCost
        adaptiveOverflow.incrementalProviderCost.total = adaptiveOverflow.incrementalProviderCost.searchVolume + adaptiveOverflow.incrementalProviderCost.trends
        scoringCandidates = scoringCurrentCandidates()
        onProgress?.('scoring')
        scores = scoringCandidates.length
          ? await scoreCycle({ candidates: scoreInputs({ candidates: scoringCandidates, histories, volumes: allVolumes, vaultGrowthByQuery, vaultGrowthMode }), historyWindow, coldStartMaxAgeHours: discoveryRequest.hours ?? 24 })
          : []
        const publicValid = scores.filter((entry) => Number.isFinite(entry.unifiedRawScore)).length
        adaptiveOverflow.batches.push({ candidateCount: batch.length, candidates: batch.map((candidate) => candidate.normalizedQuery), measured: batchTrendResult.histories.length, publicValid, baselineRequests: baseline.metrics?.providerRequests ?? 0, baselineCost: baseline.metrics?.providerCost ?? 0, trendsRequests: batchTrendResult.requestCount, trendsCost: batchTrendResult.providerCost })
        if (publicValid >= displayLimit) { adaptiveOverflow.stopReason = 'public-board-complete'; break }
      }
      if (adaptiveOverflow.stopReason !== 'public-board-complete') adaptiveOverflow.stopReason = trackingCandidates.length + overflowCandidates.length >= adaptiveOverflowMaxCandidates ? 'adaptive-maximum-reached' : 'reserve-exhausted'
    }
    adaptiveOverflow.finalMeasured = histories.length
    adaptiveOverflow.finalPublicValid = scores.filter((entry) => Number.isFinite(entry.unifiedRawScore)).length
    adaptiveOverflow.finalCandidateCount = trackingCandidates.length + overflowCandidates.length
    const finalCandidates = [...trackingCandidates, ...overflowCandidates]
    const finalKeys = uniqueKeys(finalCandidates)
    const evaluatedVolumes = allVolumes.filter((record) => finalKeys.has(record.normalizedQuery))
    const scoredAt = [...finalCandidates.map((candidate) => candidate.retrievedAt), ...evaluatedVolumes.map((record) => record.retrievedAt), ...histories.map((record) => record.retrievedAt)].filter(Boolean).sort().at(-1)
    return cycleResult({
      candidates: finalCandidates, scoringCandidates, volumes: evaluatedVolumes, histories, scores, scoredAt,
      discoveryCandidates,
      sharedMetrics, trendsRequests, trendsCost, graphMeasurements, trendsCache, trendProviderId,
      maximumPaidCandidates: historyWindow === '7D' ? adaptiveOverflowMaxCandidates : maxPaidCandidates, displayLimit, selectedPaidTrackingCount: trackingCandidates.length,
      trackedCandidatesAbsentFromCurrentDiscovery: trackingCandidates.filter((candidate) => !discoveryCandidates.some((discovery) => discovery.normalizedQuery === candidate.normalizedQuery)).length,
      trackingDiagnostics, adaptiveOverflow, overflowBaselineMetrics, overflowCandidates,
    })
  }
  const availableCandidates = discoveryCandidates
  const maximum = Math.min(maxPaidCandidates ?? availableCandidates.length, availableCandidates.length)
  const initial = Math.min(initialPaidCandidates ?? maximum, maximum)
  const evaluated = []; const histories = []; let trendsRequests = 0; let trendsCost = 0; let scores = []
  const graphMeasurements = createDataForSeoGraphDiagnostics(); let trendsCache = null
  while (evaluated.length < maximum) {
    const batchSize = evaluated.length === 0 ? initial : Math.min(initial, maximum - evaluated.length)
    const batch = availableCandidates.slice(evaluated.length, evaluated.length + batchSize)
    const trendResult = await retrieveHistories(batch)
    evaluated.push(...batch); histories.push(...trendResult.histories); trendsRequests += trendResult.requestCount; trendsCost += trendResult.providerCost
    trendsCache = trendResult.cache ?? trendsCache
    mergeDataForSeoGraphDiagnostics(graphMeasurements, trendResult.graphMeasurements)
    onProgress?.('scoring')
    const measuredCandidates = evaluated.filter((candidate) => uniqueKeys(histories).has(candidate.normalizedQuery))
    scores = measuredCandidates.length
      ? await scoreCycle({ candidates: scoreInputs({ candidates: measuredCandidates, histories, volumes, vaultGrowthByQuery, vaultGrowthMode }), historyWindow, coldStartMaxAgeHours: discoveryRequest.hours ?? 24 })
      : []
    const ranked = scores.filter((entry) => Number.isFinite(entry.unifiedRawScore)).length
    if (ranked >= displayLimit) break
  }
  const evaluatedVolumes = volumes.filter((record) => evaluated.some((candidate) => candidate.normalizedQuery === record.normalizedQuery))
  const measuredCandidates = evaluated.filter((candidate) => uniqueKeys(histories).has(candidate.normalizedQuery))
  return cycleResult({ candidates: evaluated, scoringCandidates: measuredCandidates, discoveryCandidates, volumes: evaluatedVolumes, histories, scores, scoredAt: [...evaluated.map((x) => x.retrievedAt), ...evaluatedVolumes.map((x) => x.retrievedAt), ...histories.map((x) => x.retrievedAt)].filter(Boolean).sort().at(-1), sharedMetrics, trendsRequests, trendsCost, graphMeasurements, trendsCache, trendProviderId, maximumPaidCandidates: maximum, displayLimit })
}

/** Standalone ingestion composes the same shared and per-window stages once. */
export async function collectLiveIngestionCycle(args) {
  const sharedInputs = args.sharedInputs ?? await collectLiveSharedInputs(args)
  return collectLiveWindowCycle({ ...args, sharedInputs })
}
