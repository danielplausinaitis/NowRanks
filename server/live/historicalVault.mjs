import { createHash } from 'node:crypto'
import { CROSS_QUERY_COMPARABILITY_STATUSES } from './provenanceComparability.mjs'

export const VAULT_METRICS = Object.freeze({
  SERPAPI_TRENDING_SEARCH_VOLUME: 'serpapi-trending-search-volume',
  DATAFORSEO_MONTHLY_SEARCH_VOLUME: 'dataforseo-monthly-search-volume',
})

export const VAULT_GROWTH_MODES = Object.freeze(['off', 'shadow', 'preferred'])
export const VAULT_COMPARABILITY_STATUSES = CROSS_QUERY_COMPARABILITY_STATUSES

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Vault ${label} is required`)
  return value.trim()
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value ?? null
}

function stableUuid(identity) {
  const hex = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function canonicalQueryFingerprint({ providerQuery, normalizedProviderQuery }) {
  return createHash('sha256').update(JSON.stringify(stable({ providerQuery: text(providerQuery, 'provider query'), normalizedProviderQuery: text(normalizedProviderQuery, 'normalized provider query') }))).digest('hex')
}

/** A comparability key is an identity boundary, never a statistical conversion. */
export function comparabilityFingerprint({ providerId, metricKey, metricVersion = 1, unit, geographicScope, language = null, targeting = {}, queryMode, measurementHorizon, normalizationScope, queryFingerprint }) {
  const payload = stable({ providerId: text(providerId, 'provider ID'), metricKey: text(metricKey, 'metric key'), metricVersion, unit: text(unit, 'unit'), geographicScope: geographicScope ?? null, language, targeting, queryMode: text(queryMode, 'query mode'), measurementHorizon: measurementHorizon ?? null, normalizationScope: text(normalizationScope, 'normalization scope'), queryFingerprint: text(queryFingerprint, 'query fingerprint') })
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function utcSchedulerSlot(value, intervalMinutes = 240) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || 1440 % intervalMinutes !== 0) throw new Error('Vault slot interval must evenly divide a UTC day')
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('Vault slot timestamp must be valid')
  return new Date(Math.floor(timestamp / (intervalMinutes * 60_000)) * intervalMinutes * 60_000).toISOString()
}

export function resolveHistoricalVaultConfig(env = process.env) {
  const enabled = env.LIVE_VAULT_ENABLED === 'true'
  if (env.LIVE_VAULT_ENABLED !== undefined && env.LIVE_VAULT_ENABLED !== '' && !['true', 'false'].includes(env.LIVE_VAULT_ENABLED)) throw new Error('LIVE_VAULT_ENABLED must be true or false')
  const growthMode = (env.LIVE_VAULT_GROWTH_MODE ?? 'off').trim().toLowerCase()
  if (!VAULT_GROWTH_MODES.includes(growthMode)) throw new Error(`LIVE_VAULT_GROWTH_MODE must be one of: ${VAULT_GROWTH_MODES.join(', ')}`)
  const slotMinutes = Number(env.LIVE_REFRESH_INTERVAL_MINUTES ?? 240)
  if (!Number.isInteger(slotMinutes) || slotMinutes < 1 || 1440 % slotMinutes !== 0) throw new Error('LIVE_REFRESH_INTERVAL_MINUTES must evenly divide a UTC day for the historical vault')
  return { enabled, growthMode, slotMinutes }
}

function discoveryTargeting(discoveryRequest = {}) {
  return {
    geo: discoveryRequest.geo ?? null,
    language: discoveryRequest.language ?? null,
    hours: discoveryRequest.hours ?? null,
    onlyActive: discoveryRequest.onlyActive ?? null,
    categoryId: discoveryRequest.categoryId ?? null,
  }
}

/**
 * SerpApi's current Trending Now volume is retained as an artifact, not promoted to
 * a canonical growth metric: its cross-request unit and rolling-horizon semantics
 * have not been documented in a way NowRanks can validate.
 */
export function discoveryVaultMeasurement({ candidate, candidateId, discoveryRequest, ingestionRunId, sourceEvidenceId = null, slotAt, retrievedAt }) {
  const providerQuery = text(candidate?.query, 'provider query')
  const normalizedProviderQuery = text(candidate?.normalizedQuery, 'normalized provider query')
  const queryFingerprint = canonicalQueryFingerprint({ providerQuery, normalizedProviderQuery })
  const targeting = discoveryTargeting(discoveryRequest)
  const comparabilityKey = comparabilityFingerprint({
    providerId: 'serpapi-google-trends-trending-now', metricKey: VAULT_METRICS.SERPAPI_TRENDING_SEARCH_VOLUME,
    unit: 'provider-reported-search-volume', geographicScope: candidate.geographicScope,
    language: targeting.language, targeting, queryMode: 'google-trends-trending-now',
    measurementHorizon: targeting.hours === null ? 'provider-default' : `${targeting.hours}h`,
    normalizationScope: 'provider-semantics-not-validated-cross-cycle', queryFingerprint,
  })
  const available = Number.isFinite(candidate.searchVolume) && candidate.searchVolume >= 0
  const identity = `${candidateId}\u0000${VAULT_METRICS.SERPAPI_TRENDING_SEARCH_VOLUME}\u0000${comparabilityKey}\u0000${slotAt}`
  return {
    measurement_id: stableUuid(`live-historical-vault:${identity}`),
    candidate_id: candidateId, ingestion_run_id: ingestionRunId, metric_key: VAULT_METRICS.SERPAPI_TRENDING_SEARCH_VOLUME,
    metric_version: 1, provider_id: 'serpapi-google-trends-trending-now', provider_query: providerQuery,
    normalized_provider_query: normalizedProviderQuery, query_fingerprint: queryFingerprint,
    value: available ? candidate.searchVolume : null, unit: 'provider-reported-search-volume', availability: available ? 'available' : 'missing',
    missing_reason: available ? null : 'not-reported', slot_at: slotAt, observed_at: candidate.retrievedAt ?? retrievedAt,
    retrieved_at: retrievedAt, geographic_scope: candidate.geographicScope, language: targeting.language,
    targeting, query_mode: 'google-trends-trending-now', measurement_horizon: targeting.hours === null ? 'provider-default' : `${targeting.hours}h`,
    normalization_scope: 'provider-semantics-not-validated-cross-cycle', comparability_key: comparabilityKey,
    comparability_status: 'unknown', quality: { confidence: 'unvalidated', growthEligible: false }, source_evidence_id: sourceEvidenceId,
  }
}

export function buildDiscoveryVaultMeasurements({ candidates, candidateIdByQuery, discoveryRequest, ingestionRunId, sourceEvidenceIdByQuery = new Map(), slotAt, retrievedAt }) {
  if (!Array.isArray(candidates)) throw new Error('Vault candidates must be an array')
  return candidates.map((candidate) => {
    const candidateId = candidateIdByQuery.get(candidate.normalizedQuery)
    if (!candidateId) throw new Error(`Vault candidate identity is missing for ${candidate.normalizedQuery}`)
    return discoveryVaultMeasurement({ candidate, candidateId, discoveryRequest, ingestionRunId, sourceEvidenceId: sourceEvidenceIdByQuery.get(candidate.normalizedQuery) ?? null, slotAt, retrievedAt })
  })
}

export function isGrowthEligibleMeasurement(measurement) {
  return measurement?.comparability_status === 'comparable'
    && measurement?.quality?.growthEligible === true
    && measurement.availability === 'available'
    && Number.isFinite(measurement.value)
}
