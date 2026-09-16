import { describe, expect, it, vi } from 'vitest'
import { buildActiveTrackingCohort } from './activeTrackingCohort.mjs'

const tracked = (name, patch = {}) => ({ candidateId: `live:${name}`, query: name, normalizedQuery: name, category: 'News', lastPaidAt: '2026-09-08T12:00:00.000Z', lastCanonicalSuccessAt: '2026-09-08T12:00:00.000Z', recentAcceptedAlignmentConfidence: 'high', canonicalPointCount: 24, consecutiveMissingHistory: 0, ...patch })
const fresh = (name) => ({ query: name, normalizedQuery: name, category: 'News', searchVolume: 100, retrievedAt: '2026-09-08T16:00:00.000Z' })
const usMeasurement = { measurementMode: 'us', measurementTarget: 'us:united-states', measurementLocation: 'United States' }
const globalMeasurement = { measurementMode: 'global', measurementTarget: 'global:worldwide', measurementLocation: null }
const trackedFor = (name, target, patch = {}) => tracked(name, { historicalMeasurementMode: target.measurementMode, historicalMeasurementTarget: target.measurementTarget, historicalMeasurementLocation: target.measurementLocation, ...patch })

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
  it('reserves enough current discoveries to fill the public 20-row contract in an otherwise full 50-slot cohort', () => {
    const top20 = Array.from({ length: 20 }, (_, index) => tracked(`top-${index}`, { publicRank: index + 1 }))
    const continuity = Array.from({ length: 20 }, (_, index) => tracked(`canonical-${index}`, { lastPaidAt: '2026-09-08T12:00:00.000Z' }))
    const retries = Array.from({ length: 5 }, (_, index) => tracked(`retry-${index}`, { lastCanonicalSuccessAt: null, canonicalPointCount: 0, consecutiveMissingHistory: 1, lastPaidAt: '2026-09-08T12:00:00.000Z' }))
    const discoveries = Array.from({ length: 30 }, (_, index) => fresh(`fresh-${index}`))
    const result = buildActiveTrackingCohort({ latestPublic: top20, tracking: [...top20, ...continuity, ...retries], discoveries, maxPaidCandidates: 50, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates).toHaveLength(50)
    expect(result.diagnostics.freshDiscoveries).toBeGreaterThanOrEqual(20)
    expect(result.candidates.map((item) => item.normalizedQuery)).toEqual(expect.arrayContaining(discoveries.slice(0, 20).map((item) => item.normalizedQuery)))
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

  it('retains US previous Top20 in a compatible US run', () => {
    const top = Array.from({ length: 20 }, (_, index) => trackedFor(`us-top-${index}`, usMeasurement, { publicRank: index + 1 }))
    const result = buildActiveTrackingCohort({ latestPublic: top, tracking: top, currentMeasurement: usMeasurement, maxPaidCandidates: 50, now: '2026-09-08T16:00:00.000Z' })
    expect(result.diagnostics).toMatchObject({ previousTop20: 20, previousTop20Compatible: 20, previousTop20IncompatibleRejected: 0 })
  })

  it('does not retain US Top20 or US canonical continuity in a first global cohort, filling the unchanged cap from fresh global discoveries', () => {
    const usTop = Array.from({ length: 20 }, (_, index) => trackedFor(`us-top-${index}`, usMeasurement, { publicRank: index + 1 }))
    const usContinuity = Array.from({ length: 10 }, (_, index) => trackedFor(`us-continuity-${index}`, usMeasurement))
    const globalFresh = Array.from({ length: 60 }, (_, index) => fresh(`global-fresh-${index}`))
    const result = buildActiveTrackingCohort({ discoveries: globalFresh, latestPublic: usTop, tracking: [...usTop, ...usContinuity], currentMeasurement: globalMeasurement, maxPaidCandidates: 50, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates).toHaveLength(50)
    expect(result.candidates.every((candidate) => candidate.normalizedQuery.startsWith('global-fresh-'))).toBe(true)
    expect(result.diagnostics).toMatchObject({ previousTop20: 0, previousTop20Compatible: 0, previousTop20IncompatibleRejected: 20, canonicalContinuity: 0, canonicalContinuityCompatible: 0, canonicalContinuityIncompatibleRejected: 10, freshDiscoveries: 50, deduplicatedTotal: 50, maxPaidCandidates: 50 })
    expect(result.diagnostics.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ selectionReason: 'previousTop20', measurementCompatible: false, currentMeasurementTarget: globalMeasurement.measurementTarget, accepted: false }), expect.objectContaining({ selectionReason: 'canonicalContinuity', measurementCompatible: false, currentDiscoveryPresent: false, accepted: false })]))
  })

  it('retains global previous Top20 and global canonical continuity in a compatible global run', () => {
    const top = trackedFor('global-top', globalMeasurement, { publicRank: 1 })
    const continuity = trackedFor('global-continuity', globalMeasurement)
    const result = buildActiveTrackingCohort({ discoveries: [fresh('current')], latestPublic: [top], tracking: [top, continuity], currentMeasurement: globalMeasurement, maxPaidCandidates: 3, now: '2026-09-08T16:00:00.000Z' })
    expect(result.candidates.map((candidate) => candidate.normalizedQuery)).toEqual(expect.arrayContaining(['global-top', 'global-continuity', 'current']))
    expect(result.diagnostics).toMatchObject({ previousTop20: 1, canonicalContinuity: 1, previousTop20IncompatibleRejected: 0, canonicalContinuityIncompatibleRejected: 0 })
  })

  it('rejects global canonical continuity for a US target and handles pre-metadata history as legacy US rather than global', () => {
    const global = trackedFor('global-history', globalMeasurement)
    const legacyUs = tracked('legacy-us', { historicalMeasurementMode: 'us', historicalMeasurementTarget: null, historicalMeasurementLocation: null })
    const usResult = buildActiveTrackingCohort({ tracking: [global, legacyUs], currentMeasurement: usMeasurement, maxPaidCandidates: 5, now: '2026-09-08T16:00:00.000Z' })
    expect(usResult.candidates.map((candidate) => candidate.normalizedQuery)).toContain('legacy-us')
    expect(usResult.candidates.map((candidate) => candidate.normalizedQuery)).not.toContain('global-history')
    const globalResult = buildActiveTrackingCohort({ tracking: [legacyUs], currentMeasurement: globalMeasurement, maxPaidCandidates: 5, now: '2026-09-08T16:00:00.000Z' })
    expect(globalResult.candidates).toHaveLength(0)
    expect(globalResult.diagnostics.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ query: 'legacy-us', reason: 'measurement-target-incompatible', measurementCompatibilityReason: 'legacy-us-incompatible-with-current-target' })]))
  })
})
