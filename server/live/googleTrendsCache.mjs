import { createHash } from 'node:crypto'
import { isCrossQueryComparabilityStatus } from './provenanceComparability.mjs'
import { mapGoogleTrendsGraphKeywordColumns } from './dataForSeoGoogleTrends.mjs'

export const GOOGLE_TRENDS_HISTORY_PROVIDER = 'dataforseo-google-trends'
export const GOOGLE_TRENDS_RESAMPLING_ID = 'google-trends-hourly-mean-v1'
export const DEFAULT_GOOGLE_TRENDS_REFRESH_MINUTES = 480

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value ?? null
}

export function googleTrendsHistoryCacheIdentity({ normalizedQuery, providerId = GOOGLE_TRENDS_HISTORY_PROVIDER, measurementMode = 'global', measurementTarget = null, timeRange, resamplingId = GOOGLE_TRENDS_RESAMPLING_ID }) {
  if (typeof normalizedQuery !== 'string' || !normalizedQuery) throw new Error('Google Trends cache identity requires normalizedQuery')
  if (typeof providerId !== 'string' || !providerId) throw new Error('Google Trends cache identity requires providerId')
  if (typeof timeRange !== 'string' || !timeRange) throw new Error('Google Trends cache identity requires timeRange')
  return stable({ normalizedQuery, providerId, measurementMode, measurementTarget, timeRange, resamplingId })
}

export function googleTrendsHistoryCacheKey(input) {
  return createHash('sha256').update(JSON.stringify(googleTrendsHistoryCacheIdentity(input))).digest('hex')
}

/** Reject cache rows written before the shared provenance contract existed. */
export function hasValidGoogleTrendsCacheProvenance(history, providerId = GOOGLE_TRENDS_HISTORY_PROVIDER) {
  if (history?.provenance?.providerId !== providerId || !isCrossQueryComparabilityStatus(history.provenance.crossQueryComparability?.status)) return false
  // Cache rows store the source's raw returned label alongside the submitted
  // provider label for batched graphs. Reapply the same strict echo mapping
  // before rehydration; invalid legacy metadata is refreshed, never trusted.
  if (!history.batch) return true
  try {
    return mapGoogleTrendsGraphKeywordColumns({
      requestedKeywords: [history.batch.providerKeyword],
      returnedKeywords: [history.batch.returnedProviderKeyword],
    }).returnedIndexByRequestIndex[0] === 0
  } catch {
    return false
  }
}

export function classifyGoogleTrendsHistoryCache({ candidates, cachedRows = [], request = {}, now = new Date(), refreshMinutes = DEFAULT_GOOGLE_TRENDS_REFRESH_MINUTES, providerId = GOOGLE_TRENDS_HISTORY_PROVIDER }) {
  if (!Number.isFinite(refreshMinutes) || refreshMinutes <= 0) throw new Error('Google Trends refresh minutes must be positive')
  const byKey = new Map(cachedRows.map((row) => [row.cache_key, row]))
  const fresh = []; const refresh = []
  for (const candidate of candidates) {
    const identity = googleTrendsHistoryCacheIdentity({ normalizedQuery: candidate.normalizedQuery, providerId, measurementMode: request.measurementMode ?? 'global', measurementTarget: request.measurementTarget ?? null, timeRange: request.timeRange, resamplingId: request.resamplingId ?? GOOGLE_TRENDS_RESAMPLING_ID })
    const cacheKey = googleTrendsHistoryCacheKey(identity)
    const row = byKey.get(cacheKey) ?? null
    const age = row ? new Date(now).getTime() - Date.parse(row.retrieved_at) : Infinity
    const valid = row?.history && hasValidGoogleTrendsCacheProvenance(row.history, providerId) && Number.isFinite(age) && age >= 0 && age < refreshMinutes * 60_000
    ;(valid ? fresh : refresh).push({ candidate, row, cacheKey, identity })
  }
  return { fresh, refresh }
}

export function googleTrendsCacheRow({ history, request, batch, retrievedAt }) {
  const providerId = history?.provenance?.providerId ?? GOOGLE_TRENDS_HISTORY_PROVIDER
  const identity = googleTrendsHistoryCacheIdentity({ normalizedQuery: history?.normalizedQuery, providerId, measurementMode: request.measurementMode ?? 'global', measurementTarget: request.measurementTarget ?? null, timeRange: request.timeRange, resamplingId: request.resamplingId ?? GOOGLE_TRENDS_RESAMPLING_ID })
  return {
    cache_key: googleTrendsHistoryCacheKey(identity), normalized_query: identity.normalizedQuery, provider_id: identity.providerId,
    measurement_mode: identity.measurementMode, measurement_target: identity.measurementTarget, time_range: identity.timeRange,
    resampling_id: identity.resamplingId, history, batch_id: batch?.id ?? null, batch_fingerprint: batch?.fingerprint ?? null,
    retrieved_at: retrievedAt ?? history.retrievedAt,
  }
}
