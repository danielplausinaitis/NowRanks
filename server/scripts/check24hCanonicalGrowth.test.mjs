import { describe, expect, it } from 'vitest'
import { build24hCanonicalGrowthDiagnostics } from './check24hCanonicalGrowth.mjs'

const entry = {
  candidateId: 'live:topic', title: 'Topic', publicRank: 1, growthPercent: 1_000, growthSource: 'discovery-increase', growthSaturated: true,
  componentAvailability: { presentation: { growthDiagnostics: { promotion: { eligible: false, confidence: 'unavailable', promotionOutcome: 'fallback', reason: 'unavailable-history' } } } },
}

describe('24H canonical Growth diagnostic', () => {
  it('reports a zero-mapped provider curve as missing without claiming a usable zero', () => {
    const report = build24hCanonicalGrowthDiagnostics({
      result: { snapshot: { selectedWindow: '24H' }, entries: [entry] },
      artifacts: [{ artifact_id: 'artifact', candidate_id: 'live:topic', request_window: 'past_day', raw_curve: Array.from({ length: 24 }, () => ({ availability: 'missing', value: null, missingReason: 'out-of-range' })) }],
      alignments: [{ source_artifact_id: 'artifact', accepted: false, reason: 'no-valid-provider-points', segment_id: 'segment' }],
      canonicalPoints: [], coverageByCandidate: new Map([['live:topic', { status: 'unavailable', reason: 'no-growth-eligible-measurements' }]]),
    })[0]
    expect(report).toMatchObject({ providerHistoryRequested: 'past_day', providerHistoryReturned: true, providerCurvePointCount: 24, providerValidPointCount: 0, providerMissingPointCount: 24, providerZeroPointCount: 0, providerZeroMappedToMissingCount: 24, canonicalAlignmentAccepted: false, canonicalAlignmentReason: 'no-valid-provider-points', canonicalFresh: false, canonicalGrowthAvailable: false, promotionRejectionReason: 'unavailable-history', publicGrowthValue: 1_000, publicGrowthSaturated: true })
  })

  it('preserves exact canonical Growth and current-segment coverage when available', () => {
    const coverage = { status: 'available', reason: null, growthPercent: -43.8, canonicalSegment: 'segment', latestPointAt: '2026-09-13T08:00:00.000Z', recent: { actual: 12, expected: 12, values: Array(12).fill(56.2) }, previous: { actual: 12, expected: 12, values: Array(12).fill(100) } }
    const report = build24hCanonicalGrowthDiagnostics({
      result: { snapshot: { selectedWindow: '24H' }, entries: [{ ...entry, growthPercent: -43.8, growthSource: 'nowranks-history', growthSaturated: false }] },
      artifacts: [{ artifact_id: 'artifact', candidate_id: 'live:topic', request_window: 'past_day', raw_curve: [{ availability: 'available', value: 25 }] }],
      alignments: [{ source_artifact_id: 'artifact', accepted: true, reason: null, segment_id: 'segment' }],
      canonicalPoints: [{ candidate_id: 'live:topic', segment_id: 'segment', source_artifact_id: 'artifact', observed_at: '2026-09-13T08:00:00.000Z' }], coverageByCandidate: new Map([['live:topic', coverage]]),
    })[0]
    expect(report).toMatchObject({ canonicalAlignmentAccepted: true, canonicalNewPointCount: 1, canonicalPointCountCurrentSegment: 1, canonicalFresh: true, canonicalGrowthAvailable: true, canonicalGrowthValue: -43.8, growthRecentSlots: { actual: 12, expected: 12 }, growthPreviousSlots: { actual: 12, expected: 12 }, publicGrowthSource: 'nowranks-history', publicGrowthSaturated: false })
  })
})
