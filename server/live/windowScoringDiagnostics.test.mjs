import { describe, expect, it } from 'vitest'
import { summarizeCandidateAcrossWindows, summarizeWindowScore } from './windowScoringDiagnostics.mjs'

function entry(window, patch = {}) {
  return { topic: 'Clay Matthews', normalizedQuery: 'clay matthews', status: 'scored', confidence: 'full', confidenceReason: 'fixture', normalized: { currentTrendIntensity: 90, baselineDemand: 70 }, components: { searchInterest: 84, growth: 50, momentum: 40, consistency: 30, breakout: 20 }, availableComponentWeight: { overall: 1, trending: 1 }, shadowOverallScore: 58, shadowTrendingScore: 47, shadowEmergingTrendingScore: null, history: { requestedWindow: window, observationCount: 52, availableCount: 52, coveragePercentage: 100, firstTimestamp: '2025-01-01T00:00:00.000Z', lastTimestamp: '2025-12-31T00:00:00.000Z', detectedResolution: 'weekly' }, ...patch }
}

describe('window score diagnostics', () => {
  it('projects every requested component and the correct provider range without changing a score', () => {
    const result = summarizeWindowScore(entry('1Y'))
    expect(result).toMatchObject({ window: '1Y', providerRange: 'past_12_months', searchInterest: 84, currentTrendIntensity: 90, baselineDemand: 70, growth: 50, momentum: 40, consistency: 30, breakout: 20, availableComponentWeight: { overall: 1, trending: 1 }, overallScore: 58, trendingScore: 47, eligibility: 'scored', confidence: 'full' })
  })
  it('orders an individual candidate’s independent results by the product windows', () => {
    const result = summarizeCandidateAcrossWindows([entry('1Y'), entry('30D'), entry('24H'), { ...entry('7D'), normalizedQuery: 'other' }], 'clay matthews')
    expect(result.map((item) => item.window)).toEqual(['24H', '30D', '1Y'])
  })
})
