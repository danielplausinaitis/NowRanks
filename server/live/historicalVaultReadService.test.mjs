import { describe, expect, it, vi } from 'vitest'
import { readHistoricalVaultCoverage, readTopicHistoricalVault } from './historicalVaultReadService.mjs'

const row = { candidate_id: 'candidate', slot_at: '2026-01-02T00:00:00.000Z', value: 20, availability: 'available', provider_id: 'provider', comparability_key: 'key', comparability_status: 'comparable', quality: { growthEligible: true } }

describe('historical vault read service', () => {
  it('performs one batch range read and returns graph-safe points plus coverage diagnostics', async () => {
    const repository = { listLiveHistoricalVaultMeasurements: vi.fn(async () => [row]) }
    const coverage = await readHistoricalVaultCoverage({ repository, candidateIds: ['candidate', 'other'], window: '24H', asOf: '2026-01-02T20:00:00.000Z' })
    expect(repository.listLiveHistoricalVaultMeasurements).toHaveBeenCalledTimes(1)
    expect(coverage.get('candidate').reason).toBe('insufficient-recent-coverage')
    const topic = await readTopicHistoricalVault({ repository, candidateId: 'candidate', window: '24H', asOf: '2026-01-02T20:00:00.000Z' })
    expect(topic).toMatchObject({ candidateId: 'candidate', source: 'historical-vault', points: [{ timestamp: row.slot_at, value: 20, availability: 'available' }] })
  })

  it('uses one canonical cohort read, preserves segment metadata, and ignores non-slot graph points for Growth', async () => {
    const canonical = Array.from({ length: 24 }, (_, hour) => [
      { candidate_id: 'candidate', series_key: 'series', segment_id: 'segment', observed_at: `2026-01-02T${String(hour).padStart(2, '0')}:00:00.000Z`, canonical_attention: hour < 12 ? 10 : 20, alignment_confidence: 'high' },
      ...(hour === 0 ? [{ candidate_id: 'candidate', series_key: 'series', segment_id: 'segment', observed_at: '2026-01-02T00:30:00.000Z', canonical_attention: 999, alignment_confidence: 'high' }] : []),
    ])
      .flat()
    const repository = { listLiveCanonicalAttentionPoints: vi.fn(async () => canonical) }
    const coverage = await readHistoricalVaultCoverage({ repository, candidateIds: ['candidate'], window: '24H', asOf: '2026-01-02T23:00:00.000Z' })
    expect(repository.listLiveCanonicalAttentionPoints).toHaveBeenCalledTimes(1)
    expect(coverage.get('candidate')).toMatchObject({ status: 'available', growthPercent: 100, canonicalSegment: 'segment', recentAlignmentConfidence: 'high', crossSegmentBlended: false })
    const topic = await readTopicHistoricalVault({ repository, candidateId: 'candidate', window: '24H', asOf: '2026-01-02T23:00:00.000Z' })
    expect(topic).toMatchObject({ source: 'canonical-attention', metric: 'canonical-attention' })
    expect(topic.points).toContainEqual(expect.objectContaining({ timestamp: '2026-01-02T00:00:00.000Z', segment: 'segment', confidence: 'high' }))
  })

  it('anchors a fresh hourly canonical timeline to its latest point rather than wall-clock minutes', async () => {
    const start = Date.parse('2026-09-07T15:00:00.000Z')
    const canonical = Array.from({ length: 28 }, (_, index) => ({
      candidate_id: 'live:death', series_key: 'series', segment_id: 'segment', observed_at: new Date(start + index * 3_600_000).toISOString(),
      canonical_attention: index < 4 ? 10 : index < 16 ? 11.6667 : 14.9349, alignment_confidence: 'high',
    }))
    const repository = { listLiveCanonicalAttentionPoints: vi.fn(async () => canonical) }
    const coverage = await readHistoricalVaultCoverage({ repository, candidateIds: ['live:death'], window: '24H', asOf: '2026-09-08T19:47:00.000Z', slotMinutes: 240 })
    expect(coverage.get('live:death')).toMatchObject({ status: 'available', reason: null, asOf: '2026-09-08T18:00:00.000Z', requestedAsOf: '2026-09-08T19:47:00.000Z', freshnessAllowanceMinutes: 300 })
    expect(coverage.get('live:death').growthPercent).toBeCloseTo(28.01, 2)
  })

  it.each([
    [1, 'available'], [3, 'available'], [4, 'available'], [5, 'available'], [5.01, 'stale-canonical-history'],
  ])('uses an inclusive scheduler interval plus provider-lag freshness allowance at %s hours', async (ageHours, expected) => {
    const latest = Date.parse('2026-09-08T18:00:00.000Z')
    const canonical = Array.from({ length: 24 }, (_, index) => ({ candidate_id: 'candidate', series_key: 'series', segment_id: 'segment', observed_at: new Date(latest - (23 - index) * 3_600_000).toISOString(), canonical_attention: index < 12 ? 10 : 20, alignment_confidence: 'high' }))
    const repository = { listLiveCanonicalAttentionPoints: vi.fn(async () => canonical) }
    const asOf = new Date(latest + ageHours * 3_600_000).toISOString()
    const coverage = await readHistoricalVaultCoverage({ repository, candidateIds: ['candidate'], window: '24H', asOf, slotMinutes: 240 })
    expect(expected === 'available' ? coverage.get('candidate').status : coverage.get('candidate').reason).toBe(expected)
  })
})
