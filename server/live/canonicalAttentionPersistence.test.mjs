import { describe, expect, it } from 'vitest'
import { buildCanonicalAttentionPersistencePlan } from './canonicalAttentionPersistence.mjs'
import { readHistoricalVaultCoverage } from './historicalVaultReadService.mjs'

const scope = { kind: 'country', countryCode: 'US' }
const candidateIdByQuery = new Map([['pink', 'live:pink'], ['pink singer', 'live:pink-singer']])

function history(normalizedQuery, values, query = normalizedQuery) {
  return {
    topic: query, normalizedQuery, retrievedAt: '2026-09-02T12:03:00.000Z', historyRequest: { timeRange: 'past_day' },
    provenance: { providerId: 'dataforseo-trends', geographicScope: scope, sourceVersion: 'dataforseo-trends-v3', collectionMethod: 'dataforseo-trends-explore-live' },
    observations: values.map(([observedAt, interest]) => ({ observedAt, date: observedAt.slice(0, 10), availability: interest === null ? 'missing' : 'available', interest, ...(interest === null ? { missingReason: 'out-of-range' } : {}) })),
  }
}

const first = history('pink', [
  ['2026-09-02T00:00:00.000Z', 10], ['2026-09-02T04:00:00.000Z', 20], ['2026-09-02T08:00:00.000Z', 40], ['2026-09-02T12:00:00.000Z', 80],
])

describe('canonical attention persistence plan', () => {
  it('persists an auditable past_day artifact and bootstraps immutable points', () => {
    const plan = buildCanonicalAttentionPersistencePlan({ histories: [first], candidateIdByQuery, runId: 'run-1', scoredAt: '2026-09-02T12:03:00.000Z' })
    expect(plan.artifacts).toHaveLength(1)
    expect(plan.artifacts[0]).toMatchObject({ request_window: 'past_day', slot_at: '2026-09-02T12:00:00.000Z', provider_query: 'pink' })
    expect(plan.alignments[0]).toMatchObject({ accepted: true, reason: 'bootstrap', confidence: 'high', usable_overlap_count: 0 })
    expect(plan.points.map((point) => point.canonical_attention)).toEqual([10, 20, 40, 80])
  })

  it('directly aligns only new points and never rewrites canonical overlap', () => {
    const bootstrap = buildCanonicalAttentionPersistencePlan({ histories: [first], candidateIdByQuery, runId: 'run-1', scoredAt: '2026-09-02T12:00:00.000Z' })
    const existing = new Map([['pink', bootstrap.points]])
    const second = history('pink', [
      ['2026-09-02T00:00:00.000Z', 5], ['2026-09-02T04:00:00.000Z', 10], ['2026-09-02T08:00:00.000Z', 20], ['2026-09-02T12:00:00.000Z', 40], ['2026-09-02T16:00:00.000Z', 70],
    ])
    const plan = buildCanonicalAttentionPersistencePlan({ histories: [second], candidateIdByQuery, existingByQuery: existing, runId: 'run-2', scoredAt: '2026-09-02T16:00:00.000Z' })
    expect(plan.alignments[0]).toMatchObject({ accepted: true, scale_factor: 2, usable_overlap_count: 3 })
    expect(plan.points).toEqual([expect.objectContaining({ observed_at: '2026-09-02T16:00:00.000Z', canonical_attention: 140 })])
  })

  it('retains a rejected diagnostic without points and isolates an incompatible query identity', () => {
    const bootstrap = buildCanonicalAttentionPersistencePlan({ histories: [first], candidateIdByQuery, runId: 'run-1', scoredAt: '2026-09-02T12:00:00.000Z' })
    const bad = history('pink', [
      ['2026-09-02T00:00:00.000Z', 30], ['2026-09-02T04:00:00.000Z', 20], ['2026-09-02T08:00:00.000Z', 14], ['2026-09-02T12:00:00.000Z', 70],
    ])
    const changedQuery = history('pink singer', [['2026-09-02T12:00:00.000Z', 10]], 'pink singer')
    const plan = buildCanonicalAttentionPersistencePlan({ histories: [bad, changedQuery], candidateIdByQuery, existingByQuery: new Map([['pink', bootstrap.points], ['pink singer', bootstrap.points]]), runId: 'run-2', scoredAt: '2026-09-02T12:00:00.000Z' })
    expect(plan.alignments.find((row) => row.candidate_id === 'live:pink')).toMatchObject({ accepted: false, confidence: 'rejected' })
    expect(plan.points.filter((point) => point.candidate_id === 'live:pink')).toHaveLength(0)
    expect(plan.alignments.find((row) => row.candidate_id === 'live:pink-singer')).toMatchObject({ accepted: true, reason: 'bootstrap' })
  })

  it('is deterministic for a retry of the same logical cycle', () => {
    const args = { histories: [first], candidateIdByQuery, runId: 'run-1', scoredAt: '2026-09-02T12:03:00.000Z' }
    expect(buildCanonicalAttentionPersistencePlan(args)).toEqual(buildCanonicalAttentionPersistencePlan(args))
  })

  it('records an all-missing provider curve as unavailable, then bootstraps when a later cycle is usable', () => {
    const missing = history('pink', Array.from({ length: 24 }, (_, hour) => [`2026-09-02T${String(hour).padStart(2, '0')}:00:00.000Z`, null]))
    const unavailable = buildCanonicalAttentionPersistencePlan({ histories: [missing], candidateIdByQuery, runId: 'run-missing', scoredAt: '2026-09-02T20:00:00.000Z' })
    expect(unavailable.artifacts[0].raw_curve).toHaveLength(24)
    expect(unavailable.artifacts[0].raw_curve.every((point) => point.value === null && point.availability === 'missing')).toBe(true)
    expect(unavailable.alignments[0]).toMatchObject({ accepted: false, reason: 'no-valid-provider-points', confidence: 'rejected' })
    expect(unavailable.points).toHaveLength(0)
    expect(unavailable.diagnostics.rejectionReasons).toEqual({ 'no-valid-provider-points': 1 })

    const laterUsable = history('pink', [['2026-09-03T00:00:00.000Z', 15], ['2026-09-03T01:00:00.000Z', 20]])
    const recovered = buildCanonicalAttentionPersistencePlan({ histories: [laterUsable], candidateIdByQuery, existingByQuery: new Map([['pink', unavailable.points]]), runId: 'run-usable', scoredAt: '2026-09-03T01:00:00.000Z' })
    expect(recovered.alignments[0]).toMatchObject({ accepted: true, reason: 'bootstrap' })
    expect(recovered.points.map((point) => point.canonical_attention)).toEqual([15, 20])
  })

  it('keeps hourly points and appends only the four new hours from a later overlapping curve', () => {
    const hour = (offset) => new Date(Date.parse('2026-09-02T00:00:00.000Z') + offset * 3_600_000).toISOString()
    const initial = history('pink', Array.from({ length: 24 }, (_, index) => [hour(index), 20 + index]))
    const bootstrap = buildCanonicalAttentionPersistencePlan({ histories: [initial], candidateIdByQuery, runId: 'hourly-1', scoredAt: hour(23) })
    const later = history('pink', Array.from({ length: 24 }, (_, index) => [hour(index + 4), 10 + index / 2]))
    const aligned = buildCanonicalAttentionPersistencePlan({ histories: [later], candidateIdByQuery, existingByQuery: new Map([['pink', bootstrap.points]]), runId: 'hourly-2', scoredAt: hour(27) })
    expect(bootstrap.points).toHaveLength(24)
    expect(aligned.alignments[0]).toMatchObject({ accepted: true, usable_overlap_count: 20 })
    expect(aligned.points).toHaveLength(4)
    expect(aligned.points.map((point) => point.observed_at)).toEqual([hour(24), hour(25), hour(26), hour(27)])
  })

  it('keeps a rejected weak cycle point-free, then resumes the same immutable segment on a trustworthy overlap', () => {
    const hour = (offset) => new Date(Date.parse('2026-09-02T00:00:00.000Z') + offset * 3_600_000).toISOString()
    const initial = history('pink', Array.from({ length: 24 }, (_, index) => [hour(index), 20]))
    const bootstrap = buildCanonicalAttentionPersistencePlan({ histories: [initial], candidateIdByQuery, runId: 'weak-1', scoredAt: hour(23) })
    const original = structuredClone(bootstrap.points)
    const weak = history('pink', Array.from({ length: 24 }, (_, index) => [hour(index + 4), 9]))
    const rejected = buildCanonicalAttentionPersistencePlan({ histories: [weak], candidateIdByQuery, existingByQuery: new Map([['pink', bootstrap.points]]), runId: 'weak-2', scoredAt: hour(27) })
    expect(rejected.alignments[0]).toMatchObject({ accepted: false, reason: 'weak-signal', total_timestamp_overlap: 20, strong_usable_overlap_count: 0, can_resume_existing_segment: false, resume_reason: 'timestamp-overlap-not-yet-trustworthy', new_segment_required: false, gap_since_last_canonical_point_ms: 4 * 3_600_000 })
    expect(rejected.points).toEqual([])
    expect(bootstrap.points).toEqual(original)

    const recovered = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index + 4), 10]))], candidateIdByQuery, existingByQuery: new Map([['pink', [...bootstrap.points, ...rejected.points]]]), runId: 'weak-3', scoredAt: hour(27) })
    expect(recovered.alignments[0]).toMatchObject({ accepted: true, scale_factor: 2, can_resume_existing_segment: true, resume_reason: 'accepted-trustworthy-timestamp-overlap', new_segment_required: false, segment_id: bootstrap.points[0].segment_id })
    expect(recovered.points.map((point) => point.observed_at)).toEqual([hour(24), hour(25), hour(26), hour(27)])
    expect(recovered.points.every((point) => point.canonical_attention === 20)).toBe(true)
  })

  it('retries several missing overlapping cycles and resumes only when a later curve meets the unchanged alignment rule', () => {
    const hour = (offset) => new Date(Date.parse('2026-09-02T00:00:00.000Z') + offset * 3_600_000).toISOString()
    const bootstrap = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index), 20]))], candidateIdByQuery, runId: 'missing-1', scoredAt: hour(23) })
    const existing = new Map([['pink', bootstrap.points]])
    for (const run of ['missing-2', 'missing-3', 'missing-4']) {
      const rejected = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index + 4), null]))], candidateIdByQuery, existingByQuery: existing, runId: run, scoredAt: hour(27) })
      expect(rejected.alignments[0]).toMatchObject({ accepted: false, reason: 'no-valid-provider-points', total_timestamp_overlap: 20, available_overlap_count: 0, missing_overlap_rejected: 20, can_resume_existing_segment: false, new_segment_required: false })
      expect(rejected.points).toEqual([])
    }
    const resumed = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index + 4), 10]))], candidateIdByQuery, existingByQuery: existing, runId: 'missing-5', scoredAt: hour(27) })
    expect(resumed.alignments[0]).toMatchObject({ accepted: true, can_resume_existing_segment: true, segment_id: bootstrap.points[0].segment_id })
    expect(resumed.points).toHaveLength(4)
  })

  it('starts a separate regime after a usable curve has no direct canonical timestamp overlap', () => {
    const hour = (offset) => new Date(Date.parse('2026-09-02T00:00:00.000Z') + offset * 3_600_000).toISOString()
    const bootstrap = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index), 20]))], candidateIdByQuery, runId: 'gap-1', scoredAt: hour(23) })
    const original = structuredClone(bootstrap.points)
    const newRegime = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index + 48), 15]))], candidateIdByQuery, existingByQuery: new Map([['pink', bootstrap.points]]), runId: 'gap-2', scoredAt: hour(71) })
    expect(newRegime.alignments[0]).toMatchObject({ accepted: true, reason: 'bootstrap', total_timestamp_overlap: 0, can_resume_existing_segment: false, resume_reason: 'no-timestamp-overlap-new-segment', new_segment_required: true, gap_since_last_canonical_point_ms: 48 * 3_600_000 })
    expect(newRegime.points).toHaveLength(24)
    expect(newRegime.points.every((point) => point.segment_id !== bootstrap.points[0].segment_id)).toBe(true)
    expect(bootstrap.points).toEqual(original)
  })

  it('makes stale canonical 24H Growth available again after a successful resumed alignment', async () => {
    const hour = (offset) => new Date(Date.parse('2026-09-02T00:00:00.000Z') + offset * 3_600_000).toISOString()
    const bootstrap = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index), 20]))], candidateIdByQuery, runId: 'growth-1', scoredAt: hour(23) })
    const repository = { listLiveCanonicalAttentionPoints: async () => bootstrap.points }
    const stale = await readHistoricalVaultCoverage({ repository, candidateIds: ['live:pink'], window: '24H', asOf: hour(29), slotMinutes: 240 })
    expect(stale.get('live:pink')).toMatchObject({ status: 'unavailable', reason: 'stale-canonical-history' })

    const resumed = buildCanonicalAttentionPersistencePlan({ histories: [history('pink', Array.from({ length: 24 }, (_, index) => [hour(index + 4), 10]))], candidateIdByQuery, existingByQuery: new Map([['pink', bootstrap.points]]), runId: 'growth-2', scoredAt: hour(27) })
    repository.listLiveCanonicalAttentionPoints = async () => [...bootstrap.points, ...resumed.points]
    const recovered = await readHistoricalVaultCoverage({ repository, candidateIds: ['live:pink'], window: '24H', asOf: hour(29), slotMinutes: 240 })
    expect(recovered.get('live:pink')).toMatchObject({ status: 'available', growthSource: 'nowranks-history', latestPointAt: hour(27) })
  })
})
