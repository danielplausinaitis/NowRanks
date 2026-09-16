import { describe, expect, it } from 'vitest'
import { buildCategoryDiversityDiagnostics, isSuccessfulLiveV2Snapshot } from './checkCategoryDiversity.mjs'

const snapshot = { snapshot_id: 'snapshot', ingestion_run_id: 'run', cycle_id: 'cycle', selected_window: '24H', scored_at: '2026-09-13T12:00:00.000Z', data_mode: 'live', snapshot_format_version: 2, ingestion_runs: { status: 'succeeded' } }
const discovery = (candidate_id, category, patch = {}) => ({ ingestion_run_id: 'run', candidate_id, evidence_kind: 'discovery', availability: 'available', candidates: { query_text: candidate_id, category }, evidence_payload: { query: candidate_id, normalizedQuery: candidate_id, category, searchVolume: 100, increasePercentage: 50, categories: [category], rawProviderResultCount: 2, providerDiscoveryRank: 1, normalizedDiscoveryPosition: 1, discoveryPoolPosition: 1, discoverySelectionReason: 'category-coverage', paidTrackingSelected: true, paidTrackingSelectionReason: 'freshDiscoveries', ...patch } })

describe('category diversity diagnostic', () => {
  it('reports only persisted live stages and never invents a non-public score or category quota', () => {
    const report = buildCategoryDiversityDiagnostics({ snapshots: [snapshot], evidence: [discovery('tech', 'Technology'), discovery('sports', 'Sports'), { ingestion_run_id: 'run', candidate_id: 'tech', evidence_kind: 'baseline-demand', availability: 'available', evidence_payload: { searchVolume: 200 }, candidates: { query_text: 'tech', category: 'Technology' } }, { ingestion_run_id: 'run', candidate_id: 'tech', evidence_kind: 'history-metadata', availability: 'metadata', evidence_payload: {}, candidates: { query_text: 'tech', category: 'Technology' } }], entries: [{ snapshot_id: 'snapshot', candidate_id: 'tech', public_rank: 7, public_score: 80, component_availability: { searchInterest: { value: 61 }, momentum: { value: 47 } }, candidates: { query_text: 'tech', category: 'Technology' } }] })[0]
    expect(report.normalizedDiscovery.categories).toEqual({ Sports: 1, Technology: 1 })
    expect(report.rawProviderResults).toMatchObject({ available: true })
    expect(report.discoveryPool.categories).toEqual({ Sports: 1, Technology: 1 })
    expect(report.paidTracking.categories).toEqual({ Sports: 1, Technology: 1 })
    expect(report.measured.categories).toEqual({ Technology: 1 })
    expect(report.publicTop20.categories).toEqual({ Technology: 1 })
    expect(report.scorable).toMatchObject({ available: false, reason: expect.stringMatching(/not persisted/) })
    expect(report.counts.taxonomyCoveragePercent).toBe(100)
    expect(report.candidateDetails).toEqual(expect.arrayContaining([expect.objectContaining({ candidate: 'sports', classificationSource: 'provider-metadata', providerTag: ['Sports'], unifiedRawScore: null, currentIntensity: null, momentum: null, paidSelected: true, top20: false, exclusionReason: 'baseline-not-persisted' }), expect.objectContaining({ candidate: 'tech', publicRank: 7, publicScore: 80, currentIntensity: 61, momentum: 47, rawDiscoveryPosition: 1, paidSelected: true, top20: true, exclusionReason: null })]))
  })

  it('keeps missing categories explicit', () => {
    const report = buildCategoryDiversityDiagnostics({ snapshots: [snapshot], evidence: [discovery('unknown', null)], entries: [] })[0]
    expect(report.normalizedDiscovery.categories).toEqual({ Unclassified: 1 })
    expect(report.candidateDetails[0]).toMatchObject({ category: 'Unclassified', eligible: true })
  })

  it('reclassifies persisted provider tags under the current taxonomy while leaving ambiguous Other explicit', () => {
    const report = buildCategoryDiversityDiagnostics({
      snapshots: [snapshot],
      evidence: [
        discovery('politics', null, { categories: [], unmappedCategories: ['Politics'] }),
        discovery('climate', null, { categories: [], unmappedCategories: ['Climate'] }),
        discovery('other', null, { categories: [], unmappedCategories: ['Other'] }),
      ], entries: [],
    })[0]
    expect(report.classifiedCandidates.categories).toEqual({ 'News & Politics': 1, Science: 1 })
    expect(report.unclassified.categories).toEqual({ Unclassified: 1 })
    expect(report.counts).toMatchObject({ classifiedCandidateCount: 2, unclassifiedCandidateCount: 1, taxonomyCoveragePercent: 100 * 2 / 3 })
    expect(report.candidateDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidate: 'politics', category: 'News & Politics', classificationSource: 'provider-metadata', providerTag: ['Politics'] }),
      expect.objectContaining({ candidate: 'other', category: 'Unclassified', classificationSource: 'unclassified' }),
    ]))
  })

  it('rejects replay, mock, legacy, and failed snapshots before diagnostics are built', () => {
    expect(isSuccessfulLiveV2Snapshot(snapshot)).toBe(true)
    expect(isSuccessfulLiveV2Snapshot({ ...snapshot, data_mode: 'replay' })).toBe(false)
    expect(isSuccessfulLiveV2Snapshot({ ...snapshot, data_mode: 'mock' })).toBe(false)
    expect(isSuccessfulLiveV2Snapshot({ ...snapshot, snapshot_format_version: 1 })).toBe(false)
    expect(isSuccessfulLiveV2Snapshot({ ...snapshot, ingestion_runs: { status: 'failed' } })).toBe(false)
  })
})
