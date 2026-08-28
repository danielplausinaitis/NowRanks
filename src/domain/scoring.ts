import { SCORE_WEIGHTS } from './config'
import { assertScorableTopicData } from './dataContract'
import { SCORE_COMPONENT_KEYS } from './types'
import type { ComponentScores, ComponentWeights, ScoredTopic, ScoringDiagnostic, SearchTopicData } from './types'

export const clamp = (value: number) => Math.max(0, Math.min(100, value))

/** Percentile normalization preserves relative standing and avoids raw percentage-growth distortions. */
export function normalize(values: number[]): number[] {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return values.map(() => 50)
  return values.map((value) => ((value - min) / (max - min)) * 100)
}

export function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

export function growthSignal(observations: number[]) {
  if (observations.length < 14) return 0
  const current = average(observations.slice(-7))
  const previous = average(observations.slice(-14, -7))
  // Log dampening and a volume factor prevent tiny bases from dominating the signal.
  return Math.log1p(Math.max(0, current - previous)) * Math.sqrt(current) / Math.max(1, previous)
}

export function momentumSignal(observations: number[]) {
  if (observations.length < 14) return 0
  const recent = average(observations.slice(-3)) - average(observations.slice(-6, -3))
  const weekly = average(observations.slice(-7)) - average(observations.slice(-14, -7))
  return Math.max(0, recent * 0.65 + weekly * 0.35)
}

export function consistencySignal(observations: number[]) {
  const values = observations
  if (values.length < 2) return 0
  const mean = average(values)
  if (mean === 0) return 0
  const variance = average(values.map((value) => (value - mean) ** 2))
  // A stable elevated baseline scores higher than a one-day spike across the selected history.
  return clamp(100 * (1 - Math.sqrt(variance) / mean))
}

/** Rewards a recent peak above the earlier selected-history baseline; it is normalized with every other component below. */
export function breakoutSignal(observations: number[]) {
  if (observations.length < 14) return 0
  const recentPeak = Math.max(...observations.slice(-7))
  const baseline = average(observations.slice(0, -7))
  return Math.max(0, recentPeak - baseline) / Math.max(1, baseline)
}

/** Apply the same min–max cohort normalization to every raw scoring component. */
export function normalizeComponentScores(rawScores: ComponentScores[]): ComponentScores[] {
  const normalizedByComponent = Object.fromEntries(
    SCORE_COMPONENT_KEYS.map((component) => [component, normalize(rawScores.map((scores) => scores[component]))]),
  ) as Record<keyof ComponentScores, number[]>

  return rawScores.map((_, index) => ({
    searchInterest: normalizedByComponent.searchInterest[index],
    growth: normalizedByComponent.growth[index],
    momentum: normalizedByComponent.momentum[index],
    consistency: normalizedByComponent.consistency[index],
    breakout: normalizedByComponent.breakout[index],
  }))
}

export function weightedContributions(scores: ComponentScores, weights: ComponentWeights): ComponentScores {
  return {
    searchInterest: scores.searchInterest * weights.searchInterest,
    growth: scores.growth * weights.growth,
    momentum: scores.momentum * weights.momentum,
    consistency: scores.consistency * weights.consistency,
    breakout: scores.breakout * weights.breakout,
  }
}

export function weightedScore(scores: ComponentScores, weights: ComponentWeights) {
  return SCORE_COMPONENT_KEYS.reduce((total, component) => total + scores[component] * weights[component], 0)
}

export function scoreTopics(data: SearchTopicData[]) {
  assertScorableTopicData(data)
  const raw = data.map((item) => {
    const observations = item.observations.map((observation) => {
      if (observation.availability !== 'available') throw new Error(`Candidate ${item.id} has missing interest data and cannot be scored`)
      return observation.interest
    })
    return {
      item,
      componentScores: {
        searchInterest: average(observations.slice(-7)),
        growth: growthSignal(observations),
        momentum: momentumSignal(observations),
        consistency: consistencySignal(observations),
        breakout: breakoutSignal(observations),
      },
    }
  })
  const componentScores = normalizeComponentScores(raw.map((entry) => entry.componentScores))
  return raw.map((entry, index) => {
    const scores = componentScores[index]
    const finalScore = weightedScore(scores, SCORE_WEIGHTS.overall)
    return {
      id: entry.item.id,
      topic: entry.item.topic,
      normalizedQuery: entry.item.normalizedQuery,
      category: entry.item.category,
      provenance: entry.item.provenance,
      componentScores: scores,
      finalScore,
      overallScore: finalScore,
      trendingScore: weightedScore(scores, SCORE_WEIGHTS.trending),
    }
  })
}

function profileForScoreType(scoreType: 'overallScore' | 'trendingScore') {
  return scoreType === 'overallScore' ? 'overall' : 'trending'
}

/**
 * Produce one complete, flattened diagnostic row per ranked candidate. The caller supplies the
 * source label so a replay fixture cannot be mistaken for a live Google measurement.
 */
export function buildScoringDiagnostics(
  entries: ScoredTopic[],
  scoreType: 'overallScore' | 'trendingScore' = 'overallScore',
  source = 'Unspecified source',
): ScoringDiagnostic[] {
  const scoreProfile = profileForScoreType(scoreType)
  const weights = SCORE_WEIGHTS[scoreProfile]
  return entries.map((entry) => {
    const contributions = weightedContributions(entry.componentScores, weights)
    const finalScore = entry[scoreType]
    return {
      source,
      scoreProfile,
      query: entry.topic,
      category: entry.category,
      finalScore,
      searchInterestComponent: entry.componentScores.searchInterest,
      growthComponent: entry.componentScores.growth,
      momentumComponent: entry.componentScores.momentum,
      consistencyComponent: entry.componentScores.consistency,
      breakoutComponent: entry.componentScores.breakout,
      searchInterestWeight: weights.searchInterest,
      growthWeight: weights.growth,
      momentumWeight: weights.momentum,
      consistencyWeight: weights.consistency,
      breakoutWeight: weights.breakout,
      searchInterestWeightedContribution: contributions.searchInterest,
      growthWeightedContribution: contributions.growth,
      momentumWeightedContribution: contributions.momentum,
      consistencyWeightedContribution: contributions.consistency,
      breakoutWeightedContribution: contributions.breakout,
      finalWeightedContribution: weightedScore(entry.componentScores, weights),
    }
  })
}

/** Development-only caller: expose all replay-derived score inputs in the browser console. */
export function reportScoringDiagnostics(
  entries: ScoredTopic[],
  scoreType: 'overallScore' | 'trendingScore',
  source: string,
) {
  const diagnostics = buildScoringDiagnostics(entries, scoreType, source)
  console.info(`NowRanks scoring diagnostics: ${source}. Values are replay/fixture-derived, not live Google measurements.`)
  console.table(diagnostics)
  return diagnostics
}
