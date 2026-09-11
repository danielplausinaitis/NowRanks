import { describe, expect, it } from 'vitest'
import { alignCanonicalAttention } from './canonicalAttentionAlignment.mjs'
const points = (values) => values.map(([observedAt, value]) => ({ observedAt, value }))
describe('canonical attention overlap alignment', () => {
  it('bootstraps, then directly reanchors a new curve with a robust median scale', () => {
    const bootstrap = alignCanonicalAttention({ canonicalPoints: [], providerPoints: points([['a', 10], ['b', 20], ['c', 40], ['d', 80]]) })
    expect(bootstrap).toMatchObject({ accepted: true, reason: 'bootstrap', scaleFactor: 1 })
    const aligned = alignCanonicalAttention({ canonicalPoints: bootstrap.alignedNewPoints.map(({ observedAt, canonicalAttention }) => ({ observedAt, value: canonicalAttention })), providerPoints: points([['b', 10], ['c', 20], ['d', 40], ['e', 70]]) })
    expect(aligned).toMatchObject({ accepted: true, scaleFactor: 2, confidence: 'medium', usableOverlapCount: 3 })
    expect(aligned.alignedNewPoints).toEqual([expect.objectContaining({ observedAt: 'e', canonicalAttention: 140 })])
  })
  it('accepts small rounding noise but rejects weak and inconsistent overlap', () => {
    const canonical = points([['a', 40], ['b', 60], ['c', 80], ['d', 100], ['e', 120]])
    expect(alignCanonicalAttention({ canonicalPoints: canonical, providerPoints: points([['a', 20], ['b', 31], ['c', 39], ['d', 51], ['e', 59]]) }).accepted).toBe(true)
    expect(alignCanonicalAttention({ canonicalPoints: canonical, providerPoints: points([['a', 30], ['b', 20], ['c', 14], ['d', 70]]) })).toMatchObject({ accepted: false, reason: 'high-dispersion' })
    expect(alignCanonicalAttention({ canonicalPoints: points([['a', 1], ['b', 2], ['c', 1]]), providerPoints: points([['a', 1], ['b', 1], ['c', 2]]) })).toMatchObject({ accepted: false, reason: 'weak-signal' })
  })
  it('keeps timestamp-overlap diagnostics when every overlapping provider value is missing', () => {
    const missing = [['a', null], ['b', null], ['c', null]].map(([observedAt, value]) => ({ observedAt, value, availability: 'missing' }))
    expect(alignCanonicalAttention({ canonicalPoints: points([['a', 10], ['b', 20], ['c', 30]]), providerPoints: missing }))
      .toMatchObject({ accepted: false, reason: 'no-valid-provider-points', totalTimestampOverlap: 3, availableOverlap: 0, missingOverlapRejected: 3, alignedNewPoints: [] })
  })
})
