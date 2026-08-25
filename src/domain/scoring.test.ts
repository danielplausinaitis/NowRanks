import { describe, expect, it } from 'vitest'
import { calculateMovement, rankEntries } from './leaderboard'
import { consistencySignal, growthSignal, momentumSignal, normalize, weightedScore } from './scoring'
import type { ComponentScores, SearchTopicData } from './types'

const series = (values: number[]) => values.map((interest, index) => ({ date: `2026-08-${index + 1}`, interest }))
const topic = (id: string, values: number[]): SearchTopicData => ({ id, topic: id, category: 'Technology', observations: series(values) })

describe('scoring engine', () => {
  it('calculates configured overall and trending weights', () => {
    const scores: ComponentScores = { searchInterest: 80, growth: 60, momentum: 40, consistency: 20 }
    expect(weightedScore(scores, { searchInterest: .45, growth: .25, momentum: .2, consistency: .1 })).toBe(61)
    expect(weightedScore(scores, { searchInterest: .1, growth: .45, momentum: .35, consistency: .1 })).toBe(51)
  })
  it('normalizes scores on a 0–100 scale', () => { expect(normalize([2, 6, 10])).toEqual([0, 50, 100]) })
  it('dampens growth and detects accelerating momentum', () => {
    expect(growthSignal([10,10,10,10,10,10,10, 20,20,20,20,20,20,20])).toBeGreaterThan(0)
    const steady = momentumSignal([10,11,12,13,14,15,16,17,18,19,20,21,22,23])
    const accelerating = momentumSignal([10,10,10,10,10,10,10,11,12,14,17,21,26,32])
    expect(accelerating).toBeGreaterThan(steady)
  })
  it('rewards sustained interest over a spike', () => { expect(consistencySignal(Array(30).fill(100))).toBeGreaterThan(consistencySignal([...Array(29).fill(20), 1000])) })
  it('ranks 100 candidates using full precision', () => {
    const data = Array.from({ length: 105 }, (_, index) => topic(`Topic ${String(105 - index).padStart(3, '0')}`, Array.from({ length: 30 }, () => 100 + index)))
    const ranked = rankEntries(data)
    expect(ranked).toHaveLength(100)
    expect(ranked[0].rank).toBe(1)
    expect(ranked[0].overallScore).toBeGreaterThan(ranked[1].overallScore)
  })
  it('calculates movement and identifies new entrants', () => {
    const current = [{ ...rankEntries([topic('one', Array(30).fill(400))])[0], rank: 2 }, { ...rankEntries([topic('two', Array(30).fill(200))])[0], rank: 3 }]
    const moved = calculateMovement(current, { date: 'yesterday', entries: [{ ...current[0], rank: 7, movement: null }] })
    expect(moved[0].movement).toBe(5)
    expect(moved[1].movement).toBe('NEW')
  })
})
