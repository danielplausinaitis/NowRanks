import { describe, expect, it, vi } from 'vitest'
import { buildActiveTrackingCohort, TRACKING_FRESH_DISCOVERY_RESERVE, TRACKING_HARD_MAX_PAID_CANDIDATES, TRACKING_PUBLIC_TOP_LIMIT } from './activeTrackingCohort.mjs'
import { collectLiveWindowCycle, publicFunnelDiagnostics } from './liveIngestionPipeline.mjs'
import { DEFAULT_LIVE_DISPLAY_LIMIT, DEFAULT_LIVE_MAX_PAID_CANDIDATES } from './livePersistence.mjs'
import { buildLivePersistencePlan } from './livePersistence.mjs'

const now = '2026-09-11T12:00:00.000Z'
const scope = { kind: 'country', countryCode: 'US' }
const globalScope = { kind: 'global' }

function current(index) {
  return { providerId: 'serpapi-google-trends-trending-now', query: `Current ${index}`, normalizedQuery: `current ${index}`, category: 'Technology', searchVolume: 10_000 - index, increasePercentage: 100 + index, retrievedAt: now, geographicScope: scope }
}

function retained(prefix, index, patch = {}) {
  const query = `${prefix} ${index}`.toLowerCase()
  return {
    candidateId: `live:${query}`, query, normalizedQuery: query, category: 'Technology', lastPaidAt: now,
    lastCanonicalSuccessAt: now, recentAcceptedAlignmentConfidence: 'high', canonicalPointCount: 24,
    consecutiveMissingHistory: 0, ...patch,
  }
}

function providerResponse(keywords) {
  return { cost: 0, status_code: 20_000, tasks: [{ status_code: 20_000, result: [{ items: [{ type: 'dataforseo_trends_graph', keywords, data: [{ timestamp: 1_789_126_400, values: keywords.map(() => 1) }] }] }] }] }
}

function publicScore(candidate, index) {
  return {
    topic: candidate.topic, normalizedQuery: candidate.normalizedQuery, unifiedRawScore: 100 - index, nowScore: 95 - index,
    components: { searchInterest: 50 }, componentDiagnostics: {}, history: { observationCount: 1, availableCount: 1, coveragePercentage: 100 },
    topicClassification: 'established', confidence: 'full', confidenceReason: 'fixture', evidenceStatus: 'established',
  }
}

function globalVolume(candidate) {
  return {
    providerId: 'dataforseo-clickstream-global-search-volume', query: candidate.query, normalizedQuery: candidate.normalizedQuery,
    availability: 'available', searchVolume: 1_000, measurementProvenance: { measurementMode: 'global', measurementLocation: globalScope },
  }
}

function globalHistory(candidate) {
  return {
    normalizedQuery: candidate.normalizedQuery,
    measurementProvenance: { measurementMode: 'global', measurementLocation: globalScope },
  }
}

function globalScore(candidate, index, { calculable = true } = {}) {
  return {
    ...publicScore({ topic: candidate.query, normalizedQuery: candidate.normalizedQuery }, index),
    unifiedRawScore: calculable ? 100 - index : null,
    raw: { globalCurrentIntensity: calculable ? { value: 80, reason: null } : { value: null, reason: 'insufficient-global-google-trends-points' } },
    components: { growth: calculable ? 50 : null, momentum: calculable ? 40 : null, consistency: calculable ? 30 : null, breakout: calculable ? 20 : null },
  }
}

async function runFixture(currentDiscoveryEligible) {
  const discoveries = Array.from({ length: currentDiscoveryEligible }, (_, index) => current(index + 1))
  const previousTop20 = Array.from({ length: 20 }, (_, index) => retained('previous', index + 1, { publicRank: index + 1 }))
  const continuity = Array.from({ length: 20 }, (_, index) => retained('continuity', index + 1))
  const retries = Array.from({ length: 5 }, (_, index) => retained('retry', index + 1, { lastCanonicalSuccessAt: null, canonicalPointCount: 0, consecutiveMissingHistory: 1 }))
  const cohort = buildActiveTrackingCohort({ discoveries, latestPublic: previousTop20, tracking: [...previousTop20, ...continuity, ...retries], maxPaidCandidates: 50, now })
  const volumes = discoveries.map((candidate) => ({ providerId: 'volume', query: candidate.query, normalizedQuery: candidate.normalizedQuery, availability: 'available', searchVolume: 1_000, monthlyHistory: [], retrievedAt: now, geographicScope: scope }))
  const measure = vi.fn(async ({ keywords }) => ({ response: providerResponse(keywords), retrievedAt: now, task: {} }))
  const scoreCycle = vi.fn(async ({ candidates }) => candidates.map(publicScore))
  const cycle = await collectLiveWindowCycle({
    sharedInputs: { candidates: discoveries, volumes, discoveryRequest: { geographicScope: scope, hours: 24 }, sharedMetrics: { cohort: { discovered: 50, discoveryPool: 50, baselinePrepared: discoveries.length }, providerRequests: { serpApi: 1, dataForSeoSearchVolume: 1 }, providerCosts: { searchVolume: 0 }, baselineCache: {} } },
    paidTrackingCandidates: cohort.candidates, trackingDiagnostics: cohort.diagnostics,
    historyRequest: {}, historyWindow: '24H', trendsMode: 'single', trendsClient: { measure }, scoreCycle,
    displayLimit: 20, maxPaidCandidates: 50,
  })
  const plan = buildLivePersistencePlan({ cycleId: `fixture-${currentDiscoveryEligible}`, historyWindow: '24H', scoredAt: now, candidates: cycle.candidates, volumes: cycle.volumes, histories: cycle.histories, scores: cycle.scores, displayLimit: 20 })
  return { cohort, cycle, plan, measure, scoreCycle }
}

describe('24H public Top-20 funnel', () => {
  it('uses the current default public contract: 20 display rows, 20 protected current discoveries, and 50 paid slots', () => {
    expect(DEFAULT_LIVE_DISPLAY_LIMIT).toBe(20)
    expect(TRACKING_PUBLIC_TOP_LIMIT).toBe(20)
    expect(TRACKING_FRESH_DISCOVERY_RESERVE).toBe(20)
    expect(DEFAULT_LIVE_MAX_PAID_CANDIDATES).toBe(50)
    expect(TRACKING_HARD_MAX_PAID_CANDIDATES).toBe(50)
  })

  it.each([
    [10, 10, 0],
    [20, 20, 20],
    [30, 20, 20],
  ])('keeps %i eligible current discoveries within a 50-slot retained cohort and publishes %i complete-board rows', async (eligible, expectedPublicSelected, expectedPublishedRows) => {
    const { cohort, cycle, plan, measure, scoreCycle } = await runFixture(eligible)
    const funnel = cycle.requestMetrics.publicFunnel
    expect(cohort.candidates.length).toBeLessThanOrEqual(50)
    expect(funnel).toMatchObject({
      discovered: 50,
      currentDiscoveryEligible: eligible,
      protectedFreshDiscovery: Math.min(eligible, 20),
      selectedPaidTracking: 50,
      actuallyMeasured: 50,
      measuredCurrentDiscovery: Math.min(eligible, 20),
      scorable: Math.min(eligible, 20),
      unified: Math.min(eligible, 20),
      publicSelected: expectedPublicSelected,
    })
    expect(measure).toHaveBeenCalledTimes(50)
    expect(scoreCycle.mock.calls[0][0].candidates).toHaveLength(Math.min(eligible, 20))
    expect(scoreCycle.mock.calls[0][0].candidates.every((candidate) => candidate.normalizedQuery.startsWith('current '))).toBe(true)
    expect(plan.snapshotEntries).toHaveLength(expectedPublishedRows)
    expect(plan.snapshotEntries.map((entry) => entry.public_rank)).toEqual(Array.from({ length: expectedPublishedRows }, (_, index) => index + 1))
    if (eligible > 20) expect(funnel.currentDiscoveryExclusions).toEqual(expect.arrayContaining([{ query: 'current 21', reason: 'fresh-discovery-capacity' }]))
  })

  it('does not manufacture a public row for a selected current discovery without a provider-history record', () => {
    const currentDiscovery = [current(1), current(2)]
    const funnel = publicFunnelDiagnostics({
      discoveryCandidates: currentDiscovery, trackingCandidates: currentDiscovery,
      histories: [{ normalizedQuery: 'current 1' }],
      scores: [publicScore({ topic: 'Current 1', normalizedQuery: 'current 1' }, 0)],
      displayLimit: 20, sharedMetrics: { cohort: { discovered: 50 } },
      trackingDiagnostics: { selected: currentDiscovery.map((candidate) => ({ query: candidate.normalizedQuery, reservedFreshDiscovery: true })), exclusions: [] },
    })
    expect(funnel).toMatchObject({ actuallyMeasured: 1, measuredCurrentDiscovery: 1, scorable: 1, unified: 1, publicSelected: 1 })
    expect(funnel.currentDiscoveryExclusions).toEqual([{ query: 'current 2', reason: 'not-measured' }])
  })

  it.each(['7D', '30D', '1Y'])('reports a complete %s public Top 20 without provider I/O', (window) => {
    const cohort = Array.from({ length: 20 }, (_, index) => current(index + 1))
    const funnel = publicFunnelDiagnostics({
      discoveryCandidates: cohort, trackingCandidates: cohort, volumes: cohort.map(globalVolume), histories: cohort.map(globalHistory),
      scores: cohort.map((candidate, index) => globalScore(candidate, index)), displayLimit: 20,
      sharedMetrics: { cohort: { discovered: 50 } },
    })
    expect(funnel).toMatchObject({ selectedPaidTracking: 20, actuallyMeasured: 20, validGlobalBaseline: 20, validGlobalHistory: 20, currentIntensityAvailable: 20, scoreCalculable: 20, unifiedEligible: 20, publicSelected: 20 })
    expect(funnel.reasonCounts).toEqual({ 'public-selected': 20 })
  })

  it('reports a partial board and separates retained previous-Top20 candidates from currentness failures without publishing invalid rows', () => {
    const currentDiscovery = Array.from({ length: 32 }, (_, index) => current(index + 1))
    const retainedPreviousTop20 = Array.from({ length: 18 }, (_, index) => retained('previous', index + 1))
    const tracking = [...currentDiscovery, ...retainedPreviousTop20]
    const scores = currentDiscovery.map((candidate, index) => globalScore(candidate, index, { calculable: index < 14 }))
    const funnel = publicFunnelDiagnostics({
      discoveryCandidates: currentDiscovery, trackingCandidates: tracking, volumes: tracking.map(globalVolume), histories: tracking.map(globalHistory), scores,
      displayLimit: 20, sharedMetrics: { cohort: { discovered: 385 } },
      trackingDiagnostics: { selected: retainedPreviousTop20.map((candidate) => ({ query: candidate.normalizedQuery })), exclusions: [] },
    })
    expect(funnel).toMatchObject({ selectedPaidTracking: 50, currentDiscoveryEligible: 32, actuallyMeasured: 50, validGlobalBaseline: 50, validGlobalHistory: 50, currentIntensityAvailable: 14, scoreCalculable: 14, unifiedEligible: 14, publicSelected: 14 })
    expect(funnel.reasonCounts).toEqual({
      'current-intensity-unavailable:insufficient-global-google-trends-points': 18,
      'public-selected': 14,
      'retained-tracking-not-current-discovery': 18,
    })
    expect(funnel.candidateEligibility.filter((item) => item.reason === 'retained-tracking-not-current-discovery')).toHaveLength(18)
    expect(funnel.candidateEligibility.filter((item) => item.reason.startsWith('current-intensity-unavailable:'))).toHaveLength(18)
  })
})
