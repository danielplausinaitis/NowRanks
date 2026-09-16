import { describe, expect, it, vi } from 'vitest'
import { buildActiveTrackingCohort } from './activeTrackingCohort.mjs'
import { collectLiveSharedInputs, selectDiscoveryCoveragePool } from './liveIngestionPipeline.mjs'

const scope = { kind: 'country', countryCode: 'US' }
const now = '2026-09-13T12:00:00.000Z'
const represented = ['Sports', 'Entertainment', 'Technology', 'Finance', 'Health', 'Gaming', 'Travel']

function candidate(category, index) {
  const query = `${category} topic ${index}`
  return { query, normalizedQuery: query.toLowerCase(), category, searchVolume: 1_000 - index, increasePercentage: 100 + index, providerDiscoveryRank: index + 1, rawProviderResultCount: 60, retrievedAt: now, geographicScope: scope }
}

function diversifiedDiscovery() {
  return [
    ...Array.from({ length: 42 }, (_, index) => candidate('Sports', index + 1)),
    ...Array.from({ length: 12 }, (_, index) => candidate('Entertainment', index + 41)),
    ...represented.slice(2).flatMap((category, index) => [candidate(category, index + 53)]),
    { query: 'Unknown topic', normalizedQuery: 'unknown topic', category: null, searchVolume: 10, providerDiscoveryRank: 60, rawProviderResultCount: 60, retrievedAt: now, geographicScope: scope },
  ]
}

describe('broad discovery coverage selection', () => {
  it('keeps a diversified normalized universe while selecting no more than the unchanged 50 paid candidates', async () => {
    const discovered = diversifiedDiscovery()
    const list = vi.fn(async ({ cacheKeys }) => cacheKeys.map((cache_key) => ({ cache_key, availability: 'available', search_volume: 1, monthly_history: [], retrieved_at: '2099-01-01T00:00:00Z' })))
    const lookup = vi.fn()
    const shared = await collectLiveSharedInputs({ discoveryLimit: 100, maxPaidCandidates: 50, discoveryRequest: { geographicScope: scope }, volumeRequest: {}, discoveryClient: { discover: vi.fn(async () => discovered) }, volumeClient: { lookup }, baselineCacheRepository: { listLiveBaselineDemandCache: list } })
    expect(shared.discoveryCandidates).toHaveLength(60)
    expect(shared.candidates).toHaveLength(50)
    expect(shared.candidates.every((item) => item.category)).toBe(true)
    for (const category of represented) expect(shared.candidates.map((item) => item.category)).toContain(category)
    expect(shared.sharedMetrics.cohort).toMatchObject({ rawProviderResults: 60, normalizedCandidates: 60, classifiedCandidates: 59, discoveryPool: 59, paidDiscoverySelected: 50 })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('selects one genuine observed opportunity per category before provider-strength fill, without creating an unknown category', () => {
    const selection = selectDiscoveryCoveragePool({ candidates: diversifiedDiscovery().filter((item) => item.category), maxPaidCandidates: 50 })
    expect(selection.candidates).toHaveLength(50)
    expect(selection.candidates.filter((item) => item.discoverySelectionReason === 'category-coverage').map((item) => item.category).sort()).toEqual([...represented].sort())
    expect(selection.diagnostics).toMatchObject({ categoryCoverageSelected: represented.length, providerStrengthSelected: 43, discardedBeforePaidMeasurement: 9 })
    expect(selection.candidates.map((item) => item.category)).not.toContain(null)
  })

  it('does not let retained Top20 tracking eliminate current fresh category opportunities', () => {
    const discovery = selectDiscoveryCoveragePool({ candidates: diversifiedDiscovery().filter((item) => item.category), maxPaidCandidates: 50 }).candidates
    const retained = Array.from({ length: 20 }, (_, index) => ({ candidateId: `retained-${index}`, normalizedQuery: `retained-${index}`, query: `Retained ${index}`, category: 'Sports', publicRank: index + 1, lastPaidAt: now, lastCanonicalSuccessAt: now, canonicalPointCount: 24, recentAcceptedAlignmentConfidence: 'high', consecutiveMissingHistory: 0 }))
    const cohort = buildActiveTrackingCohort({ discoveries: discovery, latestPublic: retained, tracking: retained, maxPaidCandidates: 50, now })
    const protectedFresh = cohort.diagnostics.selected.filter((item) => item.reservedFreshDiscovery === true)
    expect(protectedFresh).toHaveLength(20)
    const byQuery = new Map(discovery.map((item) => [item.normalizedQuery, item.category]))
    for (const category of represented) expect(protectedFresh.map((item) => byQuery.get(item.query))).toContain(category)
    expect(cohort.candidates).toHaveLength(50)
  })
})
