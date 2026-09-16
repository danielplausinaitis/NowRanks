const HEAT_LEVELS = Object.freeze(['stable', 'rising', 'fast', 'surging', 'exploding'])

function finite(value) {
  return Number.isFinite(value) ? value : null
}

function levelFor({ score, acceleration }) {
  if (score >= 85 && acceleration >= 90) return 'exploding'
  if (score >= 70 && acceleration >= 75) return 'surging'
  if (score >= 55 && acceleration >= 60) return 'fast'
  if (score >= 35 && acceleration >= 45) return 'rising'
  return 'stable'
}

/**
 * Heat is presentation derived only from normalized evidence already available
 * to the live scorer. It records why a row is pending and never turns a
 * missing input into a zero.
 */
export function resolveTrendHeat({ growth, momentum, breakout, discoveryAcceleration = null, currentIntensity = null, trendingScore, pendingReason = null }) {
  const score = finite(trendingScore)
  if (score === null) return {
    heatStatus: 'pending', heatLevel: null, heatEvidenceAvailable: false,
    heatEvidenceSource: null, heatFallbackUsed: false, heatPendingReason: 'missing-public-score',
  }

  const historicalSignals = [growth, momentum, breakout].map(finite).filter((value) => value !== null)
  const discoverySignal = finite(discoveryAcceleration)
  const currentSignal = finite(currentIntensity)
  // Preserve existing shape/acceleration Heat. Current intensity is a truthful
  // short-window fallback only when neither of those evidence families exists.
  const supportingSignals = historicalSignals.length > 0
    ? [...historicalSignals, ...(discoverySignal === null ? [] : [discoverySignal])]
    : discoverySignal === null
      ? (currentSignal === null ? [] : [currentSignal])
      : [discoverySignal]
  if (supportingSignals.length === 0) return {
    heatStatus: 'pending', heatLevel: null, heatEvidenceAvailable: false,
    heatEvidenceSource: null, heatFallbackUsed: false, heatPendingReason: pendingReason ?? 'no-supporting-signal',
  }

  const heatEvidenceSource = historicalSignals.length > 0
    ? discoverySignal === null ? 'historical-shape' : 'mixed'
    : discoverySignal === null ? 'current-intensity' : 'discovery-acceleration'
  return {
    heatStatus: 'available', heatLevel: levelFor({ score, acceleration: Math.max(...supportingSignals) }), heatEvidenceAvailable: true,
    heatEvidenceSource, heatFallbackUsed: historicalSignals.length === 0, heatPendingReason: null,
  }
}

/**
 * Consumer-facing presentation derived from existing, window-specific scoring evidence.
 * Component values are already cohort-normalized 0–100; this function never creates a score.
 */
export function trendHeat(input) {
  return resolveTrendHeat(input).heatLevel
}

/**
 * Ratio of the same two valid growth segments used by the scorer. A near-zero comparator is
 * intentionally unavailable: displaying an explosive percentage from a tiny denominator misleads.
 */
export function growthPercentage({ recentAverage, previousAverage, minimumPrevious = 5 }) {
  if (!Number.isFinite(recentAverage) || !Number.isFinite(previousAverage) || previousAverage < minimumPrevious) return null
  const percentage = (recentAverage - previousAverage) / previousAverage * 100
  return Number.isFinite(percentage) ? percentage : null
}

/**
 * Presentation has a stricter source order than scoring: a calculated comparison over
 * valid history always wins over discovery's coarse increase field. SerpApi's exact
 * 1000% value is treated as a saturated lower bound, not a precise measurement.
 */
export function resolveGrowthPresentation({ nowranksHistoricalGrowthPercent = null, providerHistoricalGrowthPercent = null, discoveryIncreasePercentage = null }) {
  if (Number.isFinite(nowranksHistoricalGrowthPercent)) return { growthPercent: nowranksHistoricalGrowthPercent, growthSource: 'nowranks-history', growthSaturated: false }
  if (Number.isFinite(providerHistoricalGrowthPercent)) return { growthPercent: providerHistoricalGrowthPercent, growthSource: 'provider-history', growthSaturated: false }
  if (Number.isFinite(discoveryIncreasePercentage)) {
    return { growthPercent: discoveryIncreasePercentage, growthSource: 'discovery-increase', growthSaturated: discoveryIncreasePercentage === 1000 }
  }
  return { growthPercent: null, growthSource: 'unavailable', growthSaturated: false }
}

export function isTrendHeat(value) {
  return value === null || HEAT_LEVELS.includes(value)
}
