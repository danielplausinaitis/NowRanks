import { diagnoseHistoricalComponents } from './shadowTemporalDiagnostics.mjs'
import { evaluateElapsedShadowHistory } from './elapsedShadowHistory.mjs'
import { evaluateColdStartTrending } from './coldStartShadowScoring.mjs'

export const SHADOW_SEARCH_INTEREST_WEIGHTS = Object.freeze({ currentTrendIntensity: 0.7, baselineDemand: 0.3 })
export const SHADOW_HISTORY_REQUIREMENTS = Object.freeze({ growth: 14, momentum: 14, consistency: 2, breakout: 14 })
export const PARTIAL_SHADOW_EVIDENCE = Object.freeze({
  minimumHistoryCoverage: 0.8,
  minimumHistoricalComponents: 2,
  minimumOverallWeight: 0.7,
  minimumTrendingWeight: 0.6,
  highConfidenceCoverage: 0.9,
})

function validNonNegative(value) {
  return Number.isFinite(value) && value >= 0
}

/** Monotonic skew reduction followed by the existing cohort min-max convention. */
export function logNormalizeCohort(values, normalize) {
  const available = values.map((value, index) => validNonNegative(value) ? { index, transformed: Math.log1p(value) } : null).filter(Boolean)
  const normalized = normalize(available.map(({ transformed }) => transformed))
  const result = values.map(() => null)
  available.forEach(({ index }, position) => { result[index] = normalized[position] })
  return result
}

/** Removes provider batch amplitude while retaining each candidate's within-topic temporal shape. */
export function peakNormalizeHistory(observations) {
  if (!Array.isArray(observations) || observations.length === 0 || observations.some((point) => point?.availability !== 'available' || !validNonNegative(point.interest))) return null
  const values = observations.map((point) => point.interest)
  const peak = Math.max(...values)
  return peak === 0 ? values.map(() => 0) : values.map((value) => value / peak * 100)
}

function normalizeNullable(values, normalize) {
  const available = values.map((value, index) => value === null ? null : { value, index }).filter(Boolean)
  const normalized = normalize(available.map(({ value }) => value))
  const result = values.map(() => null)
  available.forEach(({ index }, position) => { result[index] = normalized[position] })
  return result
}

function weightedScore(components, weights) {
  return Object.entries(weights).reduce((sum, [component, weight]) => sum + components[component] * weight, 0)
}

export function renormalizedAvailableScore(components, weights) {
  const available = Object.entries(weights).filter(([component]) => components[component] !== null)
  const availableWeight = available.reduce((sum, [, weight]) => sum + weight, 0)
  if (availableWeight === 0) return { score: null, availableWeight: 0 }
  const weightedTotal = available.reduce((sum, [component, weight]) => sum + components[component] * weight, 0)
  return { score: weightedTotal / availableWeight, availableWeight }
}

function partialEvidence({ components, shape, scoreWeights }) {
  const historicalKeys = ['growth', 'momentum', 'consistency', 'breakout']
  const availableHistorical = historicalKeys.filter((component) => components[component] !== null)
  const historyCoverage = shape.observationCount === 0 ? 0 : shape.availableObservationCount / shape.observationCount
  const overall = renormalizedAvailableScore(components, scoreWeights.overall)
  const trending = renormalizedAvailableScore(components, scoreWeights.trending)
  const hasRecentShape = ['growth', 'momentum', 'breakout'].some((component) => components[component] !== null)
  const reasons = []
  if (components.searchInterest === null) reasons.push('search-interest-required')
  if (historyCoverage < PARTIAL_SHADOW_EVIDENCE.minimumHistoryCoverage) reasons.push('history-coverage-below-80-percent')
  if (availableHistorical.length < PARTIAL_SHADOW_EVIDENCE.minimumHistoricalComponents) reasons.push('fewer-than-two-historical-components')
  if (!hasRecentShape) reasons.push('no-recent-sensitive-historical-component')
  if (overall.availableWeight < PARTIAL_SHADOW_EVIDENCE.minimumOverallWeight) reasons.push('overall-available-weight-below-70-percent')
  if (trending.availableWeight < PARTIAL_SHADOW_EVIDENCE.minimumTrendingWeight) reasons.push('trending-available-weight-below-60-percent')
  const eligible = reasons.length === 0
  const confidence = !eligible
    ? 'insufficient'
    : availableHistorical.length === historicalKeys.length
      ? 'full'
      : availableHistorical.length >= 3 && historyCoverage >= PARTIAL_SHADOW_EVIDENCE.highConfidenceCoverage
        ? 'partial-high'
        : 'partial-low'
  return {
    eligible,
    confidence,
    confidenceReason: eligible
      ? confidence === 'full'
        ? 'all historical components and mandatory Search Interest are available'
        : `${availableHistorical.length}/4 historical components available with ${(historyCoverage * 100).toFixed(1)}% history coverage`
      : reasons.join('; '),
    availableHistoricalComponents: availableHistorical,
    availableWeight: { overall: overall.availableWeight, trending: trending.availableWeight },
    scores: { overall: overall.score, trending: trending.score },
  }
}

function rawShape(candidate, signalEngine) {
  const observations = candidate.historicalTrendShape?.observations ?? []
  const diagnostics = diagnoseHistoricalComponents(observations, SHADOW_HISTORY_REQUIREMENTS)
  const history = peakNormalizeHistory(observations)
  const availableCount = history?.length ?? 0
  const value = (component, calculate) => history && availableCount >= SHADOW_HISTORY_REQUIREMENTS[component] ? calculate(history) : null
  return {
    rawHistory: observations,
    peakNormalizedHistory: history,
    historyCount: availableCount,
    observationCount: observations.length,
    availableObservationCount: observations.filter((point) => point?.availability === 'available').length,
    sufficientForAllComponents:
      history !== null && history.length >= Math.max(...Object.values(SHADOW_HISTORY_REQUIREMENTS)),
    diagnostics,
    growth: value('growth', signalEngine.growthSignal),
    momentum: value('momentum', signalEngine.momentumSignal),
    consistency: value('consistency', signalEngine.consistencySignal),
    breakout: value('breakout', signalEngine.breakoutSignal),
  }
}

function elapsedRawShape(candidate, window) {
  const observations = candidate.historicalTrendShape?.observations ?? []
  const diagnostics = diagnoseHistoricalComponents(observations, SHADOW_HISTORY_REQUIREMENTS)
  const evaluation = evaluateElapsedShadowHistory(observations, window, diagnostics.timeline)
  const components = evaluation.components
  return {
    rawHistory: observations,
    peakNormalizedHistory: evaluation.normalizedHistory,
    historyCount: diagnostics.validCount,
    observationCount: diagnostics.totalCount,
    availableObservationCount: diagnostics.validCount,
    sufficientForAllComponents: Object.values(components).every((component) => component.status === 'available'),
    diagnostics: { ...diagnostics, components },
    growth: components.growth.value,
    momentum: components.momentum.value,
    consistency: components.consistency.value,
    breakout: components.breakout.value,
    requestedWindow: window,
  }
}

/**
 * Isolated live shadow scorer. It never imports persistence, replay providers, API handlers, or browser code.
 * The existing signal formulas and production component weights are injected by the caller.
 */
function scoreCohort({ candidates, signalEngine, scoreWeights, historyWindow = null, coldStartMaxAgeHours = 24 }) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('Shadow scoring requires at least one live candidate')
  for (const functionName of ['normalize', 'growthSignal', 'momentumSignal', 'consistencySignal', 'breakoutSignal']) {
    if (typeof signalEngine?.[functionName] !== 'function') throw new Error(`Shadow scoring requires existing ${functionName}`)
  }
  if (!scoreWeights?.overall || !scoreWeights?.trending) throw new Error('Shadow scoring requires existing Overall and Trending weights')

  const currentRaw = candidates.map((candidate) => candidate.currentTrendIntensity?.searchVolume)
  const baselineRaw = candidates.map((candidate) => candidate.baselineDemand?.availability === 'available' ? candidate.baselineDemand.searchVolume : null)
  const currentNormalized = logNormalizeCohort(currentRaw, signalEngine.normalize)
  const baselineNormalized = logNormalizeCohort(baselineRaw, signalEngine.normalize)
  const shapes = candidates.map((candidate) => historyWindow
    ? elapsedRawShape(candidate, historyWindow)
    : rawShape(candidate, signalEngine))
  const normalizedShape = Object.fromEntries(['growth', 'momentum', 'consistency', 'breakout'].map((component) => [component, normalizeNullable(shapes.map((shape) => shape[component]), signalEngine.normalize)]))

  const entries = candidates.map((candidate, index) => {
    const searchInterest = currentNormalized[index] === null || baselineNormalized[index] === null
      ? null
      : currentNormalized[index] * SHADOW_SEARCH_INTEREST_WEIGHTS.currentTrendIntensity + baselineNormalized[index] * SHADOW_SEARCH_INTEREST_WEIGHTS.baselineDemand
    const components = {
      searchInterest,
      growth: normalizedShape.growth[index],
      momentum: normalizedShape.momentum[index],
      consistency: normalizedShape.consistency[index],
      breakout: normalizedShape.breakout[index],
    }
    const missingComponents = Object.entries(components).filter(([, value]) => value === null).map(([component]) => component)
    const evidence = historyWindow ? partialEvidence({ components, shape: shapes[index], scoreWeights }) : null
    const historyCoverage = shapes[index].observationCount === 0 ? 0 : shapes[index].availableObservationCount / shapes[index].observationCount
    const emerging = historyWindow ? evaluateColdStartTrending({
      candidate,
      searchInterest,
      normalizedCurrentIntensity: currentNormalized[index],
      historyCoverage,
      establishedEligible: evidence.eligible,
      maximumAgeHours: coldStartMaxAgeHours,
    }) : null
    const scorable = historyWindow ? evidence.eligible : missingComponents.length === 0
    const searchInterestDiagnostic = searchInterest !== null
      ? { status: 'available', reason: null }
      : currentNormalized[index] === null
        ? { status: 'unavailable', reason: 'missing-current-trend-intensity' }
        : { status: 'unavailable', reason: 'missing-baseline-demand' }
    return {
      topic: candidate.topic,
      normalizedQuery: candidate.normalizedQuery,
      category: candidate.category,
      status: scorable ? 'scored' : emerging?.eligible ? 'emerging' : 'insufficient-signal',
      topicClassification: !historyWindow
        ? scorable ? 'established' : 'insufficient-provider-data'
        : scorable
          ? evidence.confidence === 'full' ? 'established' : 'partial-history'
          : emerging.eligible ? 'possible-new-trend' : 'insufficient-provider-data',
      scoreCompleteness: !scorable ? 'unavailable' : evidence?.confidence === 'full' || !historyWindow ? 'full' : 'partial',
      confidence: historyWindow ? scorable ? evidence.confidence : emerging.confidence : scorable ? 'full' : 'insufficient',
      confidenceReason: historyWindow
        ? scorable
          ? evidence.confidenceReason
          : emerging.eligible
            ? emerging.reason
            : `${evidence.confidenceReason}; cold-start: ${emerging.reason}`
        : scorable ? 'all components available' : 'one or more components unavailable',
      availableComponentWeight: historyWindow ? evidence.availableWeight : {
        overall: missingComponents.length === 0 ? 1 : null,
        trending: missingComponents.length === 0 ? 1 : null,
      },
      coldStart: historyWindow ? emerging : null,
      missingComponents,
      componentDiagnostics: {
        searchInterest: searchInterestDiagnostic,
        ...shapes[index].diagnostics.components,
      },
      raw: {
        currentTrendIntensity: candidate.currentTrendIntensity ?? null,
        baselineDemand: candidate.baselineDemand ?? null,
        historicalTrendShape: shapes[index].rawHistory,
      },
      normalized: {
        currentTrendIntensity: currentNormalized[index],
        baselineDemand: baselineNormalized[index],
        historicalPeakNormalized: shapes[index].peakNormalizedHistory,
      },
      components,
      history: {
        count: shapes[index].historyCount,
        observationCount: shapes[index].observationCount,
        availableCount: shapes[index].availableObservationCount,
        sufficientForAllComponents: shapes[index].sufficientForAllComponents,
        firstTimestamp: shapes[index].diagnostics.timeline.firstTimestamp,
        lastTimestamp: shapes[index].diagnostics.timeline.lastTimestamp,
        medianIntervalHours: shapes[index].diagnostics.timeline.medianIntervalHours,
        detectedResolution: shapes[index].diagnostics.timeline.detectedResolution,
        largeGapCount: shapes[index].diagnostics.timeline.largeGapCount,
        missingCount: shapes[index].diagnostics.missingCount,
        coveragePercentage: shapes[index].observationCount === 0
          ? 0
          : shapes[index].availableObservationCount / shapes[index].observationCount * 100,
        duplicateCount: shapes[index].diagnostics.timeline.duplicateCount,
        unsorted: shapes[index].diagnostics.timeline.unsorted,
        requestedWindow: shapes[index].requestedWindow,
        requirements: SHADOW_HISTORY_REQUIREMENTS,
      },
      provenance: {
        currentTrendIntensity: candidate.currentTrendIntensity?.providerId ?? null,
        baselineDemand: candidate.baselineDemand?.providerId ?? null,
        historicalTrendShape: candidate.historicalTrendShape?.provenance?.providerId ?? candidate.historicalTrendShape?.providerId ?? null,
      },
      shadowOverallScore: scorable
        ? historyWindow ? evidence.scores.overall : weightedScore(components, scoreWeights.overall)
        : null,
      shadowTrendingScore: scorable
        ? historyWindow ? evidence.scores.trending : weightedScore(components, scoreWeights.trending)
        : null,
      shadowEmergingTrendingScore: emerging?.eligible ? emerging.score : null,
    }
  })
  const emergingRanks = new Map(entries
    .filter((entry) => entry.shadowEmergingTrendingScore !== null)
    .sort((left, right) => right.shadowEmergingTrendingScore - left.shadowEmergingTrendingScore || left.topic.localeCompare(right.topic))
    .map((entry, index) => [entry.normalizedQuery, index + 1]))
  return entries.sort((a, b) => {
    if (a.shadowOverallScore === null && b.shadowOverallScore !== null) return 1
    if (a.shadowOverallScore !== null && b.shadowOverallScore === null) return -1
    return (b.shadowOverallScore ?? 0) - (a.shadowOverallScore ?? 0) || a.topic.localeCompare(b.topic)
  }).map((entry, index) => ({
    ...entry,
    shadowRank: entry.status === 'scored' ? index + 1 : null,
    shadowEmergingRank: emergingRanks.get(entry.normalizedQuery) ?? null,
  }))
}

export function scoreShadowLiveCohort(args) {
  return scoreCohort(args)
}

/** Separate elapsed-time path used only by the no-write live shadow command. */
export function scoreElapsedTimeShadowLiveCohort(args) {
  if (!args?.historyWindow) throw new Error('Elapsed-time shadow scoring requires historyWindow')
  return scoreCohort(args)
}
