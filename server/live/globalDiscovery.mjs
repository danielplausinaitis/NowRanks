/**
 * Pure planning helpers for a future multi-country discovery phase.  They do
 * not import transports, scoring, persistence, or scheduler code.  In
 * particular, geography is a discovery-selection signal only: this module
 * cannot create a country rank or alter the unified public score.
 */
export const LIVE_DISCOVERY_GEOS_ENV = 'LIVE_DISCOVERY_GEOS'

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function geo(value) { return text(value, 'Discovery geo').toUpperCase() }
function finite(value) { return Number.isFinite(value) ? value : null }

/**
 * Reads an opt-in comma-separated geo list while retaining the existing
 * single-country configuration unchanged when the new variable is absent.
 */
export function resolveDiscoveryGeos(env = process.env) {
  const configured = env[LIVE_DISCOVERY_GEOS_ENV]
  const source = configured === undefined || configured.trim() === ''
    ? [env.SERPAPI_DISCOVERY_GEO]
    : configured.split(',')
  const geos = []
  const seen = new Set()
  for (const value of source) {
    const code = geo(value)
    if (!/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(code)) throw new Error('Discovery geos must be supported uppercase Google Trends geo codes')
    if (!seen.has(code)) { seen.add(code); geos.push(code) }
  }
  if (!geos.length) throw new Error('At least one discovery geo is required')
  return geos
}

function appearance(candidate, suppliedGeo, suppliedLanguage) {
  const code = geo(suppliedGeo ?? candidate?.geographicScope?.countryCode)
  if (!candidate?.normalizedQuery) throw new Error('Global discovery candidates require normalizedQuery')
  return {
    providerId: text(candidate.providerId, 'Discovery provider ID'),
    geo: code,
    query: text(candidate.query, 'Discovery candidate query'),
    normalizedQuery: candidate.normalizedQuery,
    providerDiscoveryRank: finite(candidate.providerDiscoveryRank),
    searchVolume: finite(candidate.searchVolume),
    increasePercentage: finite(candidate.increasePercentage),
    category: candidate.category ?? null,
    categories: Array.isArray(candidate.categories) ? candidate.categories : [],
    language: typeof (candidate.language ?? suppliedLanguage) === 'string' && (candidate.language ?? suppliedLanguage).trim()
      ? (candidate.language ?? suppliedLanguage).trim()
      : null,
    sourceId: candidate.sourceId ?? null,
    retrievedAt: candidate.retrievedAt ?? null,
  }
}

function bestAppearance(appearances) {
  return [...appearances].sort((left, right) =>
    (left.providerDiscoveryRank ?? Number.POSITIVE_INFINITY) - (right.providerDiscoveryRank ?? Number.POSITIVE_INFINITY)
    || (right.searchVolume ?? Number.NEGATIVE_INFINITY) - (left.searchVolume ?? Number.NEGATIVE_INFINITY)
    || left.geo.localeCompare(right.geo)
    || left.query.localeCompare(right.query))[0]
}

/**
 * Exact normalized-query merge only.  Translation and semantic equivalence
 * are deliberately not inferred here; callers can inspect raw variants before
 * any later canonicalization work is proposed.
 */
export function mergeGlobalDiscoveryCandidates(geoCandidates) {
  if (!Array.isArray(geoCandidates)) throw new Error('Global discovery merge requires an array of geo candidate groups')
  const byQuery = new Map()
  for (const group of geoCandidates) {
    const suppliedGeo = group?.geo
    const suppliedLanguage = group?.language
    for (const candidate of group?.candidates ?? []) {
      const item = appearance(candidate, suppliedGeo, suppliedLanguage)
      const rows = byQuery.get(item.normalizedQuery) ?? []
      rows.push(item); byQuery.set(item.normalizedQuery, rows)
    }
  }
  return [...byQuery.entries()].map(([normalizedQuery, appearances]) => {
    const best = bestAppearance(appearances)
    const sourceGeos = [...new Set(appearances.map((item) => item.geo))].sort()
    const positions = appearances.map((item) => item.providerDiscoveryRank).filter(Number.isFinite)
    const volumes = appearances.map((item) => item.searchVolume).filter(Number.isFinite)
    const acceleration = appearances.map((item) => item.increasePercentage).filter(Number.isFinite)
    return {
      query: best.query,
      normalizedQuery,
      providerId: best.providerId,
      sourceId: best.sourceId,
      retrievedAt: best.retrievedAt,
      // Existing scoring consumes one coherent primary observation. This is
      // deliberately not a blended cross-country intensity.
      providerDiscoveryRank: best.providerDiscoveryRank,
      searchVolume: best.searchVolume,
      increasePercentage: best.increasePercentage,
      language: best.language,
      geographicScope: { kind: 'country', countryCode: best.geo },
      // Preserve existing category behavior by retaining the deterministic
      // best-provider classification. Categories do not affect merge order.
      category: best.category,
      categories: [...new Set(appearances.flatMap((item) => item.categories))].sort(),
      sourceGeos,
      geoCount: sourceGeos.length,
      // The primary appearance is a single real provider observation. A future
      // scorer must not construct current intensity from a volume in one geo
      // and acceleration in another.
      bestGeo: best.geo,
      primaryDiscoveryEvidence: {
        providerId: best.providerId,
        geo: best.geo,
        providerDiscoveryRank: best.providerDiscoveryRank,
        searchVolume: best.searchVolume,
        increasePercentage: best.increasePercentage,
        language: best.language,
      },
      bestProviderPosition: positions.length ? Math.min(...positions) : null,
      meanProviderPosition: positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : null,
      bestSearchVolume: volumes.length ? Math.max(...volumes) : null,
      bestAcceleration: acceleration.length ? Math.max(...acceleration) : null,
      rawVariants: [...new Set(appearances.map((item) => item.query))].sort(),
      sourceLanguages: [...new Set(appearances.map((item) => item.language).filter(Boolean))].sort(),
      geoAppearances: appearances.sort((left, right) => left.geo.localeCompare(right.geo) || (left.providerDiscoveryRank ?? Infinity) - (right.providerDiscoveryRank ?? Infinity)),
    }
  }).sort((left, right) => left.normalizedQuery.localeCompare(right.normalizedQuery))
}

/**
 * Discovery-only order for deciding which merged topics deserve paid
 * measurement. It is intentionally category-neutral and has no relationship
 * to public rank or Now Score.
 */
export function rankGlobalDiscoveryCandidates(candidates) {
  return [...candidates].sort((left, right) =>
    right.geoCount - left.geoCount
    || (left.bestProviderPosition ?? Number.POSITIVE_INFINITY) - (right.bestProviderPosition ?? Number.POSITIVE_INFINITY)
    || (right.bestAcceleration ?? Number.NEGATIVE_INFINITY) - (left.bestAcceleration ?? Number.NEGATIVE_INFINITY)
    || (right.bestSearchVolume ?? Number.NEGATIVE_INFINITY) - (left.bestSearchVolume ?? Number.NEGATIVE_INFINITY)
    || left.normalizedQuery.localeCompare(right.normalizedQuery))
}

/** Pure cost model; provider pricing is deliberately not inferred from request counts. */
export function globalDiscoveryRequestModel({ geoCount, sharedCyclesPerDay = 6, daysPerMonth = 30 }) {
  if (!Number.isInteger(geoCount) || geoCount < 1) throw new Error('geoCount must be a positive integer')
  if (!Number.isInteger(sharedCyclesPerDay) || sharedCyclesPerDay < 1) throw new Error('sharedCyclesPerDay must be a positive integer')
  if (!Number.isInteger(daysPerMonth) || daysPerMonth < 1) throw new Error('daysPerMonth must be a positive integer')
  return { perCycle: geoCount, perDay: geoCount * sharedCyclesPerDay, perMonth: geoCount * sharedCyclesPerDay * daysPerMonth }
}
