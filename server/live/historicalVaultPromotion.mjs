function finite(value) { return Number.isFinite(value) ? value : null }
function coverage(segment) {
  const actual = Number(segment?.actual ?? 0)
  const expected = Number(segment?.expected ?? 12)
  const minimum = expected === 168 ? 126 : 9
  return { actual, expected, minimum, sufficient: actual >= minimum, complete: actual === expected }
}
function priorMean(segment) {
  const values = Array.isArray(segment?.values) ? segment.values.filter(Number.isFinite) : []
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null
}
function freshness(growth) {
  const ageMinutes = finite(growth?.freshnessAgeMinutes)
  const allowanceMinutes = finite(growth?.freshnessAllowanceMinutes)
  return { fresh: ageMinutes !== null && allowanceMinutes !== null && ageMinutes <= allowanceMinutes, ageMinutes, allowanceMinutes, latestPointAt: growth?.latestPointAt ?? null }
}

function decision({ eligible, source, reason, confidence, coverageRecent, coveragePrevious, fresh, canonicalSegment, recentAlignmentConfidence, mode, bootstrapOnly = false }) {
  const promotionOutcome = mode === 'shadow' && eligible
    ? 'would-promote-in-shadow'
    : mode === 'preferred' && eligible
      ? 'promoted-in-preferred'
      : 'fallback'
  return {
    eligible, source, reason, fallbackReason: reason, promotionOutcome, confidence, coverageRecent, coveragePrevious,
    freshness: fresh, canonicalSegment, recentAlignmentConfidence,
    bootstrapOnly,
    wouldPromoteInShadow: mode === 'shadow' && eligible,
    promotedInPreferred: mode === 'preferred' && eligible,
  }
}

/**
 * Public-presentation gate only. It never recalculates or caps Growth: it validates
 * the existing canonical result for its supported window and leaves every fallback untouched.
 */
export function evaluateCanonicalGrowthPromotion({ window, vaultGrowth, mode = 'off' }) {
  const source = vaultGrowth?.growthSource ?? 'unavailable'
  const confidence = vaultGrowth?.confidence ?? 'unavailable'
  const coverageRecent = coverage(vaultGrowth?.recent)
  const coveragePrevious = coverage(vaultGrowth?.previous)
  const fresh = freshness(vaultGrowth)
  const canonicalSegment = vaultGrowth?.canonicalSegment ?? null
  const recentAlignmentConfidence = vaultGrowth?.recentAlignmentConfidence ?? 'unavailable'
  const bootstrapOnly = vaultGrowth?.bootstrapOnly === true
  const reject = (reason) => decision({ eligible: false, source, reason, confidence, coverageRecent, coveragePrevious, fresh, canonicalSegment, recentAlignmentConfidence, mode, bootstrapOnly })
  if (!['24H', '7D'].includes(window)) return reject('unsupported-window')
  if (vaultGrowth?.status !== 'available') {
    if (window === '7D' && vaultGrowth?.reason === 'no-canonical-history') return reject('no-canonical-history')
    if (vaultGrowth?.reason === 'stale-canonical-history') return reject('stale-history')
    if (vaultGrowth?.reason === 'insufficient-recent-coverage') return reject('insufficient-recent-coverage')
    if (vaultGrowth?.reason === 'insufficient-previous-coverage') return reject('insufficient-previous-coverage')
    if (vaultGrowth?.reason === 'zero-baseline' || vaultGrowth?.reason === 'unsafe-denominator') return reject('zero-baseline')
    return reject('unavailable-history')
  }
  if (source !== 'nowranks-history') return reject('unavailable-history')
  if (!Number.isFinite(vaultGrowth.growthPercent)) return reject('non-finite-growth')
  if (!canonicalSegment) return reject('no-current-segment')
  if (vaultGrowth.crossSegmentBlended === true) return reject('cross-segment-history')
  if (!fresh.fresh) return reject('stale-history')
  if (!coverageRecent.sufficient) return reject('insufficient-recent-coverage')
  if (!coveragePrevious.sufficient) return reject('insufficient-previous-coverage')
  const baseline = priorMean(vaultGrowth.previous)
  if (!Number.isFinite(baseline) || baseline <= 0) return reject('zero-baseline')
  if (!['high', 'medium'].includes(recentAlignmentConfidence)) return reject('recent-alignment-untrusted')
  // Medium calibration is usable only with full (not merely minimum) coverage in
  // both comparison halves. High confidence retains the established 9/12 minimum.
  if (recentAlignmentConfidence === 'medium' && (!coverageRecent.complete || !coveragePrevious.complete)) return reject('medium-confidence-requires-complete-coverage')
  return decision({ eligible: true, source, reason: null, confidence, coverageRecent, coveragePrevious, fresh, canonicalSegment, recentAlignmentConfidence, mode, bootstrapOnly })
}

// Preserve the established 24H import while exposing the generalized canonical
// gate to the 7D ingestion path.
export const evaluate24hGrowthPromotion = evaluateCanonicalGrowthPromotion
