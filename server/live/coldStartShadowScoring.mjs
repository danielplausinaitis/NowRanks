export const COLD_START_TRENDING = Object.freeze({
  minimumIncreasePercentage: 100,
  minimumNormalizedCurrentIntensity: 50,
  increaseSaturationPercentage: 1000,
  weights: Object.freeze({ searchInterest: 0.5, increase: 0.3, recency: 0.2 }),
})

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0
}

/** Caps empirically saturated provider percentages and dampens their coarse/quantized scale. */
export function coldStartIncreaseSignal(increasePercentage) {
  if (!finiteNonNegative(increasePercentage)) return null
  const capped = Math.min(increasePercentage, COLD_START_TRENDING.increaseSaturationPercentage)
  return Math.log1p(capped) / Math.log1p(COLD_START_TRENDING.increaseSaturationPercentage) * 100
}

function trendAge(candidate, maximumAgeHours) {
  const started = Date.parse(candidate.currentTrendIntensity?.startedAt)
  const retrieved = Date.parse(candidate.currentTrendIntensity?.retrievedAt)
  if (!Number.isFinite(started) || !Number.isFinite(retrieved)) return null
  const ageHours = (retrieved - started) / 3_600_000
  if (ageHours < 0 || ageHours > maximumAgeHours) return null
  return {
    ageHours,
    recencySignal: Math.max(0, 100 * (1 - ageHours / maximumAgeHours)),
  }
}

/**
 * Separate emerging-topic lane. Its score is not a substitute for historical Trending and must
 * not be merged into that ranking without empirical calibration.
 */
export function evaluateColdStartTrending({
  candidate,
  searchInterest,
  normalizedCurrentIntensity,
  historyCoverage,
  establishedEligible,
  maximumAgeHours = 24,
}) {
  const increaseSignal = coldStartIncreaseSignal(candidate.currentTrendIntensity?.increasePercentage)
  const age = trendAge(candidate, maximumAgeHours)
  const reasons = []
  if (establishedEligible) reasons.push('established-history-already-eligible')
  if (historyCoverage >= 0.8) reasons.push('history-is-not-sparse')
  if (searchInterest === null) reasons.push('search-interest-required')
  if (candidate.currentTrendIntensity?.active !== true) reasons.push('active-trend-required')
  if (!Number.isFinite(candidate.currentTrendIntensity?.searchVolume) || candidate.currentTrendIntensity.searchVolume <= 0) reasons.push('positive-current-volume-required')
  if (normalizedCurrentIntensity === null || normalizedCurrentIntensity < COLD_START_TRENDING.minimumNormalizedCurrentIntensity) reasons.push('current-intensity-below-cohort-midpoint')
  if (!Number.isFinite(candidate.currentTrendIntensity?.increasePercentage)
    || candidate.currentTrendIntensity.increasePercentage < COLD_START_TRENDING.minimumIncreasePercentage) reasons.push('increase-below-100-percent')
  if (!age) reasons.push('recent-valid-start-time-required')

  const eligible = reasons.length === 0
  const score = eligible
    ? searchInterest * COLD_START_TRENDING.weights.searchInterest
      + increaseSignal * COLD_START_TRENDING.weights.increase
      + age.recencySignal * COLD_START_TRENDING.weights.recency
    : null
  return {
    eligible,
    classification: eligible ? 'possible-new-trend' : 'insufficient-provider-data',
    confidence: eligible ? 'emerging' : 'insufficient',
    reason: eligible
      ? 'active recent trend with strong cohort-relative current intensity, at least 100% increase, mandatory Search Interest, and sparse history'
      : reasons.join('; '),
    score,
    signals: {
      searchInterest,
      normalizedCurrentIntensity,
      rawIncreasePercentage: candidate.currentTrendIntensity?.increasePercentage ?? null,
      cappedIncreasePercentage: increaseSignal === null ? null : Math.min(candidate.currentTrendIntensity.increasePercentage, COLD_START_TRENDING.increaseSaturationPercentage),
      increaseSignal,
      ageHours: age?.ageHours ?? null,
      recencySignal: age?.recencySignal ?? null,
      baselineRelationship: {
        usedAsDirectRatio: false,
        reason: 'Trending Now current volume and monthly baseline demand have incompatible time horizons; baseline contributes only through Search Interest',
      },
    },
  }
}
