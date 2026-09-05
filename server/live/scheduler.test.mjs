import { describe, expect, it, vi } from 'vitest'
import { runScheduledOnce, schedulePlan } from './scheduler.mjs'
import { collectLiveSharedInputs } from './liveIngestionPipeline.mjs'
import { baselineCacheKey } from './baselineCache.mjs'
describe('live scheduler core', () => {
  it('is disabled by default and plans without provider or database I/O', () => { const plan = schedulePlan({ env: {}, now: new Date('2026-09-04T10:12:00Z') }); expect(plan.config.enabled).toBe(false); expect(plan.windows.map((x) => x.providerRange)).toEqual(['past_day', 'past_7_days', 'past_30_days', 'past_12_months']); expect(plan.windows[0].cycleId).toContain('scheduled:2026-09-04T08:00:00Z:24H') })
  it('accounts for all four window ingestions and one shared cold baseline refresh', () => {
    const plan = schedulePlan({ env: { LIVE_INGEST_CANDIDATE_LIMIT: '10' }, now: new Date('2026-09-04T10:12:00Z') })
    expect(plan.estimates).toMatchObject({ windowCount: 4, serpApiRequests: 1, trendsRequests: 40, trendsCostUsd: 0.048, warmInvocationCostUsd: 0.048 })
    expect(plan.estimates.baseline).toMatchObject({ coldRequests: 1, warmRequests: 0, coldCostUsd: 0.09, warmCostUsd: 0, steadyCostUsd: 0.015 })
    expect(plan.estimates.coldCycleCostUsd).toBeCloseTo(0.138)
    expect(plan.estimates.steadyCycleCostUsd).toBeCloseTo(0.063)
    expect(plan.estimates.estimatedMonthlyCostUsd.candidates10).toBeCloseTo(11.34)
    expect(plan.estimates.estimatedMonthlyCostUsd.candidates50).toBeCloseTo(45.9)
    expect(plan.estimates.estimatedMonthlyCostUsd.candidates100).toBeCloseTo(89.1)
  })
  it('uses the corrected cold-cycle estimate for cost-cap preflight', () => {
    expect(schedulePlan({ env: { LIVE_INGEST_CANDIDATE_LIMIT: '10', LIVE_MAX_PROVIDER_COST_USD: '0.12' } }).withinCostCap).toBe(false)
    expect(schedulePlan({ env: { LIVE_INGEST_CANDIDATE_LIMIT: '10', LIVE_MAX_PROVIDER_COST_USD: '0.138' } }).withinCostCap).toBe(true)
  })
  it('prices the configured maximum paid exposure rather than the initial adaptive batch', () => {
    const plan = schedulePlan({ env: { LIVE_DISCOVERY_LIMIT: '50', LIVE_INITIAL_PAID_CANDIDATES: '15', LIVE_MAX_PAID_CANDIDATES: '50', LIVE_MAX_PROVIDER_COST_USD: '0.33' } })
    expect(plan.config).toMatchObject({ displayLimit: 10, discoveryLimit: 50, initialPaidCandidates: 15, maxPaidCandidates: 50 })
    expect(plan.estimates).toMatchObject({ trendsRequests: 200, coldCycleCostUsd: 0.33 })
    expect(plan.withinCostCap).toBe(true)
  })
  it('cannot bypass the existing live write gate or cost cap', async () => { const prepare = vi.fn(); const run = vi.fn(); await expect(runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true' }, prepareShared: prepare, runIngestion: run })).rejects.toThrow('ALLOW_LIVE_DATABASE_WRITE'); await expect(runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true', LIVE_MAX_PROVIDER_COST_USD: '0.001' }, prepareShared: prepare, runIngestion: run })).rejects.toThrow('exceeds'); expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled() })
  it('prepares one shared cohort and reuses it across four distinct window cycles', async () => { const shared = { sharedInputs: { candidates: [{ normalizedQuery: 'same-topic' }] }, repository: {} }; const prepare = vi.fn(async () => shared); const run = vi.fn(async (env, received) => ({ cycle: env.LIVE_INGEST_CYCLE_ID, window: env.LIVE_INGEST_HISTORY_WINDOW, received })); const result = await runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true' }, now: new Date('2026-09-04T10:00:00Z'), prepareShared: prepare, runIngestion: run }); expect(prepare).toHaveBeenCalledTimes(1); expect(result.results).toHaveLength(4); expect(new Set(result.results.map((x) => x.cycle)).size).toBe(4); expect(result.results.map((x) => x.window)).toEqual(['24H', '7D', '30D', '1Y']); expect(result.results.every((x) => x.received === shared)).toBe(true); expect(run.mock.calls.every(([env]) => env.LIVE_INGEST_DRY_RUN === 'false')).toBe(true) })
  it('resolves discovery and fresh baseline cache exactly once for the shared slot cohort', async () => {
    const candidates = [{ query: 'One', normalizedQuery: 'one', category: 'Technology', searchVolume: 1 }, { query: 'Two', normalizedQuery: 'two', category: 'Technology', searchVolume: 1 }]
    const request = { locationCode: 2840 }
    const discover = vi.fn(async () => candidates)
    const list = vi.fn(async ({ cacheKeys }) => cacheKeys.map((cache_key, index) => ({ cache_key, availability: 'available', search_volume: index, monthly_history: [], retrieved_at: '2099-01-01T00:00:00Z' })))
    const lookup = vi.fn()
    const shared = await collectLiveSharedInputs({ candidateLimit: 10, discoveryRequest: { geographicScope: { kind: 'country', countryCode: 'US' } }, volumeRequest: request, discoveryClient: { discover }, volumeClient: { lookup }, baselineCacheRepository: { listLiveBaselineDemandCache: list } })
    expect(discover).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledTimes(1); expect(lookup).not.toHaveBeenCalled(); expect(shared.candidates).toEqual(candidates); expect(list).toHaveBeenCalledWith({ cacheKeys: candidates.map((candidate) => baselineCacheKey(candidate.normalizedQuery, request)) })
  })
  it('skips an all-completed slot before shared inputs or external work', async () => {
    const prepare = vi.fn(); const run = vi.fn()
    const result = await runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true' }, isWindowComplete: vi.fn(async () => true), prepareShared: prepare, runIngestion: run })
    expect(result.skipped).toHaveLength(4); expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(result.providerSummary.aggregate).toEqual({ serpApi: 0, dataForSeoSearchVolume: 0, dataForSeoTrends: 0, dataForSeoCost: 0 })
  })
  it.each([1, 2])('runs shared preparation once and Trends only for %s pending window(s)', async (pendingCount) => {
    let checks = 0; const prepare = vi.fn(async () => ({ sharedInputs: { sharedMetrics: { providerRequests: { serpApi: 1, dataForSeoSearchVolume: 0 }, providerCosts: { searchVolume: 0 } } } })); const run = vi.fn(async () => ({ requestMetrics: { providerRequests: { dataForSeoTrends: 10 }, providerCosts: { trends: 0.012 } } }))
    const result = await runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true' }, isWindowComplete: vi.fn(async () => checks++ < 4 - pendingCount), prepareShared: prepare, runIngestion: run })
    expect(prepare).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(pendingCount); expect(result.providerSummary.aggregate).toMatchObject({ serpApi: 1, dataForSeoSearchVolume: 0, dataForSeoTrends: pendingCount * 10, dataForSeoCost: pendingCount * 0.012 })
  })
})
