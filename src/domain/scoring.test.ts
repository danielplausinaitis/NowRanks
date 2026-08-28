import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from './config'
import { calculateMovement, rankEntries, selectTopicDataForWindow } from './leaderboard'
import { buildScoringDiagnostics, consistencySignal, growthSignal, momentumSignal, normalize, normalizeComponentScores, scoreTopics, weightedScore } from './scoring'
import type { ComponentScores, SearchTopicData } from './types'

const series = (candidateId: string, values: number[]) => values.map((interest, index) => {
  const observedAt = new Date(Date.UTC(2025, 7, 26) + index * 86_400_000).toISOString()
  return { candidateId, date: observedAt.slice(0, 10), observedAt, availability: 'available' as const, interest }
})
const topic = (id: string, values: number[]): SearchTopicData => ({
  id,
  topic: id,
  normalizedQuery: id.toLocaleLowerCase('en-US'),
  category: 'Technology',
  provenance: {
    providerId: 'scoring-test',
    dataMode: 'test',
    sourceObservedAt: '2026-08-25T00:00:00.000Z',
    ingestedAt: '2026-08-25T00:00:00.000Z',
    geographicScope: { kind: 'global' },
    collectionMethod: 'deterministic-test-data',
    crossQueryComparability: { status: 'comparable', basis: 'controlled test data' },
  },
  observations: series(id, values),
})
const withRecentWeek = (baseline: number, recent: number) => [...Array(23).fill(baseline), ...Array(7).fill(recent)]

describe('scoring engine', () => {
  it('uses the proposed five component weights, which sum to 100%', () => {
    expect(SCORE_WEIGHTS.overall).toEqual({ searchInterest: 0.45, growth: 0.25, momentum: 0.15, consistency: 0.1, breakout: 0.05 })
    for (const weights of Object.values(SCORE_WEIGHTS)) {
      expect(Object.values(weights).reduce((total, weight) => total + weight, 0)).toBeCloseTo(1)
    }
  })

  it('normalizes every component with the same 0–100 cohort transform', () => {
    const raw: ComponentScores[] = [
      { searchInterest: 2, growth: 4, momentum: 6, consistency: 8, breakout: 10 },
      { searchInterest: 6, growth: 8, momentum: 10, consistency: 12, breakout: 14 },
      { searchInterest: 10, growth: 12, momentum: 14, consistency: 16, breakout: 18 },
    ]

    expect(normalizeComponentScores(raw)).toEqual([
      { searchInterest: 0, growth: 0, momentum: 0, consistency: 0, breakout: 0 },
      { searchInterest: 50, growth: 50, momentum: 50, consistency: 50, breakout: 50 },
      { searchInterest: 100, growth: 100, momentum: 100, consistency: 100, breakout: 100 },
    ])
    expect(normalize([2, 6, 10])).toEqual([0, 50, 100])
  })

  it('produces deterministic final scores and diagnostics from the same fixture inputs', () => {
    const data = [topic('low', Array(30).fill(50)), topic('rising', withRecentWeek(100, 140)), topic('high', Array(30).fill(300))]
    const first = scoreTopics(data)
    const second = scoreTopics(data)

    expect(first).toEqual(second)
    expect(buildScoringDiagnostics(first, 'overallScore', 'test replay fixture')).toEqual(buildScoringDiagnostics(second, 'overallScore', 'test replay fixture'))
  })

  it('does not lower a candidate search-interest component when its recent interest increases', () => {
    const baseline = scoreTopics([
      topic('low', Array(30).fill(50)),
      topic('target', Array(30).fill(100)),
      topic('high', Array(30).fill(200)),
    ])
    const increased = scoreTopics([
      topic('low', Array(30).fill(50)),
      topic('target', withRecentWeek(100, 130)),
      topic('high', Array(30).fill(200)),
    ])

    expect(increased.find((entry) => entry.id === 'target')!.componentScores.searchInterest)
      .toBeGreaterThanOrEqual(baseline.find((entry) => entry.id === 'target')!.componentScores.searchInterest)
  })

  it('does not lower a candidate growth component when its growth increases', () => {
    const baseline = scoreTopics([
      topic('flat', Array(30).fill(50)),
      topic('target', withRecentWeek(100, 110)),
      topic('high-growth', withRecentWeek(100, 200)),
    ])
    const increased = scoreTopics([
      topic('flat', Array(30).fill(50)),
      topic('target', withRecentWeek(100, 150)),
      topic('high-growth', withRecentWeek(100, 200)),
    ])

    expect(increased.find((entry) => entry.id === 'target')!.componentScores.growth)
      .toBeGreaterThanOrEqual(baseline.find((entry) => entry.id === 'target')!.componentScores.growth)
  })

  it('awards stronger recent acceleration a higher momentum score', () => {
    const steady = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
    const accelerating = [10, 10, 10, 10, 10, 10, 10, 11, 12, 14, 17, 21, 26, 32]
    const ranked = scoreTopics([topic('steady', steady), topic('accelerating', accelerating)])

    expect(growthSignal(withRecentWeek(10, 20))).toBeGreaterThan(0)
    expect(momentumSignal(accelerating)).toBeGreaterThan(momentumSignal(steady))
    expect(ranked.find((entry) => entry.id === 'accelerating')!.componentScores.momentum)
      .toBeGreaterThan(ranked.find((entry) => entry.id === 'steady')!.componentScores.momentum)
  })

  it('calculates each final score as the weighted sum of all five components', () => {
    const scored = scoreTopics([
      topic('low', Array(30).fill(50)),
      topic('breakout', [...Array(23).fill(100), 105, 110, 120, 135, 150, 175, 220]),
      topic('high', Array(30).fill(300)),
    ])
    const entry = scored.find((candidate) => candidate.id === 'breakout')!
    const diagnostic = buildScoringDiagnostics(scored, 'overallScore', 'test replay fixture')
      .find((candidate) => candidate.query === 'breakout')!

    expect(entry.finalScore).toBeCloseTo(weightedScore(entry.componentScores, SCORE_WEIGHTS.overall))
    expect(entry.overallScore).toBe(entry.finalScore)
    expect(diagnostic).toMatchObject({
      source: 'test replay fixture',
      query: 'breakout',
      category: 'Technology',
      searchInterestComponent: entry.componentScores.searchInterest,
      growthComponent: entry.componentScores.growth,
      momentumComponent: entry.componentScores.momentum,
      consistencyComponent: entry.componentScores.consistency,
      breakoutComponent: entry.componentScores.breakout,
      searchInterestWeight: 0.45,
      growthWeight: 0.25,
      momentumWeight: 0.15,
      consistencyWeight: 0.1,
      breakoutWeight: 0.05,
    })
    expect(diagnostic.finalScore).toBeCloseTo(entry.finalScore)
    expect(diagnostic.finalWeightedContribution).toBeCloseTo(entry.finalScore)
    expect(
      diagnostic.searchInterestWeightedContribution
      + diagnostic.growthWeightedContribution
      + diagnostic.momentumWeightedContribution
      + diagnostic.consistencyWeightedContribution
      + diagnostic.breakoutWeightedContribution,
    ).toBeCloseTo(entry.finalScore)
  })

  it('rewards sustained interest over a spike', () => {
    expect(consistencySignal(Array(30).fill(100))).toBeGreaterThan(consistencySignal([...Array(29).fill(20), 1000]))
  })

  it('passes only the selected trailing range into scoring and retains 30D as the ranking default', () => {
    const data = [
      topic('falling', [...Array(23).fill(100), ...Array(7).fill(10)]),
      topic('rising', [...Array(23).fill(10), ...Array(7).fill(100)]),
    ]
    const sevenDayData = selectTopicDataForWindow(data, '7D')
    const thirtyDayData = selectTopicDataForWindow(data, '30D')

    expect(sevenDayData.map((candidate) => candidate.observations)).toEqual(data.map((candidate) => candidate.observations.slice(-7)))
    expect(thirtyDayData.map((candidate) => candidate.observations)).toEqual(data.map((candidate) => candidate.observations))
    const sevenDayRanking = rankEntries(data, 'overallScore', '7D')
    const thirtyDayRanking = rankEntries(data, 'overallScore', '30D')
    expect(sevenDayRanking).toEqual(rankEntries(sevenDayData))
    expect(thirtyDayRanking).toEqual(rankEntries(thirtyDayData))
    expect(sevenDayRanking.map((entry) => entry.finalScore)).not.toEqual(thirtyDayRanking.map((entry) => entry.finalScore))
    expect(rankEntries(data)).toEqual(rankEntries(data, 'overallScore', '30D'))
  })

  it('uses a distinct full-year history for 1Y scoring while keeping shorter ranges independent', () => {
    const history = Array.from({ length: 365 }, (_, day) => 20 + (day % 9))
    const data = [
      topic('historically-stable', [...history.slice(0, -30), ...Array(30).fill(70)]),
      topic('historically-volatile', [...history.map((value, day) => value + (day % 2 ? 35 : 0)).slice(0, -30), ...Array(30).fill(70)]),
    ]

    expect(selectTopicDataForWindow(data, '24H')[0].observations).toHaveLength(1)
    expect(selectTopicDataForWindow(data, '7D')[0].observations).toHaveLength(7)
    expect(selectTopicDataForWindow(data, '30D')[0].observations).toHaveLength(30)
    expect(selectTopicDataForWindow(data, '1Y')[0].observations).toHaveLength(365)
    expect(rankEntries(data, 'overallScore', '1Y').map((entry) => entry.finalScore))
      .not.toEqual(rankEntries(data, 'overallScore', '30D').map((entry) => entry.finalScore))
  })

  it('ranks 100 candidates using full precision', () => {
    const data = Array.from({ length: 105 }, (_, index) => topic(`Topic ${String(105 - index).padStart(3, '0')}`, Array.from({ length: 30 }, () => 100 + index)))
    const ranked = rankEntries(data)
    expect(ranked).toHaveLength(100)
    expect(ranked[0].rank).toBe(1)
    expect(ranked[0].overallScore).toBeGreaterThan(ranked[1].overallScore)
  })

  it('calculates movement and identifies new entrants', () => {
    const current = [{ ...rankEntries([topic('one', Array(30).fill(400))])[0], rank: 2 }, { ...rankEntries([topic('two', Array(30).fill(200))])[0], rank: 3 }]
    const moved = calculateMovement(current, {
      date: 'yesterday',
      snapshotAt: '2026-08-24T00:00:00.000Z',
      scoringMode: 'overallScore',
      selectedWindow: '30D',
      entries: [{ ...current[0], rank: 7, movement: null }],
    })
    expect(moved[0].movement).toBe(5)
    expect(moved[1].movement).toBe('NEW')
  })
})
