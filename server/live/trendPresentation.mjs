const HEAT_LEVELS = Object.freeze(['stable', 'rising', 'fast', 'surging', 'exploding'])

function finite(value) {
  return Number.isFinite(value) ? value : null
}

/**
 * Consumer-facing presentation derived from existing, window-specific scoring evidence.
 * Component values are already cohort-normalized 0–100; this function never creates a score.
 */
export function trendHeat({ growth, momentum, breakout, trendingScore }) {
  const values = [growth, momentum, breakout, trendingScore].map(finite)
  if (values.some((value) => value === null)) return null
  const [growthValue, momentumValue, breakoutValue, score] = values
  const acceleration = Math.max(growthValue, momentumValue, breakoutValue)
  if (score >= 85 && acceleration >= 90) return 'exploding'
  if (score >= 70 && acceleration >= 75) return 'surging'
  if (score >= 55 && acceleration >= 60) return 'fast'
  if (score >= 35 && acceleration >= 45) return 'rising'
  return 'stable'
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

export function isTrendHeat(value) {
  return value === null || HEAT_LEVELS.includes(value)
}
