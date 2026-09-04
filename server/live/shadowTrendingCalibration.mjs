/**
 * Pure shadow-only calibration evaluation. This module deliberately has no provider,
 * persistence, API, frontend, or production-scoring dependencies.
 */

export const SHADOW_TRENDING_MODELS = Object.freeze({
  established: Object.freeze({
    weights: Object.freeze({ searchInterest: 0.1, growth: 0.4, momentum: 0.35, consistency: 0.1, breakout: 0.05 }),
    sharedSignals: Object.freeze(['searchInterest']),
    uniqueSignals: Object.freeze(['growth', 'momentum', 'consistency', 'breakout']),
    meaning: 'cohort-relative historical movement with a small current-demand contribution',
  }),
  emerging: Object.freeze({
    weights: Object.freeze({ searchInterest: 0.5, boundedIncrease: 0.3, recency: 0.2 }),
    sharedSignals: Object.freeze(['searchInterest']),
    uniqueSignals: Object.freeze(['boundedIncrease', 'recency']),
    meaning: 'current evidence that a sparse-history topic is active, large enough, increasing, and recent',
  }),
})

export const SHADOW_CALIBRATION_OPTIONS = Object.freeze({
  commonCohortPercentile: Object.freeze({
    supported: false,
    reason: 'Within-lane percentiles preserve order but do not identify equivalent evidence strength across lanes; they are also unstable for small lane sizes.',
  }),
  sharedCurrentBackbone: Object.freeze({
    supported: false,
    reason: 'Search Interest is a valid shared backbone, but no validated conversion currently maps historical movement and emerging increase/recency onto equivalent adjustments.',
  }),
  confidenceAdjustedScore: Object.freeze({
    supported: false,
    reason: 'Confidence describes evidence completeness, not trend strength; multiplying by an arbitrary confidence factor would systematically demote genuine new trends.',
  }),
  separateLanes: Object.freeze({
    supported: true,
    reason: 'Each lane remains truthful to its evidence while cross-lane calibration is unvalidated.',
  }),
})

export const SHADOW_CALIBRATION_DECISION = Object.freeze({
  unifiedRankingDefensible: false,
  recommendedPresentation: 'separate-lanes',
  rawMergeAllowed: false,
  reason: 'The scores are bounded to the same numeric interval but have different constructs, weights, eligibility, and reference populations. No labeled outcomes or sufficiently broad paired cohorts currently establish a common scale.',
})

export const UNIFIED_TRENDING_INVARIANTS = Object.freeze([
  Object.freeze({ id: 'strong-emerging-over-weak-established', higher: 'strong-emerging', lower: 'weak-established' }),
  Object.freeze({ id: 'strong-established-over-weak-emerging', higher: 'strong-established', lower: 'weak-emerging' }),
  Object.freeze({ id: 'increase-alone-not-first', higher: 'strong-emerging', lower: 'huge-increase-low-volume' }),
  Object.freeze({ id: 'demand-alone-not-first', higher: 'strong-established', lower: 'high-demand-weak-history' }),
  Object.freeze({ id: 'recency-breaks-emerging-tie', higher: 'strong-emerging', lower: 'high-volume-less-recent' }),
])

function finiteScore(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100
}

function stableRank(entries, scoreKey) {
  return [...entries]
    .sort((left, right) => right[scoreKey] - left[scoreKey] || left.topic.localeCompare(right.topic))
    .map((entry, index) => ({ ...entry, laneRank: index + 1, unifiedRank: null }))
}

function disclosure(entry, lane, score, scoreBasis) {
  return {
    id: entry.id ?? entry.normalizedQuery,
    topic: entry.topic,
    lane,
    score,
    topicClassification: entry.topicClassification ?? (lane === 'established' ? 'established' : 'possible-new-trend'),
    confidence: entry.confidence,
    scoreCompleteness: entry.scoreCompleteness,
    scoreBasis,
    shadowOverallScore: lane === 'emerging' ? null : entry.shadowOverallScore ?? null,
  }
}

/**
 * Product-safe result for current evidence: two independently ordered lists and no implied
 * cross-lane rank. Emerging candidates retain an unavailable Overall score.
 */
export function buildSeparateTrendingLanes(cohort) {
  if (!Array.isArray(cohort)) throw new Error('Shadow calibration cohort must be an array')
  const established = []
  const emerging = []
  const unavailable = []
  for (const entry of cohort) {
    if (!entry?.topic || !(entry.id ?? entry.normalizedQuery)) throw new Error('Every calibration candidate requires topic and id or normalizedQuery')
    if (finiteScore(entry.shadowTrendingScore)) {
      established.push(disclosure(entry, 'established', entry.shadowTrendingScore, 'historical-trending'))
    } else if (finiteScore(entry.shadowEmergingTrendingScore)) {
      emerging.push(disclosure(entry, 'emerging', entry.shadowEmergingTrendingScore, 'current-emerging-evidence'))
    } else {
      unavailable.push({
        ...disclosure(entry, 'unavailable', null, 'insufficient-evidence'),
        laneRank: null,
        unifiedRank: null,
        shadowOverallScore: null,
      })
    }
  }
  return {
    strategy: 'separate-lanes',
    unifiedRankingDefensible: false,
    established: stableRank(established, 'score'),
    emerging: stableRank(emerging, 'score'),
    unavailable: unavailable.sort((left, right) => left.topic.localeCompare(right.topic)),
  }
}

/**
 * Test harness for future proposed calibration functions. Supplying a strategy here does not
 * approve or activate it; callers must evaluate every invariant and external validation data.
 */
export function evaluateProposedUnifiedStrategy({ name, cohort, scoreCandidate, invariants = UNIFIED_TRENDING_INVARIANTS }) {
  if (!name) throw new Error('Proposed calibration strategy requires a name')
  if (!Array.isArray(cohort) || cohort.length === 0) throw new Error('Proposed calibration strategy requires a non-empty cohort')
  if (typeof scoreCandidate !== 'function') throw new Error('Proposed calibration strategy requires scoreCandidate')
  const scored = cohort.map((candidate) => {
    const score = scoreCandidate(candidate, cohort)
    if (!finiteScore(score)) throw new Error(`Calibration strategy ${name} produced an invalid score for ${candidate.id}`)
    return { ...candidate, calibrationScore: score }
  })
  const ranked = scored
    .sort((left, right) => right.calibrationScore - left.calibrationScore || left.topic.localeCompare(right.topic))
    .map((entry, index) => ({ ...entry, unifiedRank: index + 1 }))
  const rankById = new Map(ranked.map((entry) => [entry.id, entry.unifiedRank]))
  const results = invariants.map((invariant) => ({
    ...invariant,
    passed: rankById.has(invariant.higher) && rankById.has(invariant.lower)
      ? rankById.get(invariant.higher) < rankById.get(invariant.lower)
      : false,
  }))
  return {
    name,
    ranked,
    invariants: results,
    passed: results.every((result) => result.passed),
    activationApproved: false,
  }
}
