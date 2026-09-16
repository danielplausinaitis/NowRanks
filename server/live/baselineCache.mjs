import { createHash } from 'node:crypto'
import { mapSearchVolumeRecordsToCandidates, prepareSearchVolumeLookups } from './searchVolumeKeyword.mjs'
export const BASELINE_PROVIDER = 'dataforseo-google-ads-search-volume'
function targeting(request) {
  const legacy = { locationCode: request.locationCode ?? null, locationName: request.locationName ?? null, locationCoordinate: request.locationCoordinate ?? null, languageCode: request.languageCode ?? null, languageName: request.languageName ?? null, searchPartners: request.searchPartners ?? false, dateFrom: request.dateFrom ?? null, dateTo: request.dateTo ?? null }
  // Preserve pre-mode US cache keys. Global is isolated both by provider ID and
  // by this explicit target identity, while old US rows remain reusable.
  return request.measurementMode === 'global' ? { ...legacy, measurementMode: 'global', measurementTarget: request.measurementTarget ?? null } : legacy
}
export function baselineCacheKey(normalizedQuery, request) { return createHash('sha256').update(JSON.stringify({ normalizedQuery, providerId: request.providerId ?? BASELINE_PROVIDER, targeting: targeting(request) })).digest('hex') }
export function classifyBaselineCache({ candidates, cachedRows, request, now = new Date(), ttlHours = 24 }) {
  const byKey = new Map(cachedRows.map((row) => [row.cache_key, row])); const fresh = []; const refresh = []
  for (const candidate of candidates) { const row = byKey.get(baselineCacheKey(candidate.normalizedQuery, request)); const age = row ? now.getTime() - Date.parse(row.retrieved_at) : Infinity; (row && Number.isFinite(age) && age < ttlHours * 3600000 ? fresh : refresh).push({ candidate, row: row ?? null }) }
  return { fresh, refresh }
}
/** Provider refreshes are all-or-nothing: stale values are never silently substituted. */
export async function refreshMissingBaselines({ candidates, request, volumeClient, normalize, repository, now = () => new Date().toISOString() }) {
  if (!candidates.length) return []
  const prepared = prepareSearchVolumeLookups(candidates)
  const result = await volumeClient.lookup({ ...request, keywords: prepared.providerKeywords })
  const providerRecords = normalize({ response: result.response, retrievedAt: result.retrievedAt, geographicScope: request.geographicScope })
  const records = mapSearchVolumeRecordsToCandidates({ records: providerRecords, preparations: prepared.preparations, providerId: request.providerId ?? volumeClient.providerId ?? BASELINE_PROVIDER, retrievedAt: result.retrievedAt, geographicScope: request.geographicScope })
  const rows = records.map((record) => ({ cache_key: baselineCacheKey(record.normalizedQuery, request), normalized_query: record.normalizedQuery, provider_id: request.providerId ?? BASELINE_PROVIDER, targeting: targeting(request), availability: record.availability, search_volume: record.searchVolume, monthly_history: record.monthlyHistory, retrieved_at: record.retrievedAt, updated_at: now() }))
  await repository.upsertLiveBaselineDemandCache(rows)
  return records
}
