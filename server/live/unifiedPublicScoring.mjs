export const UNIFIED_PUBLIC_PROFILES = Object.freeze({
  '24H': Object.freeze({ weights: Object.freeze({ currentAttention: .45, baselineDemand: .05, acceleration: .28, momentum: .08, consistency: .02, breakout: .02, recency: .10 }), discoveryFallbackScale: 1, historyCoverageFloor: .90, historyCoverageWeight: .10 }),
  '7D': Object.freeze({ weights: Object.freeze({ currentAttention: .30, baselineDemand: .10, acceleration: .27, momentum: .17, consistency: .07, breakout: .03, recency: .06 }), discoveryFallbackScale: .70, historyCoverageFloor: .76, historyCoverageWeight: .24 }),
  '30D': Object.freeze({ weights: Object.freeze({ currentAttention: .16, baselineDemand: .20, acceleration: .22, momentum: .18, consistency: .14, breakout: .05, recency: .05 }), discoveryFallbackScale: .35, historyCoverageFloor: .60, historyCoverageWeight: .40 }),
  '1Y': Object.freeze({ weights: Object.freeze({ currentAttention: .07, baselineDemand: .30, acceleration: .16, momentum: .20, consistency: .20, breakout: .07, recency: 0 }), discoveryFallbackScale: .10, historyCoverageFloor: .42, historyCoverageWeight: .58 }),
})

export const UNIFIED_PUBLIC_SCORE = Object.freeze({ floor: 54, multiplier: .45, ceiling: 99 })
function finite(value) { return Number.isFinite(value) ? value : null }
function profileFor(window) { const profile = UNIFIED_PUBLIC_PROFILES[window]; if (!profile) throw new Error('Unified public score window must be 24H, 7D, 30D, or 1Y'); return profile }

/** A bounded discovery fallback prevents extreme reported percentage increases dominating. */
export function boundedDiscoveryAcceleration(increasePercentage) { const value = finite(increasePercentage); return value === null ? null : Math.min(500, Math.max(0, value)) }
export function recencyScore({ startedAt, retrievedAt, referenceTime }) { const started = Date.parse(startedAt ?? ''); const reference = Date.parse(referenceTime ?? retrievedAt ?? ''); if (!Number.isFinite(started) || !Number.isFinite(reference) || started > reference) return null; return Math.max(0, Math.min(100, 100 * (1 - (reference - started) / (7 * 24 * 60 * 60 * 1000)))) }

/**
 * One signal family with a different horizon profile per selected window. Optional missing
 * inputs are renormalized; the separate coverage modifier is an evidence-horizon penalty,
 * not a fabricated zero-valued historical component.
 */
export function composeUnifiedPublicScore({ window, currentAttention, baselineDemand, historicalGrowth, discoveryAcceleration, momentum, consistency, breakout, recency, historyCoverage = 0 }) {
  const profile = profileFor(window)
  if (!Number.isFinite(currentAttention)) return { rawScore: null, availableWeight: 0, components: {}, evidenceMatch: null }
  const historical = finite(historicalGrowth)
  const fallback = finite(discoveryAcceleration)
  const acceleration = historical ?? (fallback === null ? null : fallback * profile.discoveryFallbackScale)
  const components = { currentAttention, baselineDemand: finite(baselineDemand), acceleration, momentum: finite(momentum), consistency: finite(consistency), breakout: finite(breakout), recency: finite(recency) }
  const available = Object.entries(profile.weights).filter(([name, weight]) => weight > 0 && components[name] !== null)
  const availableWeight = available.reduce((sum, [, weight]) => sum + weight, 0)
  if (availableWeight === 0) return { rawScore: null, availableWeight: 0, components, evidenceMatch: null }
  const signalScore = available.reduce((sum, [name, weight]) => sum + components[name] * weight, 0) / availableWeight
  const normalizedCoverage = Math.max(0, Math.min(1, Number.isFinite(historyCoverage) ? historyCoverage : 0))
  const evidenceMatch = profile.historyCoverageFloor + profile.historyCoverageWeight * normalizedCoverage
  return { rawScore: signalScore * evidenceMatch, signalScore, evidenceMatch, availableWeight, components, accelerationSource: historical !== null ? 'historical-growth' : fallback !== null ? 'discovery-acceleration' : null, discoveryFallbackScale: historical === null && fallback !== null ? profile.discoveryFallbackScale : null }
}

/** Consumer display score is a monotonic transform of the measured unified raw score, never rank. */
export function nowScoreFromUnifiedRaw(rawScore) { if (!Number.isFinite(rawScore)) return null; return Math.min(UNIFIED_PUBLIC_SCORE.ceiling, UNIFIED_PUBLIC_SCORE.floor + UNIFIED_PUBLIC_SCORE.multiplier * rawScore) }
