import { describe, expect, it, vi } from 'vitest'
import { checkCanonicalAttentionAlignment } from './checkCanonicalAttentionAlignment.mjs'

describe('canonical alignment check', () => {
  it('is a read-only report over recent alignment events', async () => {
    const repository = { listLiveCanonicalAttentionAlignments: vi.fn(async () => [{
      source_artifact_id: 'artifact', accepted: true, reason: 'bootstrap', usable_overlap_count: 0, rejected_overlap_count: 0,
      scale_factor: 1, dispersion: 0, confidence: 'high', segment_id: 'segment',
      live_provider_curve_artifacts: { slot_at: '2026-09-02T12:00:00.000Z', provider_id: 'dataforseo-trends', provider_query: 'pink', ingestion_runs: { run_id: 'run', idempotency_key: 'live:serpapi-dataforseo:cycle:24H:v2' }, live_canonical_attention_points: [{ point_id: 'one' }, { point_id: 'two' }] },
    }]) }
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const events = await checkCanonicalAttentionAlignment({ candidateId: 'candidate', repository })
    expect(repository.listLiveCanonicalAttentionAlignments).toHaveBeenCalledWith({ candidateId: 'candidate', limit: 25 })
    expect(events).toEqual([expect.objectContaining({ status: 'bootstrap', cycle: 'live:serpapi-dataforseo:cycle:24H:v2', newCanonicalPoints: 2 })])
    output.mockRestore()
  })
})
