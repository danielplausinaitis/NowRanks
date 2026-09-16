import { createHash } from 'node:crypto'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'
import { googleTrendsProviderReportedCost, normalizeDataForSeoGoogleTrendsMeasurement, normalizeGoogleTrendsProviderKeyword } from './dataForSeoGoogleTrends.mjs'
import { createDataForSeoGraphDiagnostics, mergeDataForSeoGraphDiagnostics } from './dataForSeoTrends.mjs'
import { DEFAULT_GOOGLE_TRENDS_REFRESH_MINUTES, GOOGLE_TRENDS_HISTORY_PROVIDER, classifyGoogleTrendsHistoryCache, googleTrendsCacheRow, googleTrendsHistoryCacheKey } from './googleTrendsCache.mjs'

export const GOOGLE_TRENDS_MAX_KEYWORDS_PER_REQUEST = 5

/** Deterministic membership makes batches, response mapping, and retries auditable. */
export function buildGoogleTrendsBatches(candidates, maxKeywords = GOOGLE_TRENDS_MAX_KEYWORDS_PER_REQUEST) {
  if (!Number.isInteger(maxKeywords) || maxKeywords < 1 || maxKeywords > GOOGLE_TRENDS_MAX_KEYWORDS_PER_REQUEST) throw new Error('Google Trends batch size must be between one and five')
  const seen = new Set(); const unique = []
  for (const candidate of candidates ?? []) {
    if (!candidate?.normalizedQuery || !candidate?.query) throw new Error('Google Trends batches require query and normalizedQuery')
    if (seen.has(candidate.normalizedQuery)) throw new Error(`Google Trends candidate identity collision: ${candidate.normalizedQuery}`)
    seen.add(candidate.normalizedQuery); unique.push(candidate)
  }
  const sorted = unique.sort((left, right) => left.normalizedQuery.localeCompare(right.normalizedQuery) || left.query.localeCompare(right.query))
  // Canonical candidates may intentionally share one exact provider lookup.
  // Group by only the conservative provider-label normalizer; candidate identity
  // remains `normalizedQuery` and is fanned back out after the response is proven.
  const byProviderKeyword = new Map()
  for (const candidate of sorted) {
    const providerKeywordNormalized = normalizeGoogleTrendsProviderKeyword(candidate.query)
    const group = byProviderKeyword.get(providerKeywordNormalized) ?? []
    group.push(candidate)
    byProviderKeyword.set(providerKeywordNormalized, group)
  }
  const lookups = [...byProviderKeyword.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerKeywordNormalized, members]) => ({
      providerKeywordNormalized,
      providerKeyword: members[0].query,
      candidates: members,
    }))
  const batches = []
  for (let index = 0; index < lookups.length; index += maxKeywords) {
    const group = lookups.slice(index, index + maxKeywords)
    // The provider's normalization cohort is its unique lookup membership, not
    // inbound candidate order or duplicate canonical aliases.
    const fingerprint = createHash('sha256').update(JSON.stringify(group.map((lookup) => lookup.providerKeywordNormalized))).digest('hex')
    const requestMap = group.map((lookup, requestIndex) => ({
      requestIndex,
      providerKeyword: lookup.providerKeyword,
      providerKeywordNormalized: lookup.providerKeywordNormalized,
      canonicalCandidates: lookup.candidates.map((candidate) => ({
        canonicalCandidateIdentity: candidate.normalizedQuery,
        canonicalQuery: candidate.query,
      })),
    }))
    const candidateByIdentity = new Map(sorted.map((candidate) => [candidate.normalizedQuery, candidate]))
    const batchCandidates = requestMap.flatMap((lookup) => lookup.canonicalCandidates.map(({ canonicalCandidateIdentity }) => candidateByIdentity.get(canonicalCandidateIdentity)))
    batches.push({
      id: `google-trends-batch-${fingerprint.slice(0, 16)}`,
      fingerprint,
      index: batches.length,
      keywords: requestMap.map((lookup) => lookup.providerKeyword),
      candidates: batchCandidates,
      requestMap,
    })
  }
  return batches
}

function cachedHistory(row) {
  return row?.history && typeof row.history === 'object'
    ? { ...row.history, retrievedAt: row.retrieved_at, cache: { cacheKey: row.cache_key, retrievedAt: row.retrieved_at, batchId: row.batch_id ?? null, batchFingerprint: row.batch_fingerprint ?? null } }
    : null
}

/**
 * Google Trends normalizes multi-keyword graphs to the batch's largest comparable term.
 * We therefore preserve candidate-local curves only, record the exact batch fingerprint,
 * and never claim cross-batch comparability.
 */
export async function retrieveGoogleTrendsHistories({ candidates, client, request = {}, geographicScope, cacheRepository = null, writeCache = false, refreshMinutes = DEFAULT_GOOGLE_TRENDS_REFRESH_MINUTES, now = new Date() }) {
  if (!client?.explore) throw new Error('Google Trends history retrieval requires a Google Trends client')
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('Google Trends history retrieval requires candidates')
  const providerId = request.providerId ?? GOOGLE_TRENDS_HISTORY_PROVIDER
  const cacheKeys = candidates.map((candidate) => googleTrendsHistoryCacheKey({ normalizedQuery: candidate.normalizedQuery, providerId, measurementMode: request.measurementMode ?? 'global', measurementTarget: request.measurementTarget ?? null, timeRange: request.timeRange, resamplingId: request.resamplingId }))
  const cachedRows = cacheRepository?.listLiveGoogleTrendsHistoryCache ? await cacheRepository.listLiveGoogleTrendsHistoryCache({ cacheKeys }) : []
  const cache = classifyGoogleTrendsHistoryCache({ candidates, cachedRows, request, now, refreshMinutes, providerId })
  const histories = cache.fresh.map(({ row }) => cachedHistory(row)).filter(Boolean)
  const graphMeasurements = createDataForSeoGraphDiagnostics()
  let providerCost = 0; let requestCount = 0; const refreshed = []
  for (const batch of buildGoogleTrendsBatches(cache.refresh.map(({ candidate }) => candidate))) {
    const measured = await client.explore({
      keywords: batch.keywords,
      timeRange: request.timeRange,
      measurementTarget: request.measurementMode ?? 'global',
    })
    requestCount += 1; providerCost += googleTrendsProviderReportedCost(measured.response)
    const normalized = normalizeDataForSeoGoogleTrendsMeasurement({
      response: measured.response,
      candidates: batch.candidates,
      geographicScope,
      retrievedAt: measured.retrievedAt,
      adapter: createLiveTrendProviderAdapter({ providerId }),
      requestMetadata: { ...measured.task, measurementMode: request.measurementMode ?? 'global', measurementTarget: request.measurementTarget ?? null }, batch,
    })
    histories.push(...normalized.histories)
    refreshed.push(...normalized.histories.map((history) => googleTrendsCacheRow({ history, request, batch, retrievedAt: measured.retrievedAt })))
    mergeDataForSeoGraphDiagnostics(graphMeasurements, normalized.diagnostics)
  }
  if (writeCache && refreshed.length) await cacheRepository.upsertLiveGoogleTrendsHistoryCache(refreshed)
  return { histories, requestCount, providerCost, graphMeasurements, cache: { freshHits: cache.fresh.length, staleOrMissing: cache.refresh.length, rowsRefreshed: refreshed.length, requestsAvoided: candidates.length - cache.refresh.length, writesSkipped: !writeCache } }
}
