import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCORE_WEIGHTS } from '../../src/domain/config.ts'
import { breakoutSignal, consistencySignal, growthSignal, momentumSignal, normalize } from '../../src/domain/scoring.ts'
import { scoreElapsedTimeShadowLiveCohort } from './shadowScoring.mjs'
import { UNIFIED_PUBLIC_PROFILES, UNIFIED_PUBLIC_SCORE, boundedDiscoveryAcceleration, nowScoreFromUnifiedRaw } from './unifiedPublicScoring.mjs'
import { serializeUnifiedScoreDiagnostic } from './unifiedScoreDiagnostics.mjs'
import { buildUnifiedScoreAuditReport } from '../scripts/checkUnifiedScores.mjs'

const signalEngine = { normalize, growthSignal, momentumSignal, consistencySignal, breakoutSignal }
const timestamp = '2026-09-13T12:00:00.000Z'
function candidate(topic, category, current, baseline, acceleration = 1000) {
  const normalizedQuery = topic.toLowerCase()
  return {
    topic, normalizedQuery, category,
    currentTrendIntensity: { providerId: 'serpapi', searchVolume: current, increasePercentage: acceleration, startedAt: '2026-09-13T08:00:00.000Z', retrievedAt: timestamp },
    baselineDemand: baseline === null ? { providerId: 'dataforseo', availability: 'missing', searchVolume: null } : { providerId: 'dataforseo', availability: 'available', searchVolume: baseline },
    historicalTrendShape: { providerId: 'dataforseo-trends', provenance: { providerId: 'dataforseo-trends' }, observations: Array.from({ length: 24 }, (_, index) => ({ observedAt: new Date(Date.parse('2026-09-12T13:00:00.000Z') + index * 3_600_000).toISOString(), date: '2026-09-13', availability: 'available', interest: index + 1 })) },
  }
}
function score(inputs) {
  return scoreElapsedTimeShadowLiveCohort({ candidates: inputs, signalEngine, scoreWeights: SCORE_WEIGHTS, historyWindow: '24H' })
}

describe('unified score diagnostics', () => {
  it('reconstructs the exact production unified score and public transform without category input', () => {
    const sports = candidate('Sports', 'Sports', 100_000, 1_000, 1000)
    const technology = candidate('Technology', 'Technology', 10_000, 50_000, 200)
    const scores = score([sports, technology])
    const diagnostic = serializeUnifiedScoreDiagnostic({ entry: scores.find((entry) => entry.topic === 'Sports'), window: '24H', wouldBeRank: 1 })
    const componentTotal = Object.values(diagnostic.components).reduce((sum, component) => sum + (component.contribution ?? 0), 0)
    expect(componentTotal).toBeCloseTo(diagnostic.unifiedRawScore)
    expect(diagnostic.publicScore).toBe(nowScoreFromUnifiedRaw(diagnostic.unifiedRawScore))
    expect(UNIFIED_PUBLIC_PROFILES['24H'].weights).toEqual({ currentAttention: .45, baselineDemand: .05, acceleration: .28, momentum: .08, consistency: .02, breakout: .02, recency: .10 })
    // The same non-category inputs score identically regardless of label.
    const relabeled = score([{ ...sports, category: 'Technology' }])[0]
    const original = score([sports])[0]
    expect(relabeled.unifiedRawScore).toBeCloseTo(original.unifiedRawScore)
  })

  it('reports saturated acceleration and the current missing-signal renormalization exactly', () => {
    expect(boundedDiscoveryAcceleration(1000)).toBe(500)
    const saturated = score([candidate('Sports', 'Sports', 100, 100, 1000)])[0]
    const missingBaseline = score([candidate('Technology', 'Technology', 100, null, 1000)])[0]
    const diagnostic = serializeUnifiedScoreDiagnostic({ entry: saturated, window: '24H' })
    expect(diagnostic.accelerationProviderRaw).toBe(1000)
    expect(diagnostic.components.acceleration.normalizedValue).toBe(50)
    expect(diagnostic.components.acceleration.reason).toBeNull()
    // Baseline is optional in unified scoring: its weight leaves the denominator,
    // rather than becoming a fabricated zero.
    expect(missingBaseline.unifiedAvailableWeight).toBeLessThan(1)
    expect(missingBaseline.unifiedComponents.baselineDemand).toBeNull()
    expect(nowScoreFromUnifiedRaw(100)).toBe(UNIFIED_PUBLIC_SCORE.ceiling)
  })

  it('keeps deterministic score ordering, actual public ranks, and no category rerank in the report', () => {
    const entries = score([
      candidate('Zulu', 'Sports', 100_000, 1_000),
      candidate('Alpha', 'Technology', 10_000, 100_000),
      candidate('Beta', 'Entertainment', 20_000, 20_000),
    ])
    const ordered = [...entries].filter((entry) => Number.isFinite(entry.unifiedRawScore)).sort((left, right) => right.unifiedRawScore - left.unifiedRawScore || left.topic.localeCompare(right.topic))
    const report = buildUnifiedScoreAuditReport({
      snapshot: { cycle_id: 'audit', selected_window: '24H', scored_at: timestamp, snapshot_format_version: 2 },
      entries: ordered.slice(0, 2).map((entry, index) => ({ candidate_id: `live:${entry.normalizedQuery}`, public_rank: index + 1, public_score: entry.nowScore })),
      scores: entries,
    })
    expect(report.counts).toMatchObject({ reconstructedScorable: 3, persistedPublic: 2, matchedPublicRanks: 2 })
    expect(report.ranking.map((row) => row.candidate)).toEqual(ordered.map((entry) => entry.topic))
    expect(serializeUnifiedScoreDiagnostic({ entry: ordered[2], window: '24H', wouldBeRank: 21 }).exclusionReason).toBe('outside-public-top-20')
    expect(report.categoryStatistics.Sports.top20N + report.categoryStatistics.Technology.top20N + report.categoryStatistics.Entertainment.top20N).toBe(2)
    expect(report.accelerationSaturation).toMatchObject({ sports: 1, nonSports: 2, total: 3, scorerCap: 500 })
  })

  it('keeps the database diagnostic select-only and isolated from provider clients and writers', () => {
    const source = readFileSync('server/scripts/checkUnifiedScores.mjs', 'utf8')
    expect(source).not.toMatch(/createSerpApi|createDataForSeo|fetch\(|\.insert\(|\.update\(|\.upsert\(|executeLivePersistence|collectLive/i)
    expect(source).toMatch(/\.select\(/)
  })
})
