import { describe, expect, it, vi } from 'vitest'
import { buildActiveTrackingCohort } from './activeTrackingCohort.mjs'

const tracked = (name, patch = {}) => ({ candidateId: `live:${name}`, query: name, normalizedQuery: name, category: 'News', lastPaidAt: '2026-09-08T12:00:00.000Z', lastCanonicalSuccessAt: '2026-09-08T12:00:00.000Z', recentAcceptedAlignmentConfidence: 'high', canonicalPointCount: 24, consecutiveMissingHistory: 0, ...patch })
const fresh = (name) => ({ query: name, normalizedQuery: name, category: 'News', searchVolume: 100, retrievedAt: '2026-09-08T16:00:00.000Z' })

describe('active tracking cohort', () => {
  it('retains a canonically tracked topic absent from discovery while preserving fresh capacity', () => {
    const result = buildActiveTrackingCohort({ discoveries: [fresh('new')], tracking: [tracked('death')], maxPaidCandidates: 2, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates.map((item) => item.normalizedQuery)).toEqual(expect.arrayContaining(['death', 'new']))
    expect(result.diagnostics).toMatchObject({ canonicalContinuity: 1, freshDiscoveries: 1, deduplicatedTotal: 2 })
  })
  it('retains recent Top20 entries, keeps a fresh discovery, and never exceeds the cap', () => {
    const result = buildActiveTrackingCohort({ discoveries: Array.from({ length: 60 }, (_, i) => fresh(`fresh-${i}`)), latestPublic: [tracked('pink', { publicRank: 1 })], tracking: [tracked('pink', { publicRank: 1 }), ...Array.from({ length: 30 }, (_, i) => tracked(`old-${i}`))], maxPaidCandidates: 50, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates).toHaveLength(50)
    expect(result.candidates.map((item) => item.normalizedQuery)).toContain('pink')
    expect(result.candidates.map((item) => item.normalizedQuery)).toContain('fresh-0')
  })
  it('backs repeated missing history off without immediately retiring an important topic', () => {
    const now = '2026-09-08T16:00:00.000Z'
    const missing = tracked('missing', { consecutiveMissingHistory: 3, lastPaidAt: '2026-09-08T12:00:00.000Z', lastCanonicalSuccessAt: null })
    expect(buildActiveTrackingCohort({ tracking: [missing], maxPaidCandidates: 5, now }).candidates).toHaveLength(0)
    expect(buildActiveTrackingCohort({ tracking: [missing], latestPublic: [{ ...missing, publicRank: 1 }], maxPaidCandidates: 5, now }).candidates.map((item) => item.normalizedQuery)).toContain('missing')
  })
  it('protects every prior public Top20 before all non-public allocation classes', () => {
    const top20 = Array.from({ length: 20 }, (_, index) => tracked(`top-${index}`, { publicRank: index + 1, consecutiveMissingHistory: 3, lastPaidAt: '2026-09-08T15:00:00.000Z' }))
    const result = buildActiveTrackingCohort({ latestPublic: top20, tracking: [...top20, ...Array.from({ length: 50 }, (_, index) => tracked(`other-${index}`))], maxPaidCandidates: 50, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates.map((item) => item.normalizedQuery)).toEqual(expect.arrayContaining(top20.map((item) => item.normalizedQuery)))
    expect(result.diagnostics.previousTop20).toBe(20)
  })
  it('selects mature canonical continuity before generic grace retention', () => {
    const mature = tracked('death', { canonicalPointCount: 48, recentAcceptedAlignmentConfidence: 'high', lastPaidAt: '2026-09-06T12:00:00.000Z', lastCanonicalSuccessAt: '2026-09-06T12:00:00.000Z' })
    const grace = tracked('generic-grace', { lastCanonicalSuccessAt: null, canonicalPointCount: 0, lastPaidAt: '2026-09-08T12:00:00.000Z' })
    const result = buildActiveTrackingCohort({ tracking: [grace, mature], maxPaidCandidates: 1, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates.map((item) => item.normalizedQuery)).toEqual(['death'])
    expect(result.diagnostics.selected).toEqual([expect.objectContaining({ query: 'death', reason: 'canonicalContinuity', canonicalPointCount: 48 })])
    expect(result.diagnostics.exclusions).toEqual([expect.objectContaining({ query: 'generic-grace', reason: 'lower-priority-capacity' })])
  })
  it('guarantees fresh discoveries a path into an otherwise full 50-slot cohort', () => {
    const top20 = Array.from({ length: 20 }, (_, index) => tracked(`top-${index}`, { publicRank: index + 1 }))
    const continuity = Array.from({ length: 20 }, (_, index) => tracked(`canonical-${index}`, { lastPaidAt: '2026-09-08T12:00:00.000Z' }))
    const retries = Array.from({ length: 5 }, (_, index) => tracked(`retry-${index}`, { lastCanonicalSuccessAt: null, canonicalPointCount: 0, consecutiveMissingHistory: 1, lastPaidAt: '2026-09-08T12:00:00.000Z' }))
    const discoveries = Array.from({ length: 30 }, (_, index) => fresh(`fresh-${index}`))
    const result = buildActiveTrackingCohort({ latestPublic: top20, tracking: [...top20, ...continuity, ...retries], discoveries, maxPaidCandidates: 50, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates).toHaveLength(50)
    expect(result.diagnostics.freshDiscoveries).toBeGreaterThanOrEqual(10)
    expect(result.candidates.map((item) => item.normalizedQuery)).toEqual(expect.arrayContaining(discoveries.slice(0, 10).map((item) => item.normalizedQuery)))
  })
  it('eventually releases stale/dead canonical history while permanently retaining no data is implied', () => {
    const stale = tracked('old-history', { lastPaidAt: '2026-08-31T12:00:00.000Z', lastCanonicalSuccessAt: '2026-08-31T12:00:00.000Z' })
    const result = buildActiveTrackingCohort({ tracking: [stale], maxPaidCandidates: 5, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.exclusions).toEqual([expect.objectContaining({ query: 'old-history', reason: 'canonical-continuity-expired' })])
  })
  it('respects generic missing-history retry backoff and never creates duplicate paid candidates', () => {
    const now = '2026-09-08T16:00:00.000Z'
    const backedOff = tracked('backed-off', { lastCanonicalSuccessAt: null, canonicalPointCount: 0, consecutiveMissingHistory: 3, lastPaidAt: '2026-09-08T12:00:00.000Z' })
    const duplicate = tracked('duplicate')
    const provider = { fetch: vi.fn() }
    const result = buildActiveTrackingCohort({ discoveries: [fresh('duplicate'), fresh('duplicate')], tracking: [backedOff, duplicate], maxPaidCandidates: 50, now })
    expect(result.candidates.map((item) => item.normalizedQuery)).not.toContain('backed-off')
    expect(result.diagnostics.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ query: 'backed-off', reason: 'missing-retry-backoff' })]))
    expect(result.candidates.filter((item) => item.normalizedQuery === 'duplicate')).toHaveLength(1)
    expect(result.candidates).toHaveLength(result.diagnostics.deduplicatedTotal)
    expect(provider.fetch).not.toHaveBeenCalled()
  })
  it('enforces the 50-slot hard ceiling even when called outside scheduler configuration', () => {
    expect(() => buildActiveTrackingCohort({ maxPaidCandidates: 51 })).toThrow(/between 1 and 50/)
  })
})
