/**
 * Future live scoring input boundary. Signal families stay separate until a later task
 * explicitly derives scoring components and validates weights.
 */
export function composeLiveMeasurementSignals({ candidate, currentTrendIntensity, baselineDemand, historicalTrendShape }) {
  if (!candidate?.normalizedQuery) throw new Error('Live signal composition requires a candidate identity')
  if (!currentTrendIntensity?.providerId) throw new Error('Live signal composition requires SerpApi current trend intensity')
  if (!baselineDemand?.providerId) throw new Error('Live signal composition requires DataForSEO baseline demand')
  if (!historicalTrendShape?.providerId) throw new Error('Live signal composition requires DataForSEO historical trend shape')
  return {
    candidate,
    signals: {
      currentTrendIntensity,
      baselineDemand,
      historicalTrendShape,
    },
    futureScoringUse: {
      searchInterest: ['currentTrendIntensity', 'baselineDemand'],
      growth: 'historicalTrendShape',
      momentum: 'historicalTrendShape',
      consistency: 'historicalTrendShape',
      breakout: 'historicalTrendShape',
    },
  }
}
