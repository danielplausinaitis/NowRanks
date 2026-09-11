import { describe, expect, it, vi } from 'vitest'
import { collectLiveWindowCycle } from './liveIngestionPipeline.mjs'
import { buildLivePersistencePlan } from './livePersistence.mjs'

const scope = { kind: 'country', countryCode: 'US' }
const candidates = Array.from({ length: 20 }, (_, index) => ({ query: `Topic ${index + 1}`, normalizedQuery: `topic ${index + 1}`, category: 'Technology', searchVolume: 100 - index, retrievedAt: '2026-09-05T00:00:00Z', geographicScope: scope }))
const volumes = candidates.map((candidate) => ({ providerId: 'volume', query: candidate.query, normalizedQuery: candidate.normalizedQuery, availability: 'available', searchVolume: 10, monthlyHistory: [], retrievedAt: candidate.retrievedAt, geographicScope: scope }))
function response(keywords) { return { cost: 0.0012, status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ type: 'dataforseo_trends_graph', keywords, data: [{ timestamp: 1_788_912_000, values: keywords.map(() => 1) }] }] }] }] } }
function shared() { return { candidates, volumes, discoveryRequest: { geographicScope: scope, hours: 24 }, sharedMetrics: { providerRequests: { serpApi: 1, dataForSeoSearchVolume: 0 }, providerCosts: { searchVolume: 0 }, baselineCache: {} } } }
function scorer(eligible) { return vi.fn(async ({ candidates: scored }) => scored.map((candidate, index) => ({ topic: candidate.topic, normalizedQuery: candidate.normalizedQuery, unifiedRawScore: eligible.has(Number(candidate.normalizedQuery.split(' ')[1])) ? 100 - index : null }))) }

describe('adaptive live paid cohort', () => {
  it('does not expand when the first paid batch fills the Top 20 display', async () => {
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const cycle = await collectLiveWindowCycle({ sharedInputs: shared(), historyRequest: {}, historyWindow: '1Y', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set(Array.from({ length: 20 }, (_, index) => index + 1))), displayLimit: 20, initialPaidCandidates: 20, maxPaidCandidates: 20 })
    expect(measure).toHaveBeenCalledTimes(20); expect(cycle.requestMetrics.evaluation).toMatchObject({ actualPaidCandidates: 20, maximumPaidCandidates: 20 })
  })

  it('expands only after an insufficient first batch and stops once the configured display is filled', async () => {
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const cycle = await collectLiveWindowCycle({ sharedInputs: shared(), historyRequest: {}, historyWindow: '1Y', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set(Array.from({ length: 15 }, (_, index) => index + 6))), displayLimit: 15, initialPaidCandidates: 5, maxPaidCandidates: 20 })
    expect(measure).toHaveBeenCalledTimes(20); expect(cycle.candidates).toHaveLength(20)
  })

  it('stops at the configured maximum without inventing eligibility', async () => {
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const cycle = await collectLiveWindowCycle({ sharedInputs: shared(), historyRequest: {}, historyWindow: '1Y', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set([1,2])), displayLimit: 20, initialPaidCandidates: 5, maxPaidCandidates: 12 })
    expect(measure).toHaveBeenCalledTimes(12); expect(cycle.scores.filter((entry) => Number.isFinite(entry.unifiedRawScore))).toHaveLength(2)
  })

  it('measures every selected tracking topic without promoting continuity-only topics into public scoring', async () => {
    const discovery = candidates.slice(0, 2)
    const retained = { query: 'Retained Canonical', normalizedQuery: 'retained canonical', category: 'Technology', trackingOnly: true, retrievedAt: '2026-09-05T00:00:00Z', geographicScope: scope }
    const retry = { query: 'Retry History', normalizedQuery: 'retry history', category: 'Technology', trackingOnly: true, retrievedAt: '2026-09-05T00:00:00Z', geographicScope: scope }
    const paid = [discovery[0], discovery[1], retained, retry]
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const scoreCycle = vi.fn(async ({ candidates: scoring }) => scoring.map((candidate, index) => ({ topic: candidate.topic, normalizedQuery: candidate.normalizedQuery, unifiedRawScore: 100 - index })))
    const cycle = await collectLiveWindowCycle({
      sharedInputs: { ...shared(), candidates: discovery, volumes: volumes.slice(0, 2) }, paidTrackingCandidates: paid,
      historyRequest: {}, historyWindow: '24H', trendsMode: 'single', trendsClient: { measure }, scoreCycle,
      displayLimit: 20, initialPaidCandidates: 2, maxPaidCandidates: 50,
    })
    expect(measure).toHaveBeenCalledTimes(4)
    expect(measure.mock.calls.flatMap(([request]) => request.keywords)).toEqual(paid.map((candidate) => candidate.query))
    expect(cycle.candidates.map((candidate) => candidate.normalizedQuery)).toEqual(paid.map((candidate) => candidate.normalizedQuery))
    expect(scoreCycle).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.arrayContaining([
      expect.objectContaining({ normalizedQuery: 'topic 1' }), expect.objectContaining({ normalizedQuery: 'topic 2' }),
    ]) }))
    expect(scoreCycle.mock.calls[0][0].candidates.map((candidate) => candidate.normalizedQuery)).not.toEqual(expect.arrayContaining(['retained canonical', 'retry history']))
    expect(cycle.scores.map((score) => score.normalizedQuery)).toEqual(['topic 1', 'topic 2'])
    expect(cycle.requestMetrics.evaluation).toMatchObject({ discoveryCandidateCount: 2, scoringDiscoveryCandidateCount: 2, selectedPaidTrackingCount: 4, actualTrendsRequestCount: 4, trackedCandidatesAbsentFromCurrentDiscovery: 2, selectedButNotMeasuredCount: 0 })
  })

  it('deduplicates selected paid tracking topics, rejects a cohort over 50, and makes no request for an unselected topic', async () => {
    const retained = { query: 'Retained Canonical', normalizedQuery: 'retained canonical', category: 'Technology', trackingOnly: true, retrievedAt: '2026-09-05T00:00:00Z', geographicScope: scope }
    const unselected = { query: 'Unselected History', normalizedQuery: 'unselected history', category: 'Technology', trackingOnly: true, retrievedAt: '2026-09-05T00:00:00Z', geographicScope: scope }
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const cycle = await collectLiveWindowCycle({ sharedInputs: { ...shared(), candidates: candidates.slice(0, 1), volumes: volumes.slice(0, 1) }, paidTrackingCandidates: [candidates[0], retained, retained], historyRequest: {}, historyWindow: '24H', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set([1])), displayLimit: 20, maxPaidCandidates: 50 })
    expect(cycle.candidates).toHaveLength(2)
    expect(measure.mock.calls.flatMap(([request]) => request.keywords)).toEqual(expect.arrayContaining([candidates[0].query, retained.query]))
    expect(measure.mock.calls.flatMap(([request]) => request.keywords)).not.toContain(unselected.query)
    const overCap = Array.from({ length: 51 }, (_, index) => ({ ...retained, query: `Retained ${index}`, normalizedQuery: `retained ${index}` }))
    await expect(collectLiveWindowCycle({ sharedInputs: shared(), paidTrackingCandidates: overCap, historyRequest: {}, historyWindow: '24H', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set()), displayLimit: 20, maxPaidCandidates: 50 })).rejects.toThrow(/exceeds configured maximum of 50/)
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('caps persisted unified display entries at the configured limit', () => {
    const selected = candidates.slice(0, 12)
    const plan = buildLivePersistencePlan({ cycleId: 'adaptive-test', historyWindow: '1Y', scoredAt: '2026-09-05T00:00:00Z', displayLimit: 20, candidates: selected, volumes: selected.map((candidate) => ({ ...volumes[0], query: candidate.query, normalizedQuery: candidate.normalizedQuery })), histories: [], scores: selected.map((candidate, index) => ({ topic: candidate.query, normalizedQuery: candidate.normalizedQuery, components: { searchInterest: 1 }, componentDiagnostics: {}, history: { observationCount: 0, availableCount: 0, coveragePercentage: 0 }, topicClassification: 'established', confidence: 'full', confidenceReason: 'test', evidenceStatus: 'established', unifiedRawScore: index, nowScore: 54 + index * .45 })) })
    expect(plan.snapshotEntries).toHaveLength(12); expect(plan.snapshotEntries.map((entry) => entry.public_rank)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12])
  })
})
