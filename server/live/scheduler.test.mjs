import { describe, expect, it, vi } from 'vitest'
import { createIngestionRunSlotGuard, createLiveSchedulerController, dueHorizonJobs, FIXED_UTC_SLOT_HOURS, HORIZON_UTC_HOURS, nextUtcSchedulerSlot, runScheduledOnce, schedulePlan, schedulerCycleId, schedulerHealth, startLiveScheduler, utcSchedulerSlot } from './scheduler.mjs'
import { collectLiveSharedInputs } from './liveIngestionPipeline.mjs'
import { baselineCacheKey } from './baselineCache.mjs'
describe('live scheduler core', () => {
  it('uses the exact UTC production cadence without provider or database I/O', () => {
    expect(HORIZON_UTC_HOURS).toEqual({ '24H': [0, 4, 8, 12, 16, 20], '7D': [0, 8, 16], '30D': [0], '1Y': [0] })
    expect(dueHorizonJobs({ slot: new Date('2026-09-04T04:00:00Z') }).map((x) => x.window)).toEqual(['24H'])
    expect(dueHorizonJobs({ slot: new Date('2026-09-04T08:00:00Z') }).map((x) => x.window)).toEqual(['24H', '7D'])
    expect(dueHorizonJobs({ slot: new Date('2026-09-05T00:00:00Z') }).map((x) => x.window)).toEqual(['24H', '7D', '30D', '1Y'])
  })
  it('reports the daily shared dependency and quota envelope', () => {
    const plan = schedulePlan({ env: { LIVE_INGEST_CANDIDATE_LIMIT: '10' }, now: new Date('2026-09-05T00:00:00Z') })
    expect(plan.windows.map((x) => x.window)).toEqual(['24H', '7D', '30D', '1Y'])
    expect(plan.estimates.daily).toEqual(expect.objectContaining({ discoveryCycles: 1, serpApiRequests: 5, estimatedMonthlySerpApiRequests: 150, baselineRefreshes: 1, horizonRefreshes: { '24H': 6, '7D': 3, '30D': 1, '1Y': 1 } }))
    expect(plan.estimates).toMatchObject({ serpApiRequests: 5, adaptive7dOverflow: { maximumAdditionalCandidates: 0, triggeredOnly: true } })
    expect(schedulePlan({ now: new Date('2026-09-05T04:00:00Z') })).toMatchObject({ discoveryDue: false, estimates: { serpApiRequests: 0, baseline: { coldRequests: 0 } } })
  })
  it('cannot bypass the live write gate or cost cap', async () => { const prepare = vi.fn(); const run = vi.fn(); await expect(runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true' }, now: new Date('2026-09-05T00:00:00Z'), prepareShared: prepare, runIngestion: run })).rejects.toThrow('ALLOW_LIVE_DATABASE_WRITE'); await expect(runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true', LIVE_MAX_PROVIDER_COST_USD: '0.001' }, now: new Date('2026-09-05T00:00:00Z'), prepareShared: prepare, runIngestion: run })).rejects.toThrow('exceeds'); expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled() })
  it('prepares one shared dependency and invokes only due horizons', async () => { const shared = { sharedInputs: { sharedMetrics: { providerRequests: {}, providerCosts: {} } }, repository: {} }; const prepare = vi.fn(async () => shared); const run = vi.fn(async (env, received) => ({ cycle: env.LIVE_INGEST_CYCLE_ID, window: env.LIVE_INGEST_HISTORY_WINDOW, received, requestMetrics: { providerRequests: {}, providerCosts: {} } })); const result = await runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true' }, now: new Date('2026-09-05T08:00:00Z'), prepareShared: prepare, runIngestion: run }); expect(prepare).toHaveBeenCalledTimes(1); expect(result.results.map((x) => x.window)).toEqual(['24H', '7D']); expect(result.results.every((x) => x.received === shared)).toBe(true); expect(run.mock.calls.every(([env]) => env.LIVE_INGEST_DRY_RUN === 'false')).toBe(true) })
  it('resolves discovery and fresh baseline cache exactly once for the shared slot cohort', async () => {
    const candidates = [{ query: 'One', normalizedQuery: 'one', category: 'Technology', searchVolume: 1 }, { query: 'Two', normalizedQuery: 'two', category: 'Technology', searchVolume: 1 }]
    const request = { locationCode: 2840 }
    const discover = vi.fn(async () => candidates)
    const list = vi.fn(async ({ cacheKeys }) => cacheKeys.map((cache_key, index) => ({ cache_key, availability: 'available', search_volume: index, monthly_history: [], retrieved_at: '2099-01-01T00:00:00Z' })))
    const lookup = vi.fn()
    const shared = await collectLiveSharedInputs({ candidateLimit: 10, discoveryRequest: { geographicScope: { kind: 'country', countryCode: 'US' } }, volumeRequest: request, discoveryClient: { discover }, volumeClient: { lookup }, baselineCacheRepository: { listLiveBaselineDemandCache: list } })
    expect(discover).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledTimes(1); expect(lookup).not.toHaveBeenCalled(); expect(shared.candidates).toEqual(expect.arrayContaining(candidates.map((candidate) => expect.objectContaining(candidate)))); expect(list).toHaveBeenCalledWith({ cacheKeys: candidates.map((candidate) => baselineCacheKey(candidate.normalizedQuery, request)) })
  })
  it('skips all completed due jobs before shared inputs or external work', async () => {
    const prepare = vi.fn(); const run = vi.fn()
    const result = await runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true' }, now: new Date('2026-09-05T00:00:00Z'), isWindowComplete: vi.fn(async () => true), prepareShared: prepare, runIngestion: run })
    expect(result.skipped).toHaveLength(4); expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(result.providerSummary.aggregate).toEqual({ serpApi: 0, dataForSeoSearchVolume: 0, dataForSeoTrends: 0, dataForSeoCost: 0 })
  })
  it('runs unrelated due horizons even when one fails', async () => {
    const run = vi.fn(async (env) => { if (env.LIVE_INGEST_HISTORY_WINDOW === '7D') throw new Error('7D failed'); return { requestMetrics: { providerRequests: {}, providerCosts: {} } } })
    await expect(runScheduledOnce({ env: { LIVE_SCHEDULER_ENABLED: 'true', ALLOW_LIVE_DATABASE_WRITE: 'true' }, now: new Date('2026-09-05T08:00:00Z'), prepareShared: async () => ({ sharedInputs: { sharedMetrics: { providerRequests: {}, providerCosts: {} } } }), runIngestion: run })).rejects.toThrow(/7D failed/)
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('uses only the exact fixed UTC 00/04/08/12/16/20 cadence and exposes the next slot', () => {
    expect(FIXED_UTC_SLOT_HOURS).toEqual([0, 4, 8, 12, 16, 20])
    expect(utcSchedulerSlot(new Date('2026-09-04T10:12:00Z')).toISOString()).toBe('2026-09-04T08:00:00.000Z')
    expect(nextUtcSchedulerSlot(new Date('2026-09-04T08:00:00Z')).toISOString()).toBe('2026-09-04T12:00:00.000Z')
    expect(schedulePlan({ now: new Date('2026-09-04T23:59:59Z') }).nextScheduledUtcRun).toBe('2026-09-05T00:00:00Z')
    expect(() => schedulePlan({ env: { LIVE_REFRESH_INTERVAL_MINUTES: '60' } })).toThrow(/exactly 240/)
  })
  it('keeps Google Trends on an independently configurable eight-hour cadence', () => {
    expect(schedulePlan({ env: {} }).config.googleTrendsRefreshMinutes).toBe(480)
    expect(schedulePlan({ env: { LIVE_GOOGLE_TRENDS_REFRESH_MINUTES: '240' } }).config.googleTrendsRefreshMinutes).toBe(240)
  })
  it('keeps the long-running scheduler inert by default while reporting clean startup diagnostics', () => {
    const executeOnce = vi.fn()
    const setTimer = vi.fn()
    const scheduler = startLiveScheduler({ env: {}, executeOnce, setTimer, now: () => new Date('2026-09-04T10:12:00Z') })
    expect(scheduler.startup).toEqual({ enabled: false, cadenceUtcHours: [0, 4, 8, 12, 16, 20], refreshIntervalMinutes: 240, nextScheduledUtcRun: '2026-09-04T12:00:00Z' })
    expect(executeOnce).not.toHaveBeenCalled(); expect(setTimer).not.toHaveBeenCalled()
  })
  it('does not execute a completed slot twice and retains deterministic window cycle IDs', async () => {
    const executeOnce = vi.fn(async () => ({ ok: true }))
    const controller = createLiveSchedulerController({ env: { LIVE_SCHEDULER_ENABLED: 'true' }, executeOnce })
    const slot = new Date('2026-09-04T12:00:00Z')
    const first = await controller.runSlot({ slot })
    const second = await controller.runSlot({ slot })
    expect(first).toMatchObject({ status: 'succeeded', schedulerSlot: '2026-09-04T12:00:00Z', retryCount: 0 })
    expect(second).toMatchObject({ status: 'skipped', reason: 'duplicate-slot-in-process' })
    expect(executeOnce).toHaveBeenCalledTimes(1)
    expect(first.cycleIds).toEqual([schedulerCycleId({ slot, window: '24H' })])
  })
  it('does not overlap a running slot and emits an explicit skip reason', async () => {
    let release
    const executeOnce = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const controller = createLiveSchedulerController({ env: { LIVE_SCHEDULER_ENABLED: 'true' }, executeOnce })
    const first = controller.runSlot({ slot: new Date('2026-09-04T00:00:00Z') })
    const overlapping = await controller.runSlot({ slot: new Date('2026-09-04T04:00:00Z') })
    expect(overlapping).toMatchObject({ status: 'skipped', reason: 'skipped-overlap-in-process', skippedOverlap: true })
    release({ ok: true })
    await expect(first).resolves.toMatchObject({ status: 'succeeded' })
    expect(executeOnce).toHaveBeenCalledTimes(1)
  })
  it('retries transient failures with bounded exponential backoff while retaining the same slot identity', async () => {
    const sleep = vi.fn(async () => {})
    const executeOnce = vi.fn().mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })).mockResolvedValueOnce({ ok: true })
    const controller = createLiveSchedulerController({ env: { LIVE_SCHEDULER_ENABLED: 'true', LIVE_SCHEDULER_RETRY_BASE_DELAY_SECONDS: '2' }, executeOnce, sleep })
    const result = await controller.runSlot({ slot: new Date('2026-09-04T08:00:00Z') })
    expect(result).toMatchObject({ status: 'succeeded', retryCount: 1, schedulerSlot: '2026-09-04T08:00:00Z' })
    expect(executeOnce).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledWith(2_000)
  })
  it('does not loop on configuration failures and stops after the configured retry limit for transient failures', async () => {
    const nonRetryable = vi.fn(async () => { throw new Error('ALLOW_LIVE_DATABASE_WRITE=true is required') })
    const first = await createLiveSchedulerController({ env: { LIVE_SCHEDULER_ENABLED: 'true' }, executeOnce: nonRetryable }).runSlot({ slot: new Date('2026-09-04T08:00:00Z') })
    expect(first).toMatchObject({ status: 'failed', retryCount: 0, reason: 'non-retryable-failure' }); expect(nonRetryable).toHaveBeenCalledTimes(1)
    const transient = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
    const second = await createLiveSchedulerController({ env: { LIVE_SCHEDULER_ENABLED: 'true', LIVE_SCHEDULER_RETRY_LIMIT: '2' }, executeOnce: transient, sleep: async () => {} }).runSlot({ slot: new Date('2026-09-04T08:00:00Z') })
    expect(second).toMatchObject({ status: 'failed', retryCount: 2, reason: 'retry-limit-exhausted' }); expect(transient).toHaveBeenCalledTimes(3)
  })
  it('uses an ingestion-runs lease to skip a slot already held by another scheduler process before provider work', async () => {
    const rows = new Map([['live:scheduler-slot:2026-09-04T16:00:00Z', { run_id: 'lease', status: 'running', started_at: '2026-09-04T16:01:00Z' }]])
    const repository = {
      findRunByIdempotencyKey: vi.fn(async (key) => rows.get(key) ?? null),
      listRunningLiveIngestionRuns: vi.fn(async () => [...rows.values()]),
      createRun: vi.fn(async (row) => rows.set(row.idempotency_key, row)),
      updateRun: vi.fn(),
    }
    const executeOnce = vi.fn(async () => ({ ok: true }))
    const controller = createLiveSchedulerController({ env: { LIVE_SCHEDULER_ENABLED: 'true' }, now: () => new Date('2026-09-04T16:05:00Z'), slotGuard: createIngestionRunSlotGuard({ repository, now: () => new Date('2026-09-04T16:05:00Z') }), executeOnce })
    const result = await controller.runSlot({ slot: new Date('2026-09-04T16:00:00Z') })
    expect(result).toMatchObject({ status: 'skipped', reason: 'skipped-overlap-running-slot', skippedOverlap: true })
    expect(executeOnce).not.toHaveBeenCalled(); expect(repository.createRun).not.toHaveBeenCalled()
  })
  it('reports read-only scheduler health, including the latest success/failure and overdue state', () => {
    const health = schedulerHealth({ now: new Date('2026-09-04T12:30:00Z'), runs: [
      { idempotency_key: 'live:serpapi-dataforseo:scheduled:2026-09-04T08:00:00Z:24H:v2', status: 'succeeded', started_at: '2026-09-04T08:00:00Z', finished_at: '2026-09-04T08:08:00Z' },
      { idempotency_key: 'live:serpapi-dataforseo:scheduled:2026-09-04T04:00:00Z:7D:v2', status: 'failed', started_at: '2026-09-04T04:00:00Z', finished_at: '2026-09-04T04:01:00Z' },
    ] })
    expect(health).toMatchObject({ intendedUtcSlots: [0, 4, 8, 12, 16, 20], currentSlot: '2026-09-04T12:00:00Z', nextScheduledUtcRun: '2026-09-04T16:00:00Z', overdue: false, runningSlotStale: false })
    expect(health.latestSuccessfulIngestionRun?.status).toBe('succeeded')
    expect(health.latestFailedIngestionRun?.status).toBe('failed')
    expect(schedulerHealth({ now: new Date('2026-09-04T13:30:00Z'), runs: [] }).overdue).toBe(true)
    expect(schedulerHealth({ now: new Date('2026-09-04T13:30:00Z'), runs: [{ idempotency_key: 'live:scheduler-slot:2026-09-04T08:00:00Z', status: 'running', started_at: '2026-09-04T08:00:00Z' }] }).runningSlotStale).toBe(true)
  })
  it('exposes a retry-limit scheduler lease as the latest failed run without hiding success or inventing failures', () => {
    const success = { run_id: 'success', idempotency_key: 'live:serpapi-dataforseo:scheduled:2026-09-04T12:00:00Z:24H:v2', status: 'succeeded', started_at: '2026-09-04T12:00:00Z', finished_at: '2026-09-04T12:05:00Z' }
    const retryExhausted = { run_id: 'lease-failure', idempotency_key: 'live:scheduler-slot:2026-09-04T16:00:00Z', status: 'failed', started_at: '2026-09-04T16:00:00Z', finished_at: '2026-09-04T16:03:00Z', error_summary: 'timeout' }
    const health = schedulerHealth({ now: new Date('2026-09-04T16:04:00Z'), runs: [success, retryExhausted] })
    expect(health.latestSuccessfulIngestionRun).toEqual(success)
    expect(health.latestFailedIngestionRun).toEqual(retryExhausted)
    expect(health.latestRunningSchedulerSlot).toBeNull()
    expect(schedulerHealth({ now: new Date('2026-09-04T16:04:00Z'), runs: [success] }).latestFailedIngestionRun).toBeNull()
  })
})
