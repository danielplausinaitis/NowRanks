import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildSeparateTrendingLanes,
  evaluateProposedUnifiedStrategy,
  SHADOW_CALIBRATION_DECISION,
  SHADOW_CALIBRATION_OPTIONS,
  SHADOW_TRENDING_MODELS,
  UNIFIED_TRENDING_INVARIANTS,
} from './shadowTrendingCalibration.mjs'

const cohort = [
  { id: 'strong-established', topic: 'Strong established', shadowTrendingScore: 82, shadowEmergingTrendingScore: null, shadowOverallScore: 78, confidence: 'full', scoreCompleteness: 'full', probe: 90 },
  { id: 'weak-established', topic: 'Weak established', shadowTrendingScore: 24, shadowEmergingTrendingScore: null, shadowOverallScore: 55, confidence: 'full', scoreCompleteness: 'full', probe: 35 },
  { id: 'strong-emerging', topic: 'Strong emerging', shadowTrendingScore: null, shadowEmergingTrendingScore: 79, shadowOverallScore: null, confidence: 'emerging', scoreCompleteness: 'unavailable', probe: 85 },
  { id: 'weak-emerging', topic: 'Weak emerging', shadowTrendingScore: null, shadowEmergingTrendingScore: 56, shadowOverallScore: null, confidence: 'emerging', scoreCompleteness: 'unavailable', probe: 30 },
  { id: 'high-demand-weak-history', topic: 'High demand weak history', shadowTrendingScore: 18, shadowEmergingTrendingScore: null, shadowOverallScore: 70, confidence: 'full', scoreCompleteness: 'full', probe: 40 },
  { id: 'huge-increase-low-volume', topic: 'Huge increase low volume', shadowTrendingScore: null, shadowEmergingTrendingScore: 60, shadowOverallScore: null, confidence: 'emerging', scoreCompleteness: 'unavailable', probe: 45 },
  { id: 'high-volume-less-recent', topic: 'High volume less recent', shadowTrendingScore: null, shadowEmergingTrendingScore: 70, shadowOverallScore: null, confidence: 'emerging', scoreCompleteness: 'unavailable', probe: 65 },
  { id: 'insufficient', topic: 'Insufficient', shadowTrendingScore: null, shadowEmergingTrendingScore: null, shadowOverallScore: null, confidence: 'insufficient', scoreCompleteness: 'unavailable' },
]

describe('shadow Trending calibration evaluation', () => {
  it('documents why identical 0-100 bounds do not make the models interchangeable', () => {
    expect(SHADOW_TRENDING_MODELS.established.weights).toEqual({ searchInterest: 0.1, growth: 0.4, momentum: 0.35, consistency: 0.1, breakout: 0.05 })
    expect(SHADOW_TRENDING_MODELS.emerging.weights).toEqual({ searchInterest: 0.5, boundedIncrease: 0.3, recency: 0.2 })
    expect(SHADOW_TRENDING_MODELS.established.sharedSignals).toEqual(['searchInterest'])
    expect(SHADOW_CALIBRATION_DECISION).toMatchObject({ unifiedRankingDefensible: false, rawMergeAllowed: false, recommendedPresentation: 'separate-lanes' })
  })

  it('rejects unsupported percentile, shared-backbone, and confidence-adjusted shortcuts', () => {
    expect(SHADOW_CALIBRATION_OPTIONS.commonCohortPercentile.supported).toBe(false)
    expect(SHADOW_CALIBRATION_OPTIONS.sharedCurrentBackbone.supported).toBe(false)
    expect(SHADOW_CALIBRATION_OPTIONS.confidenceAdjustedScore.supported).toBe(false)
    expect(SHADOW_CALIBRATION_OPTIONS.separateLanes.supported).toBe(true)
  })

  it('keeps established and emerging candidates deterministic but never assigns a combined rank', () => {
    const result = buildSeparateTrendingLanes(cohort)
    expect(result.established.map((entry) => entry.id)).toEqual(['strong-established', 'weak-established', 'high-demand-weak-history'])
    expect(result.emerging.map((entry) => entry.id)).toEqual(['strong-emerging', 'high-volume-less-recent', 'huge-increase-low-volume', 'weak-emerging'])
    expect([...result.established, ...result.emerging].every((entry) => entry.unifiedRank === null)).toBe(true)
  })

  it('preserves classification, confidence, score basis, and historically gated Overall metadata', () => {
    const result = buildSeparateTrendingLanes(cohort)
    expect(result.established[0]).toMatchObject({ confidence: 'full', scoreBasis: 'historical-trending', shadowOverallScore: 78 })
    expect(result.emerging[0]).toMatchObject({ confidence: 'emerging', scoreBasis: 'current-emerging-evidence', shadowOverallScore: null })
    expect(result.unavailable[0]).toMatchObject({ scoreBasis: 'insufficient-evidence', shadowOverallScore: null })
  })

  it('evaluates every required cross-lane ordering invariant deterministically without activating a strategy', () => {
    const result = evaluateProposedUnifiedStrategy({
      name: 'deterministic-test-probe',
      cohort: cohort.filter((entry) => entry.probe !== undefined),
      scoreCandidate: (candidate) => candidate.probe,
    })
    expect(result.invariants.map(({ id }) => id)).toEqual(UNIFIED_TRENDING_INVARIANTS.map(({ id }) => id))
    expect(result.invariants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'strong-emerging-over-weak-established', passed: true }),
      expect.objectContaining({ id: 'strong-established-over-weak-emerging', passed: true }),
      expect.objectContaining({ id: 'increase-alone-not-first', passed: true }),
      expect.objectContaining({ id: 'demand-alone-not-first', passed: true }),
      expect.objectContaining({ id: 'recency-breaks-emerging-tie', passed: true }),
    ]))
    expect(result).toMatchObject({ passed: true, activationApproved: false })
  })

  it('exposes a failed invariant rather than blessing a convenient ranking', () => {
    const result = evaluateProposedUnifiedStrategy({
      name: 'increase-only-bad-probe',
      cohort: cohort.filter((entry) => entry.probe !== undefined),
      scoreCandidate: (candidate) => candidate.id === 'huge-increase-low-volume' ? 100 : candidate.probe,
    })
    expect(result.passed).toBe(false)
    expect(result.invariants.find(({ id }) => id === 'increase-alone-not-first').passed).toBe(false)
    expect(result.activationApproved).toBe(false)
  })

  it('remains isolated from providers, persistence, production scoring, and replay scoring', () => {
    const moduleSource = readFileSync('server/live/shadowTrendingCalibration.mjs', 'utf8')
    const productionScorer = readFileSync('src/domain/scoring.ts', 'utf8')
    expect(moduleSource).not.toMatch(/^import\s/m)
    expect(moduleSource).not.toMatch(/\bfetch\s*\(|\.from\s*\(|\.insert\s*\(|\.upsert\s*\(/)
    expect(productionScorer).not.toMatch(/shadowTrendingCalibration/)
  })
})
