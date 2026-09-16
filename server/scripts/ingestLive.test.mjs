import { describe, expect, it, vi } from 'vitest'
import { buildCanonicalAttentionPersistencePlan } from '../live/canonicalAttentionPersistence.mjs'
import { attachVaultGrowth, loadActiveTrackingState, loadCanonicalExisting } from './ingestLive.mjs'

const query = "ballon d'or"
const candidateId = `live:${query}`
const values = [100, 50, 25, 13, 6, 3, 2, 1]
function history() {
  return {
    topic: "Ballon d'Or", normalizedQuery: query, retrievedAt: '2026-09-08T18:36:00.000Z', historyRequest: { timeRange: 'past_day' },
    provenance: { providerId: 'dataforseo-trends', geographicScope: { kind: 'country', countryCode: 'US' }, sourceVersion: 'dataforseo-trends-v3', collectionMethod: 'dataforseo-trends-explore-live' },
    observations: values.map((interest, index) => ({ observedAt: `2026-09-08T${String(index + 7).padStart(2, '0')}:00:00.000Z`, availability: 'available', interest })),
  }
}

describe('live canonical history loading regression', () => {
  it('loads Postgres timestamptz canonical rows into the real planner so Ballon d’Or aligns with no new timestamps', async () => {
    const first = buildCanonicalAttentionPersistencePlan({ histories: [history()], candidateIdByQuery: new Map([[query, candidateId]]), runId: 'cycle-one', scoredAt: '2026-09-08T15:01:00.000Z' })
    const postgresRows = first.points.map((point) => ({ ...point, observed_at: point.observed_at.replace('.000Z', '+00:00') }))
    const repository = {
      listCandidatesByNormalizedQueries: vi.fn(async () => [{ candidate_id: candidateId, normalized_query: query }]),
      listLiveCanonicalAttentionPoints: vi.fn(async () => postgresRows),
    }
    const cycle = { candidates: [{ normalizedQuery: query }], histories: [history()] }
    const existingByQuery = await loadCanonicalExisting({ cycle, repository, enabled: true })
    const second = buildCanonicalAttentionPersistencePlan({ histories: [history()], candidateIdByQuery: new Map([[query, candidateId]]), existingByQuery, runId: 'cycle-two', scoredAt: '2026-09-08T18:36:00.000Z' })
    expect(repository.listLiveCanonicalAttentionPoints).toHaveBeenCalledWith({ candidateIds: [candidateId] })
    expect(second.alignments[0]).toMatchObject({ accepted: true, usable_overlap_count: 4, scale_factor: 1, dispersion: 0, confidence: 'high', total_timestamp_overlap: 8, available_overlap_count: 8, strong_usable_overlap_count: 4, weak_overlap_rejected: 4 })
    expect(second.points).toHaveLength(0)
  })
  it('derives canonical segment, point maturity, and accepted confidence for tracking diagnostics', async () => {
    const repository = {
      listRecentCanonicalTrackingArtifacts: vi.fn(async () => [{
        candidate_id: candidateId, slot_at: '2026-09-08T12:00:00.000Z', raw_curve: [{ availability: 'available', value: 10 }],
        candidates: { candidate_id: candidateId, query_text: "Ballon d'Or", normalized_query: query, category: 'Sports' },
        live_canonical_attention_alignments: [{ accepted: true, confidence: 'high', segment_id: 'segment-current' }],
      }]),
      listLiveCanonicalAttentionPoints: vi.fn(async () => [
        { candidate_id: candidateId, observed_at: '2026-09-08T11:00:00.000Z', segment_id: 'segment-old' },
        { candidate_id: candidateId, observed_at: '2026-09-08T12:00:00.000Z', segment_id: 'segment-current' },
      ]),
    }
    const state = await loadActiveTrackingState({ repository, now: '2026-09-08T16:00:00.000Z' })
    expect(repository.listRecentCanonicalTrackingArtifacts).toHaveBeenCalledWith({ since: '2026-09-01T16:00:00.000Z' })
    expect(repository.listLiveCanonicalAttentionPoints).toHaveBeenCalledWith({ candidateIds: [candidateId] })
    expect(state.tracking).toEqual([expect.objectContaining({ canonicalSegment: 'segment-current', canonicalPointCount: 2, recentAcceptedAlignmentConfidence: 'high', lastCanonicalSuccessAt: '2026-09-08T12:00:00.000Z' })])
  })
  it('reports shadow promotion eligibility without changing public Growth, then promotes only the same gated value in preferred mode', async () => {
    const latest = Date.parse('2026-09-08T20:00:00.000Z')
    const canonical = Array.from({ length: 24 }, (_, index) => ({ candidate_id: candidateId, series_key: 'series', segment_id: 'segment', observed_at: new Date(latest - (23 - index) * 3_600_000).toISOString(), canonical_attention: index < 12 ? 10 : 20, alignment_confidence: 'high' }))
    const repository = {
      listCandidatesByNormalizedQueries: vi.fn(async () => [{ candidate_id: candidateId, normalized_query: query }]),
      listLiveCanonicalAttentionPoints: vi.fn(async () => canonical),
    }
    const cycle = {
      candidates: [{ normalizedQuery: query }], scoredAt: '2026-09-08T20:03:00.000Z', requestMetrics: {},
      scores: [{ normalizedQuery: query, presentation: { growthPercent: 55, growthSource: 'provider-history' }, raw: { currentTrendIntensity: { increasePercentage: 1_000 } } }],
    }
    const shadow = await attachVaultGrowth({ cycle, repository, historyWindow: '24H', vaultConfig: { enabled: true, growthMode: 'shadow', slotMinutes: 240 } })
    expect(shadow.scores[0].presentation).toMatchObject({ growthPercent: 55, growthSource: 'provider-history', vaultGrowth: { promotion: { eligible: true, wouldPromoteInShadow: true, promotedInPreferred: false } } })
    expect(shadow.requestMetrics.vault).toMatchObject({ available: 1, promotionEligible: 1, shadowWouldPromote: 1, preferredPromoted: 0, publicChangedByVault: 0 })
    const preferred = await attachVaultGrowth({ cycle, repository, historyWindow: '24H', vaultConfig: { enabled: true, growthMode: 'preferred', slotMinutes: 240 } })
    expect(preferred.scores[0].presentation).toMatchObject({ growthPercent: 100, growthSource: 'nowranks-history', vaultGrowth: { promotion: { eligible: true, promotedInPreferred: true } } })
    expect(preferred.requestMetrics.vault).toMatchObject({ preferredPromoted: 1, publicChangedByVault: 1 })
  })

  it('promotes mature canonical 7D Growth only in preferred mode and preserves the fallback in shadow mode', async () => {
    const latest = Date.parse('2026-01-14T23:00:00.000Z')
    const canonical = Array.from({ length: 336 }, (_, index) => ({ candidate_id: candidateId, series_key: 'series', segment_id: 'segment', observed_at: new Date(latest - (335 - index) * 3_600_000).toISOString(), canonical_attention: index < 168 ? 10 : 20, alignment_confidence: 'high' }))
    const repository = { listCandidatesByNormalizedQueries: vi.fn(async () => [{ candidate_id: candidateId, normalized_query: query }]), listLiveCanonicalAttentionPoints: vi.fn(async () => canonical) }
    const cycle = { candidates: [{ normalizedQuery: query }], scoredAt: '2026-01-14T23:00:00.000Z', requestMetrics: {}, scores: [{ normalizedQuery: query, presentation: { growthPercent: 1_000, growthSource: 'discovery-increase', growthSaturated: true }, raw: { currentTrendIntensity: { increasePercentage: 1_000 } } }] }
    const shadow = await attachVaultGrowth({ cycle, repository, historyWindow: '7D', vaultConfig: { enabled: true, growthMode: 'shadow', slotMinutes: 240 } })
    expect(shadow.scores[0].presentation).toMatchObject({ growthPercent: 1_000, growthSource: 'discovery-increase', growthSaturated: true, vaultGrowth: { promotion: { eligible: true, wouldPromoteInShadow: true, promotedInPreferred: false } } })
    const preferred = await attachVaultGrowth({ cycle, repository, historyWindow: '7D', vaultConfig: { enabled: true, growthMode: 'preferred', slotMinutes: 240 } })
    expect(preferred.scores[0].presentation).toMatchObject({ growthPercent: 100, growthSource: 'nowranks-history', growthSaturated: false, vaultGrowth: { promotion: { eligible: true, promotedInPreferred: true } } })
  })

  it.each(['7D', '30D', '1Y'])('never reintroduces country discovery Growth for global %s output when global history is unavailable', async (historyWindow) => {
    const repository = {
      listCandidatesByNormalizedQueries: vi.fn(async () => [{ candidate_id: candidateId, normalized_query: query }]),
      ...(historyWindow === '7D'
        ? { listLiveCanonicalAttentionPoints: vi.fn(async () => []) }
        : { listLiveHistoricalVaultMeasurements: vi.fn(async () => []) }),
    }
    const cycle = {
      candidates: [{ normalizedQuery: query }], scoredAt: '2026-01-14T23:00:00.000Z', requestMetrics: {},
      scores: [{
        normalizedQuery: query,
        publicScoringDiagnostics: { discoveryMagnitudeUsedInPublicScore: false },
        presentation: { growthPercent: null, growthSource: 'unavailable', growthSaturated: false },
        raw: { currentTrendIntensity: { increasePercentage: 1_000 } },
      }],
    }
    const result = await attachVaultGrowth({ cycle, repository, historyWindow, vaultConfig: { enabled: true, growthMode: 'preferred', slotMinutes: 240 } })
    expect(result.scores[0].presentation).toMatchObject({ growthPercent: null, growthSource: 'unavailable', growthSaturated: false })
    expect(result.scores[0].presentation.vaultGrowth).toMatchObject({ discoveryIncreasePercentage: null, promotion: { eligible: false } })
  })
})
