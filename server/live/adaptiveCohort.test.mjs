import { describe, expect, it, vi } from 'vitest'
import { collectLiveWindowCycle } from './liveIngestionPipeline.mjs'
import { buildLivePersistencePlan } from './livePersistence.mjs'

const scope = { kind: 'country', countryCode: 'US' }
const candidates = Array.from({ length: 20 }, (_, index) => ({ query: `Topic ${index + 1}`, normalizedQuery: `topic ${index + 1}`, category: 'Technology', searchVolume: 100 - index, retrievedAt: '2026-09-05T00:00:00Z', geographicScope: scope }))
const volumes = candidates.map((candidate) => ({ providerId: 'volume', query: candidate.query, normalizedQuery: candidate.normalizedQuery, availability: 'available', searchVolume: 10, monthlyHistory: [], retrievedAt: candidate.retrievedAt, geographicScope: scope }))
function response(keywords) { return { cost: 0.0012, status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ type: 'dataforseo_trends_graph', keywords, data: [{ timestamp: 1_788_912_000, values: keywords.map(() => 1) }] }] }] }] } }
function shared() { return { candidates, volumes, discoveryRequest: { geographicScope: scope, hours: 24 }, sharedMetrics: { providerRequests: { serpApi: 1, dataForSeoSearchVolume: 0 }, providerCosts: { searchVolume: 0 }, baselineCache: {} } } }
function scorer(eligible) { return vi.fn(async ({ candidates: scored }) => scored.map((candidate, index) => ({ topic: candidate.topic, normalizedQuery: candidate.normalizedQuery, shadowTrendingScore: eligible.has(Number(candidate.normalizedQuery.split(' ')[1])) ? 100 - index : null, shadowEmergingTrendingScore: null }))) }

describe('adaptive live paid cohort', () => {
  it('does not expand when the first paid batch fills the display', async () => {
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const cycle = await collectLiveWindowCycle({ sharedInputs: shared(), historyRequest: {}, historyWindow: '1Y', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set([1,2,3,4,5,6,7,8,9,10])), displayLimit: 10, initialPaidCandidates: 10, maxPaidCandidates: 20 })
    expect(measure).toHaveBeenCalledTimes(10); expect(cycle.requestMetrics.evaluation).toMatchObject({ actualPaidCandidates: 10, maximumPaidCandidates: 20 })
  })

  it('expands only after an insufficient first batch and stops once ten are ranked', async () => {
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const cycle = await collectLiveWindowCycle({ sharedInputs: shared(), historyRequest: {}, historyWindow: '1Y', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set([6,7,8,9,10,11,12,13,14,15])), displayLimit: 10, initialPaidCandidates: 5, maxPaidCandidates: 20 })
    expect(measure).toHaveBeenCalledTimes(15); expect(cycle.candidates).toHaveLength(15)
  })

  it('stops at the configured maximum without inventing eligibility', async () => {
    const measure = vi.fn(async ({ keywords }) => ({ response: response(keywords), retrievedAt: '2026-09-05T00:00:00Z', task: {} }))
    const cycle = await collectLiveWindowCycle({ sharedInputs: shared(), historyRequest: {}, historyWindow: '1Y', trendsMode: 'single', trendsClient: { measure }, scoreCycle: scorer(new Set([1,2])), displayLimit: 10, initialPaidCandidates: 5, maxPaidCandidates: 12 })
    expect(measure).toHaveBeenCalledTimes(12); expect(cycle.scores.filter((entry) => Number.isFinite(entry.shadowTrendingScore))).toHaveLength(2)
  })

  it('caps persisted display entries at ten without comparing scores across lanes', () => {
    const selected = candidates.slice(0, 12)
    const plan = buildLivePersistencePlan({ cycleId: 'adaptive-test', historyWindow: '1Y', scoredAt: '2026-09-05T00:00:00Z', displayLimit: 10, candidates: selected, volumes: selected.map((candidate) => ({ ...volumes[0], query: candidate.query, normalizedQuery: candidate.normalizedQuery })), histories: [], scores: selected.map((candidate, index) => ({ topic: candidate.query, normalizedQuery: candidate.normalizedQuery, components: { searchInterest: 1 }, componentDiagnostics: {}, history: { observationCount: 0, availableCount: 0, coveragePercentage: 0 }, topicClassification: 'established', confidence: 'full', confidenceReason: 'test', shadowOverallScore: index, shadowTrendingScore: index, shadowEmergingTrendingScore: null })) })
    expect(plan.snapshotEntries).toHaveLength(10); expect(plan.snapshotEntries.map((entry) => entry.lane_rank)).toEqual([1,2,3,4,5,6,7,8,9,10])
  })
})
