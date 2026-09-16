import { describe, expect, it } from 'vitest'
import { build7dCanonicalGrowthDiagnostics } from './check7dCanonicalGrowth.mjs'

const entry = {
  candidateId: 'live:topic', title: 'Topic', publicRank: 2, growthPercent: 1_000, growthSource: 'discovery-increase', growthSaturated: true,
  componentAvailability: { presentation: { growthDiagnostics: { promotion: { eligible: false, confidence: 'unavailable', promotionOutcome: 'fallback', reason: 'no-canonical-history' } } } },
}

describe('7D canonical Growth diagnostic', () => {
  it('reports no canonical history as unavailable without inventing hourly coverage', () => {
    const report = build7dCanonicalGrowthDiagnostics({ result: { snapshot: { selectedWindow: '7D' }, entries: [entry] }, canonicalPoints: [], coverageByCandidate: new Map([['live:topic', { status: 'unavailable', reason: 'no-canonical-history' }]]) })[0]
    expect(report).toMatchObject({ canonicalSeriesAvailable: false, canonicalSegmentId: null, canonicalPointCountCurrentSegment: 0, canonicalFresh: false, recent7dExpectedSlots: 168, recent7dValidSlots: 0, previous7dExpectedSlots: 168, previous7dValidSlots: 0, canonical7dGrowthAvailable: false, canonical7dGrowthValue: null, publicGrowthValue: 1_000, publicGrowthSaturated: true })
  })

  it('preserves exact seven-day canonical coverage, promotion, and public Growth when available', () => {
    const points = Array.from({ length: 336 }, (_, index) => ({ candidate_id: 'live:topic', segment_id: 'segment', observed_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 3_600_000).toISOString() }))
    const coverage = { status: 'available', reason: null, growthPercent: -43.8, canonicalSegment: 'segment', latestPointAt: points.at(-1).observed_at, recent: { expected: 168, actual: 126, values: Array(126).fill(56.2) }, previous: { expected: 168, actual: 126, values: Array(126).fill(100) } }
    const available = { ...entry, growthPercent: -43.8, growthSource: 'nowranks-history', growthSaturated: false, componentAvailability: { presentation: { growthDiagnostics: { promotion: { eligible: true, confidence: 'high', promotionOutcome: 'promoted-in-preferred', reason: null } } } } }
    const report = build7dCanonicalGrowthDiagnostics({ result: { snapshot: { selectedWindow: '7D' }, entries: [available] }, canonicalPoints: points, coverageByCandidate: new Map([['live:topic', coverage]]) })[0]
    expect(report).toMatchObject({ canonicalSeriesAvailable: true, canonicalSegmentId: 'segment', canonicalPointCountCurrentSegment: 336, canonicalFresh: true, recent7dExpectedSlots: 168, recent7dValidSlots: 126, previous7dExpectedSlots: 168, previous7dValidSlots: 126, recent7dCoveragePct: 75, previous7dCoveragePct: 75, canonical7dGrowthAvailable: true, canonical7dGrowthValue: -43.8, promotionEligible: true, promotionDecision: 'promoted-in-preferred', publicGrowthSource: 'nowranks-history', publicGrowthSaturated: false })
  })
})
