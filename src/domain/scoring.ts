import { SCORE_WEIGHTS } from './config'
import type { ComponentScores, SearchTopicData } from './types'

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
  const values = observations.slice(-30)
  if (values.length < 2) return 0
  const mean = average(values)
  if (mean === 0) return 0
  const variance = average(values.map((value) => (value - mean) ** 2))
  // A stable elevated baseline scores higher than a one-day spike.
  return clamp(100 * (1 - Math.sqrt(variance) / mean))
}

export function weightedScore(scores: ComponentScores, weights: Record<keyof ComponentScores, number>) {
  return scores.searchInterest * weights.searchInterest + scores.growth * weights.growth + scores.momentum * weights.momentum + scores.consistency * weights.consistency
}

export function scoreTopics(data: SearchTopicData[]) {
  const raw = data.map((item) => {
    const observations = item.observations.map(({ interest }) => interest)
    return { item, interest: average(observations.slice(-7)), growth: growthSignal(observations), momentum: momentumSignal(observations), consistency: consistencySignal(observations) }
  })
  const interest = normalize(raw.map((item) => item.interest))
  const growth = normalize(raw.map((item) => item.growth))
  const momentum = normalize(raw.map((item) => item.momentum))
  return raw.map((entry, index) => {
    const componentScores: ComponentScores = { searchInterest: interest[index], growth: growth[index], momentum: momentum[index], consistency: entry.consistency }
    return {
      id: entry.item.id, topic: entry.item.topic, category: entry.item.category, componentScores,
      overallScore: weightedScore(componentScores, SCORE_WEIGHTS.overall),
      trendingScore: weightedScore(componentScores, SCORE_WEIGHTS.trending),
    }
  })
}
