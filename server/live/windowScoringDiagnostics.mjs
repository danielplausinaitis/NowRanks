import { SHADOW_HISTORY_WINDOWS } from './elapsedShadowHistory.mjs'

function value(number) {
  return Number.isFinite(number) ? number : null
}

/** Pure, provider-free projection for comparing one candidate's independently scored windows. */
export function summarizeWindowScore(entry) {
  if (!entry?.history?.requestedWindow || !SHADOW_HISTORY_WINDOWS[entry.history.requestedWindow]) throw new Error('Window score diagnostics require a scored live entry with a supported requested window')
  return {
    topic: entry.topic,
    normalizedQuery: entry.normalizedQuery,
    window: entry.history.requestedWindow,
    providerRange: SHADOW_HISTORY_WINDOWS[entry.history.requestedWindow].providerTimeRange,
    searchInterest: value(entry.components?.searchInterest),
    currentTrendIntensity: value(entry.normalized?.currentTrendIntensity),
    baselineDemand: value(entry.normalized?.baselineDemand),
    growth: value(entry.components?.growth),
    momentum: value(entry.components?.momentum),
    consistency: value(entry.components?.consistency),
    breakout: value(entry.components?.breakout),
    availableComponentWeight: entry.availableComponentWeight ?? { overall: null, trending: null },
    overallScore: value(entry.shadowOverallScore),
    trendingScore: value(entry.shadowTrendingScore),
    emergingTrendingScore: value(entry.shadowEmergingTrendingScore),
    eligibility: entry.status,
    confidence: entry.confidence,
    confidenceReason: entry.confidenceReason,
    history: {
      observations: entry.history.observationCount,
      available: entry.history.availableCount,
      coveragePercentage: value(entry.history.coveragePercentage),
      firstTimestamp: entry.history.firstTimestamp,
      lastTimestamp: entry.history.lastTimestamp,
      detectedResolution: entry.history.detectedResolution,
    },
  }
}

export function summarizeCandidateAcrossWindows(entries, normalizedQuery) {
  return entries
    .filter((entry) => entry.normalizedQuery === normalizedQuery)
    .map(summarizeWindowScore)
    .sort((left, right) => Object.keys(SHADOW_HISTORY_WINDOWS).indexOf(left.window) - Object.keys(SHADOW_HISTORY_WINDOWS).indexOf(right.window))
}
