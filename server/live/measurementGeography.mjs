/**
 * Pure planning guards for a future global-discovery rollout. This module is
 * intentionally unwired: it does not import provider transports, persistence,
 * scheduling, or scoring. Its purpose is to make measurement geography an
 * explicit, stable contract before any production request builder changes.
 */
export const MEASUREMENT_GEOGRAPHY_MODES = Object.freeze(['common-global', 'common-reference', 'origin-geo'])
export const LIVE_MEASUREMENT_MODE_ENV = 'LIVE_MEASUREMENT_MODE'

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function optionalText(value, label) {
  return value === undefined || value === null || value === '' ? null : text(value, label)
}

function location(target) {
  const values = [target?.locationCode, target?.locationName, target?.locationCoordinate]
    .filter((value) => value !== undefined && value !== null && value !== '')
  if (values.length !== 1) throw new Error('Common reference measurement requires exactly one explicit location')
  if (target.locationCode !== undefined && target.locationCode !== null && target.locationCode !== '') {
    if (!Number.isInteger(target.locationCode) || target.locationCode < 1) throw new Error('Measurement locationCode must be a positive integer')
    return { locationCode: target.locationCode, locationName: null, locationCoordinate: null }
  }
  if (target.locationName !== undefined && target.locationName !== null && target.locationName !== '') {
    return { locationCode: null, locationName: text(target.locationName, 'Measurement locationName'), locationCoordinate: null }
  }
  return { locationCode: null, locationName: null, locationCoordinate: text(target.locationCoordinate, 'Measurement locationCoordinate') }
}

function language({ languageCode, languageName }) {
  if (languageCode !== undefined && languageCode !== null && languageCode !== '' && languageName !== undefined && languageName !== null && languageName !== '') {
    throw new Error('Measurement target accepts languageCode or languageName, not both')
  }
  return {
    languageCode: optionalText(languageCode, 'Measurement languageCode'),
    languageName: optionalText(languageName, 'Measurement languageName'),
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value ?? null
}

export function measurementTargetKey(target) {
  if (!target || typeof target !== 'object') throw new Error('Measurement target is required')
  return JSON.stringify(stable({
    mode: target.mode,
    geographicScope: target.geographicScope,
    locationCode: target.locationCode,
    locationName: target.locationName,
    locationCoordinate: target.locationCoordinate,
    languageCode: target.languageCode,
    languageName: target.languageName,
  }))
}

/**
 * Explicitly chooses either worldwide provider data or one shared reference
 * location. A missing location is valid only in the named common-global mode;
 * it can never be an accidental provider default.
 */
export function resolveCommonMeasurementTarget({ mode, locationCode, locationName, locationCoordinate, languageCode, languageName } = {}) {
  if (!MEASUREMENT_GEOGRAPHY_MODES.includes(mode)) throw new Error(`Measurement mode must be one of: ${MEASUREMENT_GEOGRAPHY_MODES.join(', ')}`)
  if (mode === 'origin-geo') throw new Error('origin-geo requires a candidate-specific target')
  const locale = language({ languageCode, languageName })
  if (mode === 'common-global') {
    const supplied = [locationCode, locationName, locationCoordinate].some((value) => value !== undefined && value !== null && value !== '')
    if (supplied) throw new Error('common-global measurement must not include a location')
    const target = { mode, geographicScope: { kind: 'global' }, locationCode: null, locationName: null, locationCoordinate: null, ...locale }
    return { ...target, targetKey: measurementTargetKey(target) }
  }
  const target = { mode, geographicScope: { kind: 'reference-market' }, ...location({ locationCode, locationName, locationCoordinate }), ...locale }
  return { ...target, targetKey: measurementTargetKey(target) }
}

/** Resolves the production-facing opt-in switch without changing legacy installs. */
export function resolveLiveMeasurementConfig(env = process.env) {
  const value = (env[LIVE_MEASUREMENT_MODE_ENV] ?? 'us').trim().toLowerCase()
  if (!['us', 'global'].includes(value)) throw new Error(`${LIVE_MEASUREMENT_MODE_ENV} must be us or global`)
  if (value === 'global') {
    const target = resolveCommonMeasurementTarget({ mode: 'common-global' })
    return {
      mode: 'global', target,
      discoveryAndMeasurementAreSeparate: true,
      trendsRequest: { measurementMode: 'global', geographicScope: target.geographicScope },
      baselineRequest: { measurementMode: 'global', providerId: 'dataforseo-clickstream-global-search-volume', geographicScope: target.geographicScope },
      canonicalTargeting: { measurementMode: 'global', measurementTarget: target.targetKey, measurementLocation: null, measurementLanguage: null },
    }
  }
  const target = resolveCommonMeasurementTarget({
    mode: 'common-reference', locationCode: env.DATAFORSEO_LOCATION_CODE === '' ? undefined : env.DATAFORSEO_LOCATION_CODE === undefined ? undefined : Number(env.DATAFORSEO_LOCATION_CODE),
    locationName: env.DATAFORSEO_LOCATION_NAME || undefined,
    locationCoordinate: env.DATAFORSEO_LOCATION_COORDINATE || undefined,
    languageCode: env.DATAFORSEO_LANGUAGE_CODE || undefined,
    languageName: env.DATAFORSEO_LANGUAGE_NAME || undefined,
  })
  return {
    mode: 'us', target,
    discoveryAndMeasurementAreSeparate: true,
    trendsRequest: {
      measurementMode: 'us', geographicScope: target.geographicScope,
      locationCode: target.locationCode ?? undefined, locationName: target.locationName ?? undefined,
      locationCoordinate: target.locationCoordinate ?? undefined,
    },
    baselineRequest: {
      measurementMode: 'us', providerId: 'dataforseo-google-ads-search-volume', geographicScope: target.geographicScope,
      locationCode: target.locationCode ?? undefined, locationName: target.locationName ?? undefined,
      locationCoordinate: target.locationCoordinate ?? undefined,
      languageCode: target.languageCode ?? undefined, languageName: target.languageName ?? undefined,
    },
    canonicalTargeting: { measurementMode: 'us', measurementTarget: target.targetKey, measurementLocation: target.locationCode ?? target.locationName ?? target.locationCoordinate, measurementLanguage: target.languageCode ?? target.languageName },
  }
}

function countryGeo(value) {
  const geo = text(value, 'Candidate source geo').toUpperCase()
  if (!/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(geo)) throw new Error('Candidate source geos must be supported uppercase country codes')
  return geo
}

/**
 * Origin measurement is deliberately a planning option, not a scoring
 * recommendation. Prefer the recorded best geo, then a lexical source-geo
 * tie-breaker, so a candidate never changes location merely due to input order.
 */
export function chooseOriginMeasurementTarget(candidate, { languageCode, languageName } = {}) {
  const sourceGeos = [...new Set((candidate?.sourceGeos ?? []).map(countryGeo))].sort()
  if (!sourceGeos.length) throw new Error('Origin measurement requires at least one candidate source geo')
  const bestGeo = candidate?.bestGeo === undefined || candidate?.bestGeo === null ? null : countryGeo(candidate.bestGeo)
  const geo = bestGeo && sourceGeos.includes(bestGeo) ? bestGeo : sourceGeos[0]
  const target = {
    mode: 'origin-geo', geographicScope: { kind: 'country', countryCode: geo },
    locationCode: null, locationName: null, locationCoordinate: null,
    ...language({ languageCode, languageName }),
  }
  return { ...target, targetKey: measurementTargetKey(target) }
}

/** A measurement target must be stable for a candidate and canonical segment. */
export function assertStableMeasurementTarget({ previousTarget = null, nextTarget }) {
  if (!nextTarget?.targetKey) throw new Error('Next measurement target requires targetKey')
  if (previousTarget === null || previousTarget === undefined) return nextTarget
  if (!previousTarget?.targetKey) throw new Error('Previous measurement target requires targetKey')
  if (previousTarget.targetKey !== nextTarget.targetKey) {
    throw new Error('Measurement geography/language changed; start a separate canonical segment instead of silently switching')
  }
  return nextTarget
}

/** Independently normalized curves from unlike targets cannot be stitched. */
export function assertCanonicalCurveTargetsCompatible({ existingTarget, incomingTarget }) {
  return assertStableMeasurementTarget({ previousTarget: existingTarget, nextTarget: incomingTarget })
}

function legacyUsLocation(value) {
  if (value === null || value === undefined || value === '') return true
  if (value === 2840 || value === '2840') return true
  const normalized = String(value).trim().toLocaleLowerCase('en-US').replace(/[^a-z]/g, '')
  return normalized === 'us' || normalized === 'usa' || normalized === 'unitedstates' || normalized === 'unitedstatesofamerica'
}

/**
 * Uses the same persisted measurementTarget identity as canonical alignment.
 * Old records without that field belong to the explicitly US-only legacy
 * system; they may continue only into a US target, never a global one.
 */
export function assessMeasurementTargetCompatibility({ historicalMeasurementMode = null, historicalMeasurementTarget = null, historicalMeasurementLocation = null, currentMeasurementMode = null, currentMeasurementTarget = null, currentMeasurementLocation = null } = {}) {
  const historicalMode = historicalMeasurementMode ?? 'us'
  if (!currentMeasurementMode || !currentMeasurementTarget) {
    return { compatible: true, reason: 'current-measurement-identity-not-supplied', historicalMeasurementMode: historicalMode, historicalMeasurementTarget, currentMeasurementMode, currentMeasurementTarget }
  }
  if (historicalMeasurementTarget) {
    const compatible = historicalMeasurementTarget === currentMeasurementTarget
    return { compatible, reason: compatible ? 'same-measurement-target' : 'different-measurement-target', historicalMeasurementMode: historicalMode, historicalMeasurementTarget, currentMeasurementMode, currentMeasurementTarget }
  }
  const compatible = historicalMode === 'us' && currentMeasurementMode === 'us' && legacyUsLocation(currentMeasurementLocation)
  return {
    compatible,
    reason: compatible ? 'legacy-us-with-us-target' : historicalMode === 'us' ? 'legacy-us-incompatible-with-current-target' : 'historical-measurement-target-missing',
    historicalMeasurementMode: historicalMode,
    historicalMeasurementTarget: null,
    currentMeasurementMode,
    currentMeasurementTarget,
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}

function nonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`)
  return value
}

/**
 * Models only a proposed measurement plan. It is intentionally not connected
 * to request construction, cache writes, scheduling, or scoring.
 *
 * Google Trends task batches must not mix measurement targets, so callers
 * supply the per-target candidate counts whenever they propose more than one
 * target. This avoids an attractive but incorrect `ceil(total / 5)` estimate
 * for a multi-country plan.
 */
export function globalMeasurementCostModel({
  paidCandidateCount = 50,
  paidCandidateCap = 50,
  candidateGeoPairs = paidCandidateCount,
  distinctMeasurementGeographies = 1,
  candidateCountsByMeasurementTarget = null,
  trendsKeywordsPerRequest = 5,
  trendsRefreshesPerDay = 3,
  baselineRefreshesPerDay = 1,
  daysPerMonth = 30,
  trendsRequestCostUsd = 0.011,
  baselineRequestCostUsd = 0.18,
} = {}) {
  positiveInteger(paidCandidateCount, 'Paid candidate count')
  positiveInteger(paidCandidateCap, 'Paid candidate cap')
  positiveInteger(candidateGeoPairs, 'Candidate-geo pair count')
  positiveInteger(distinctMeasurementGeographies, 'Distinct measurement geography count')
  positiveInteger(trendsKeywordsPerRequest, 'Trends keywords per request')
  if (trendsKeywordsPerRequest > 5) throw new Error('Trends keywords per request cannot exceed five')
  positiveInteger(trendsRefreshesPerDay, 'Trends refreshes per day')
  positiveInteger(baselineRefreshesPerDay, 'Baseline refreshes per day')
  positiveInteger(daysPerMonth, 'Days per month')
  nonNegative(trendsRequestCostUsd, 'Trends request cost')
  nonNegative(baselineRequestCostUsd, 'Baseline request cost')
  if (paidCandidateCount > paidCandidateCap) throw new Error('Paid candidate count exceeds the configured paid cap')
  if (candidateGeoPairs < paidCandidateCount) throw new Error('Candidate-geo pair count cannot be lower than paid candidate count')
  const perTarget = candidateCountsByMeasurementTarget ?? (distinctMeasurementGeographies === 1 ? [candidateGeoPairs] : null)
  if (!Array.isArray(perTarget) || perTarget.length !== distinctMeasurementGeographies) {
    throw new Error('Candidate counts per measurement target are required for each proposed measurement geography')
  }
  perTarget.forEach((count) => positiveInteger(count, 'Candidate count per measurement target'))
  if (perTarget.reduce((total, count) => total + count, 0) !== candidateGeoPairs) {
    throw new Error('Candidate counts per measurement target must equal candidate-geo pair count')
  }
  const trendsTasksPerRefresh = perTarget.reduce((total, count) => total + Math.ceil(count / trendsKeywordsPerRequest), 0)
  const trends = {
    perCycle: trendsTasksPerRefresh,
    perDay: trendsTasksPerRefresh * trendsRefreshesPerDay,
    perMonth: trendsTasksPerRefresh * trendsRefreshesPerDay * daysPerMonth,
  }
  const baseline = {
    coldPerCycle: distinctMeasurementGeographies,
    perDay: distinctMeasurementGeographies * baselineRefreshesPerDay,
    perMonth: distinctMeasurementGeographies * baselineRefreshesPerDay * daysPerMonth,
  }
  const cost = {
    trends: Object.fromEntries(Object.entries(trends).map(([period, count]) => [period, Number((count * trendsRequestCostUsd).toFixed(4))])),
    baseline: {
      coldPerCycle: Number((baseline.coldPerCycle * baselineRequestCostUsd).toFixed(4)),
      perDay: Number((baseline.perDay * baselineRequestCostUsd).toFixed(4)),
      perMonth: Number((baseline.perMonth * baselineRequestCostUsd).toFixed(4)),
    },
  }
  return {
    paidTracking: { candidates: paidCandidateCount, cap: paidCandidateCap, withinCap: true },
    candidateGeoPairs,
    distinctMeasurementGeographies,
    candidateCountsByMeasurementTarget: perTarget,
    cadence: { trendsKeywordsPerRequest, trendsRefreshesPerDay, baselineRefreshesPerDay, daysPerMonth },
    trends,
    baseline,
    cost: {
      ...cost,
      coldCycleTotal: Number((cost.trends.perCycle + cost.baseline.coldPerCycle).toFixed(4)),
      perDayTotal: Number((cost.trends.perDay + cost.baseline.perDay).toFixed(4)),
      perMonthTotal: Number((cost.trends.perMonth + cost.baseline.perMonth).toFixed(4)),
    },
  }
}
