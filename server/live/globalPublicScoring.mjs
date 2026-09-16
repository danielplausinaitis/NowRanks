/**
 * Pure score-input selection for the worldwide board. Discovery remains useful
 * for candidate selection and provenance, but country-local magnitude must not
 * become a cross-country public-score input.
 */
function available(point) {
  return point?.availability === 'available' && Number.isFinite(point.interest) && point.interest > 0
}

function globalHistory(history) {
  return history?.measurementProvenance?.measurementMode === 'global'
    && history?.measurementProvenance?.measurementLocation?.kind === 'global'
}

/**
 * A candidate-local currentness signal. Dividing the mean of the latest three
 * usable provider buckets by that candidate's own requested-window peak
 * cancels arbitrary positive provider scale; it deliberately says nothing
 * about absolute demand, which remains the global Clickstream baseline's job.
 */
export function globalGoogleTrendsCurrentIntensity(history, { recentPointCount = 3, minimumUsablePoints = 3 } = {}) {
  if (!Number.isInteger(recentPointCount) || recentPointCount < 1) throw new Error('Recent Google Trends point count must be positive')
  if (!Number.isInteger(minimumUsablePoints) || minimumUsablePoints < recentPointCount) throw new Error('Minimum usable Google Trends points must cover the recent window')
  if (!globalHistory(history)) return { value: null, source: 'unavailable', reason: 'not-global-google-trends-history', usablePointCount: 0 }
  const points = [...(history.observations ?? [])]
    .filter(available)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
  if (points.length < minimumUsablePoints) {
    return { value: null, source: 'unavailable', reason: 'insufficient-global-google-trends-points', usablePointCount: points.length }
  }
  const peak = Math.max(...points.map((point) => point.interest))
  if (!(peak > 0)) return { value: null, source: 'unavailable', reason: 'non-positive-global-google-trends-peak', usablePointCount: points.length }
  const recent = points.slice(-recentPointCount)
  const recentMean = recent.reduce((total, point) => total + point.interest, 0) / recent.length
  return {
    value: Math.max(0, Math.min(100, recentMean / peak * 100)),
    // Preserve the proven 24H Google Trends provenance label. Longer horizons
    // use the established DataForSEO Trends curve and must not claim hourly
    // Google Trends currentness.
    source: history?.provenance?.providerId === 'dataforseo-google-trends'
      ? 'global-google-trends-recent-3h-to-24h-peak'
      : 'global-dataforseo-trends-recent-3-to-window-peak',
    reason: null,
    usablePointCount: points.length,
    recentPointCount: recent.length,
    recentMean,
    peak,
  }
}

function baselineSource(candidate, global) {
  if (global && candidate?.baselineDemand?.providerId === 'dataforseo-clickstream-global-search-volume') return 'global-clickstream'
  return candidate?.baselineDemand?.providerId ?? 'unavailable'
}

/** Resolves score inputs without mutating the country-scoped discovery record. */
export function resolvePublicScoringInputs(candidate) {
  const history = candidate?.historicalTrendShape ?? null
  const global = globalHistory(history)
  if (!global) {
    return {
      measurementMode: 'us-or-legacy',
      currentIntensity: { value: candidate?.currentTrendIntensity?.searchVolume ?? null, source: 'discovery-search-volume' },
      fallbackAcceleration: candidate?.currentTrendIntensity?.increasePercentage ?? null,
      accelerationSource: 'discovery-increase',
      discoveryMagnitudeUsedInPublicScore: true,
      baselineSource: baselineSource(candidate, false),
    }
  }
  return {
    measurementMode: 'global',
    currentIntensity: globalGoogleTrendsCurrentIntensity(history),
    // Global history growth is calculated by the existing elapsed-history path.
    // Until it is available, do not substitute a country discovery percentage.
    fallbackAcceleration: null,
    accelerationSource: 'unavailable',
    discoveryMagnitudeUsedInPublicScore: false,
    baselineSource: baselineSource(candidate, true),
  }
}
