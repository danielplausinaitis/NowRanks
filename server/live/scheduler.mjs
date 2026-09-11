import { stableUuid } from '../ingestion/persistence.mjs'
import { resolveLiveIngestionSafetyConfig } from './livePersistence.mjs'

export const LIVE_SCHEDULER_ENABLED_ENV = 'LIVE_SCHEDULER_ENABLED'
export const FIXED_UTC_SLOT_MINUTES = 240
export const FIXED_UTC_SLOT_HOURS = Object.freeze([0, 4, 8, 12, 16, 20])
export const DEFAULT_SCHEDULER_RETRY_LIMIT = 2
export const DEFAULT_SCHEDULER_RETRY_BASE_DELAY_SECONDS = 60
export const DEFAULT_SCHEDULER_STALE_AFTER_MINUTES = 300

const WINDOWS = ['24H', '7D', '30D', '1Y']
const RANGES = { '24H': 'past_day', '7D': 'past_7_days', '30D': 'past_30_days', '1Y': 'past_12_months' }
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])
const NON_RETRYABLE_MESSAGE = /(?:LIVE_[A-Z_]+|ALLOW_LIVE_DATABASE_WRITE|must be|required|invalid|configuration|cost cap|exceeds LIVE_MAX_PROVIDER_COST_USD|unauthori[sz]ed|forbidden|HTTP 4\d\d)/i

export const DATAFORSEO_SEARCH_VOLUME_BULK_REQUEST_COST_USD = 0.09
export const DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD = 0.0012

function bool(value, name, fallback) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function positive(value, name, fallback) {
  const n = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
  return n
}

function boundedInteger(value, name, fallback, { min, max }) {
  const number = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return number
}

function iso(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('Scheduler requires a valid date')
  return date.toISOString()
}

function compactIso(date) { return iso(date).replace('.000Z', 'Z') }
function usd(value) { return Number(value.toFixed(4)) }
function durationMs(startedAt, finishedAt) { return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) }
function defaultSleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

/** Floors a time to one of exactly six UTC cadence boundaries, independent of host timezone. */
export function utcSchedulerSlot(now = new Date()) {
  const timestamp = new Date(iso(now)).getTime()
  return new Date(Math.floor(timestamp / (FIXED_UTC_SLOT_MINUTES * 60_000)) * FIXED_UTC_SLOT_MINUTES * 60_000)
}

/** Strictly later than `now`, including when `now` is precisely a slot boundary. */
export function nextUtcSchedulerSlot(now = new Date()) {
  return new Date(utcSchedulerSlot(now).getTime() + FIXED_UTC_SLOT_MINUTES * 60_000)
}

export function schedulerSlotId(slot) {
  return compactIso(utcSchedulerSlot(slot))
}

export function schedulerCycleId({ slot, window }) {
  if (!WINDOWS.includes(window)) throw new Error(`Unsupported scheduler window: ${window}`)
  return `scheduled:${schedulerSlotId(slot)}:${window}`
}

export function resolveLiveSchedulerConfig(env = process.env) {
  const cohort = resolveLiveIngestionSafetyConfig(env)
  const refreshIntervalMinutes = positive(env.LIVE_REFRESH_INTERVAL_MINUTES, 'LIVE_REFRESH_INTERVAL_MINUTES', FIXED_UTC_SLOT_MINUTES)
  if (refreshIntervalMinutes !== FIXED_UTC_SLOT_MINUTES) throw new Error(`LIVE_REFRESH_INTERVAL_MINUTES must be exactly ${FIXED_UTC_SLOT_MINUTES} for fixed UTC scheduler slots`)
  return {
    enabled: bool(env.LIVE_SCHEDULER_ENABLED, 'LIVE_SCHEDULER_ENABLED', false),
    refreshIntervalMinutes,
    baselineTtlHours: positive(env.LIVE_BASELINE_TTL_HOURS, 'LIVE_BASELINE_TTL_HOURS', 24),
    historyTtlHours: positive(env.LIVE_HISTORY_TTL_HOURS, 'LIVE_HISTORY_TTL_HOURS', 4),
    retryLimit: boundedInteger(env.LIVE_SCHEDULER_RETRY_LIMIT, 'LIVE_SCHEDULER_RETRY_LIMIT', DEFAULT_SCHEDULER_RETRY_LIMIT, { min: 0, max: 5 }),
    retryBaseDelaySeconds: boundedInteger(env.LIVE_SCHEDULER_RETRY_BASE_DELAY_SECONDS, 'LIVE_SCHEDULER_RETRY_BASE_DELAY_SECONDS', DEFAULT_SCHEDULER_RETRY_BASE_DELAY_SECONDS, { min: 1, max: 900 }),
    staleAfterMinutes: boundedInteger(env.LIVE_SCHEDULER_STALE_AFTER_MINUTES, 'LIVE_SCHEDULER_STALE_AFTER_MINUTES', DEFAULT_SCHEDULER_STALE_AFTER_MINUTES, { min: FIXED_UTC_SLOT_MINUTES, max: 1_440 }),
    ...cohort,
    maxProviderCostUsd: env.LIVE_MAX_PROVIDER_COST_USD === undefined || env.LIVE_MAX_PROVIDER_COST_USD === ''
      ? null : positive(env.LIVE_MAX_PROVIDER_COST_USD, 'LIVE_MAX_PROVIDER_COST_USD', 0),
  }
}

export function schedulePlan({ env = process.env, now = new Date() } = {}) {
  const config = resolveLiveSchedulerConfig(env)
  const slot = schedulerSlotId(now)
  const windowCount = WINDOWS.length
  const trendsRequests = config.maxPaidCandidates * windowCount
  const trendsCost = trendsRequests * DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD
  const baselineCost = DATAFORSEO_SEARCH_VOLUME_BULK_REQUEST_COST_USD
  const baselineRefreshFraction = Math.min(1, config.refreshIntervalMinutes / (config.baselineTtlHours * 60))
  const coldCost = trendsCost + baselineCost
  const warmCost = trendsCost
  const steadyCost = trendsCost + baselineCost * baselineRefreshFraction
  const cyclesPerDay = 24 * 60 / config.refreshIntervalMinutes
  const baselineRefreshesPerMonth = Math.min(cyclesPerDay, 24 / config.baselineTtlHours) * 30
  const monthly = (count) => (count * windowCount * DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD * cyclesPerDay * 30) + (baselineCost * baselineRefreshesPerMonth)
  return {
    config,
    cycleSlot: slot,
    nextScheduledUtcRun: compactIso(nextUtcSchedulerSlot(now)),
    utcSlots: FIXED_UTC_SLOT_HOURS,
    windows: WINDOWS.map((window) => ({ window, providerRange: RANGES[window], cycleId: schedulerCycleId({ slot: now, window }) })),
    estimates: {
      windowCount, serpApiRequests: 1, trendsRequests, trendsCostUsd: usd(trendsCost),
      baseline: { coldRequests: 1, warmRequests: 0, coldCostUsd: usd(baselineCost), warmCostUsd: 0, steadyCostUsd: usd(baselineCost * baselineRefreshFraction), requestsAvoidedSteadyState: Number(Math.max(0, 1 - baselineRefreshFraction).toFixed(4)) },
      warmInvocationCostUsd: usd(warmCost), coldCycleCostUsd: usd(coldCost), steadyCycleCostUsd: usd(steadyCost),
      estimatedMonthlyCostUsd: { configuredMaximum: usd(monthly(config.maxPaidCandidates)), candidates10: usd(monthly(10)), candidates50: usd(monthly(50)), candidates100: usd(monthly(100)) },
    },
    writeAuthorized: env.ALLOW_LIVE_DATABASE_WRITE === 'true',
    withinCostCap: config.maxProviderCostUsd === null || coldCost <= config.maxProviderCostUsd,
  }
}

export function isRetryableSchedulerError(error) {
  if (error?.retryable === true) return true
  if (error?.retryable === false) return false
  const status = Number(error?.status ?? error?.statusCode)
  if (Number.isFinite(status)) return status === 408 || status === 425 || status === 429 || status >= 500
  if (RETRYABLE_CODES.has(error?.code)) return true
  return !NON_RETRYABLE_MESSAGE.test(String(error?.message ?? error))
}

function emptyProviderSummary() {
  return { shared: { serpApi: 0, dataForSeoSearchVolume: 0 }, windows: [], aggregate: { serpApi: 0, dataForSeoSearchVolume: 0, dataForSeoTrends: 0, dataForSeoCost: 0 } }
}

/** Keeps the proven per-window ingestion path untouched; the controller supplies locking/retry. */
export async function runScheduledOnce({ env = process.env, now = new Date(), isWindowComplete = async () => false, prepareShared, runIngestion }) {
  const plan = schedulePlan({ env, now })
  if (!plan.config.enabled) throw new Error('LIVE_SCHEDULER_ENABLED=true is required for scheduler execution')
  if (!plan.writeAuthorized) throw new Error('ALLOW_LIVE_DATABASE_WRITE=true is required for scheduler execution')
  if (!plan.withinCostCap) throw new Error('Scheduled cycle exceeds LIVE_MAX_PROVIDER_COST_USD before provider work')
  const completion = await Promise.all(plan.windows.map(async (window) => ({ window, complete: await isWindowComplete(window) })))
  const pending = completion.filter(({ complete }) => !complete).map(({ window }) => window)
  const skipped = completion.filter(({ complete }) => complete).map(({ window }) => window)
  if (pending.length === 0) return { plan, results: [], skipped, providerSummary: emptyProviderSummary() }
  if (typeof prepareShared !== 'function') throw new Error('A shared live input preparer is required')
  if (typeof runIngestion !== 'function') throw new Error('A live ingestion runner is required')
  const executionEnv = { ...env, LIVE_INGEST_DRY_RUN: 'false' }
  const shared = await prepareShared(executionEnv, plan)
  const results = []
  for (const item of pending) results.push(await runIngestion({ ...executionEnv, LIVE_INGEST_CYCLE_ID: item.cycleId, LIVE_INGEST_HISTORY_WINDOW: item.window }, shared))
  const sharedMetrics = shared?.sharedInputs?.sharedMetrics ?? {}
  const windows = results.map((result, index) => ({ window: pending[index].window, trends: result?.requestMetrics?.providerRequests?.dataForSeoTrends ?? 0, trendsCost: result?.requestMetrics?.providerCosts?.trends ?? 0 }))
  const aggregate = { serpApi: sharedMetrics.providerRequests?.serpApi ?? 0, dataForSeoSearchVolume: sharedMetrics.providerRequests?.dataForSeoSearchVolume ?? 0, dataForSeoTrends: windows.reduce((sum, row) => sum + row.trends, 0), dataForSeoCost: usd((sharedMetrics.providerCosts?.searchVolume ?? 0) + windows.reduce((sum, row) => sum + row.trendsCost, 0)) }
  return { plan, results, skipped, providerSummary: { shared: { serpApi: aggregate.serpApi, dataForSeoSearchVolume: aggregate.dataForSeoSearchVolume }, windows, aggregate } }
}

/** Cross-process lease derived from existing ingestion_runs, claimed before provider work. */
export function createIngestionRunSlotGuard({ repository, now = () => new Date(), staleAfterMinutes = DEFAULT_SCHEDULER_STALE_AFTER_MINUTES }) {
  if (!repository?.findRunByIdempotencyKey || !repository?.listRunningLiveIngestionRuns || !repository?.createRun || !repository?.updateRun) throw new Error('Scheduler slot guard requires ingestion-run repository methods')
  if (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes < FIXED_UTC_SLOT_MINUTES) throw new Error('Scheduler stale-after minutes must be at least one scheduler interval')
  const keyFor = (slot) => `live:scheduler-slot:${schedulerSlotId(slot)}`
  const acquireExisting = async (existing, { idempotencyKey, acquiredAt, attempt }) => {
    if (existing?.status === 'succeeded') return { acquired: false, reason: 'duplicate-slot-already-succeeded', idempotencyKey }
    // Never automatically reclaim a running lease: an unusually slow live cycle is
    // safer to report as stale than to overlap with a second paid cycle.
    if (existing?.status === 'running') return { acquired: false, reason: 'skipped-overlap-running-slot', idempotencyKey }
    if (existing?.status === 'failed' || existing?.status === 'partial') return { acquired: false, reason: 'duplicate-slot-previously-failed', idempotencyKey }
    const runId = existing?.run_id ?? stableUuid(`scheduler-slot:${idempotencyKey}`)
    await repository.createRun({ run_id: runId, provider_id: 'nowranks-scheduler', data_mode: 'live', status: 'running', idempotency_key: idempotencyKey, started_at: acquiredAt.toISOString(), records_received: 0, records_accepted: 0, records_rejected: 0 })
    return {
      acquired: true, idempotencyKey, runId, recovered: Boolean(existing), attempt,
      async finish({ status, error = null, finishedAt = now() }) {
        await repository.updateRun(runId, { status, finished_at: iso(finishedAt), error_summary: error ? String(error.message ?? error).slice(0, 1_000) : null })
      },
    }
  }
  return {
    async acquire({ slot, attempt = 0 }) {
      const idempotencyKey = keyFor(slot)
      const acquiredAt = new Date(iso(now()))
      const active = (await repository.listRunningLiveIngestionRuns()).find((run) => /^(?:live:scheduler-slot:|live:serpapi-dataforseo:)/.test(String(run.idempotency_key ?? '')))
      if (active) return { acquired: false, reason: 'skipped-overlap-running-slot', idempotencyKey, activeSlot: active.idempotency_key }
      const existing = await repository.findRunByIdempotencyKey(idempotencyKey)
      try { return await acquireExisting(existing, { idempotencyKey, acquiredAt, attempt }) } catch (error) {
        const concurrent = await repository.findRunByIdempotencyKey(idempotencyKey)
        if (concurrent) return acquireExisting(concurrent, { idempotencyKey, acquiredAt, attempt })
        throw error
      }
    },
  }
}

function diagnostic({ slot, cycleIds, startedAt, finishedAt, status, retryCount, reason = null, error = null, result = null }) {
  return {
    schedulerSlot: slot, cycleIds, startedAt, finishedAt, durationMs: durationMs(startedAt, finishedAt),
    status, success: status === 'succeeded', retryCount,
    skippedOverlap: reason === 'skipped-overlap-running-slot' || reason === 'skipped-overlap-in-process',
    reason, error: error ? String(error.message ?? error) : null, result,
  }
}

/** In-process serialization plus bounded retry; a slot guard extends it across processes/restarts. */
export function createLiveSchedulerController({ env = process.env, now = () => new Date(), executeOnce, slotGuard = null, sleep = defaultSleep, log = () => {} } = {}) {
  if (typeof executeOnce !== 'function') throw new Error('Scheduler controller requires executeOnce')
  const config = resolveLiveSchedulerConfig(env)
  let active = null
  const completedSlots = new Set()
  const runSlot = async ({ slot = now() } = {}) => {
    const slotId = schedulerSlotId(slot)
    const cycleIds = WINDOWS.map((window) => schedulerCycleId({ slot, window }))
    const startedAt = iso(now())
    if (!config.enabled) {
      const event = diagnostic({ slot: slotId, cycleIds, startedAt, finishedAt: iso(now()), status: 'skipped', retryCount: 0, reason: 'scheduler-disabled' })
      log(event); return event
    }
    if (active) {
      const event = diagnostic({ slot: slotId, cycleIds, startedAt, finishedAt: iso(now()), status: 'skipped', retryCount: 0, reason: 'skipped-overlap-in-process' })
      log(event); return event
    }
    if (completedSlots.has(slotId)) {
      const event = diagnostic({ slot: slotId, cycleIds, startedAt, finishedAt: iso(now()), status: 'skipped', retryCount: 0, reason: 'duplicate-slot-in-process' })
      log(event); return event
    }
    active = slotId
    let lease = null
    try {
      if (slotGuard) {
        lease = await slotGuard.acquire({ slot, attempt: 0 })
        if (!lease.acquired) {
          const event = diagnostic({ slot: slotId, cycleIds, startedAt, finishedAt: iso(now()), status: 'skipped', retryCount: 0, reason: lease.reason })
          log(event); return event
        }
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await executeOnce({ slot: new Date(slotId), attempt })
          completedSlots.add(slotId)
          await lease?.finish({ status: 'succeeded', finishedAt: now() })
          const event = diagnostic({ slot: slotId, cycleIds, startedAt, finishedAt: iso(now()), status: 'succeeded', retryCount: attempt, result })
          log(event); return event
        } catch (error) {
          const retryable = isRetryableSchedulerError(error)
          if (!retryable || attempt >= config.retryLimit) {
            await lease?.finish({ status: 'failed', error, finishedAt: now() })
            const event = diagnostic({ slot: slotId, cycleIds, startedAt, finishedAt: iso(now()), status: 'failed', retryCount: attempt, reason: retryable ? 'retry-limit-exhausted' : 'non-retryable-failure', error })
            log(event); return event
          }
          const delayMs = config.retryBaseDelaySeconds * 1_000 * (2 ** attempt)
          log({ schedulerSlot: slotId, status: 'retrying', retryCount: attempt + 1, delayMs, reason: 'retryable-failure', error: String(error.message ?? error) })
          await sleep(delayMs)
        }
      }
    } finally { active = null }
  }
  return {
    config, runSlot,
    state: () => ({ activeSlot: active, completedSlots: [...completedSlots] }),
    startupDiagnostics: () => ({ enabled: config.enabled, cadenceUtcHours: FIXED_UTC_SLOT_HOURS, refreshIntervalMinutes: FIXED_UTC_SLOT_MINUTES, nextScheduledUtcRun: compactIso(nextUtcSchedulerSlot(now())) }),
  }
}

/** Starts the explicit long-running scheduler process. Disabled configuration is inert. */
export function startLiveScheduler({ env = process.env, now = () => new Date(), executeOnce, slotGuard = null, sleep = defaultSleep, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = createLiveSchedulerController({ env, now, executeOnce, slotGuard, sleep, log })
  const startup = controller.startupDiagnostics()
  log({ scheduler: 'live', event: startup.enabled ? 'started' : 'disabled', ...startup })
  if (!startup.enabled) return { ...controller, stop: () => {}, startup }
  let stopped = false
  let timer = null
  const scheduleNext = () => {
    if (stopped) return
    const slot = nextUtcSchedulerSlot(now())
    const delay = Math.max(0, slot.getTime() - new Date(iso(now())).getTime())
    timer = setTimer(() => {
      // Schedule the following boundary immediately, rather than after this cycle
      // completes, so an overrun is recorded as an explicit skipped-overlap event.
      void controller.runSlot({ slot }).catch((error) => log({ schedulerSlot: compactIso(slot), status: 'failed', reason: 'scheduler-controller-error', error: String(error.message ?? error) }))
      scheduleNext()
    }, delay)
  }
  scheduleNext()
  return { ...controller, startup, stop: () => { stopped = true; if (timer) clearTimer(timer) } }
}

export function schedulerHealth({ env = process.env, now = new Date(), runs = [] } = {}) {
  const config = resolveLiveSchedulerConfig(env)
  const scheduledIngestionRuns = runs.filter((run) => String(run?.idempotency_key ?? '').startsWith('live:serpapi-dataforseo:scheduled:'))
  const schedulerSlotRuns = runs.filter((run) => String(run?.idempotency_key ?? '').startsWith('live:scheduler-slot:'))
  const sortNewest = (left, right) => Date.parse(right.finished_at ?? right.started_at ?? 0) - Date.parse(left.finished_at ?? left.started_at ?? 0)
  const latestSuccessfulIngestionRun = scheduledIngestionRuns.filter((run) => run.status === 'succeeded').sort(sortNewest)[0] ?? null
  // A retry-limit failure can happen before any per-window ingestion run exists or
  // reaches `failed`. The scheduler lease is itself an ingestion_runs row, so include
  // that terminal record rather than inventing separate persistent scheduler state.
  const latestFailedIngestionRun = [...scheduledIngestionRuns, ...schedulerSlotRuns]
    .filter((run) => ['failed', 'partial'].includes(run.status)).sort(sortNewest)[0] ?? null
  const latestRunningSchedulerSlot = schedulerSlotRuns.filter((run) => run.status === 'running').sort(sortNewest)[0] ?? null
  const runningStartedAt = Date.parse(latestRunningSchedulerSlot?.started_at)
  const currentSlot = utcSchedulerSlot(now)
  const expectedCompletedSlot = now.getTime() - currentSlot.getTime() >= 60 * 60_000 ? currentSlot : new Date(currentSlot.getTime() - FIXED_UTC_SLOT_MINUTES * 60_000)
  const lastSuccessAt = Date.parse(latestSuccessfulIngestionRun?.finished_at ?? latestSuccessfulIngestionRun?.started_at)
  return {
    config: { enabled: config.enabled, refreshIntervalMinutes: config.refreshIntervalMinutes, retryLimit: config.retryLimit, retryBaseDelaySeconds: config.retryBaseDelaySeconds, staleAfterMinutes: config.staleAfterMinutes },
    intendedUtcSlots: FIXED_UTC_SLOT_HOURS, currentSlot: compactIso(currentSlot), nextScheduledUtcRun: compactIso(nextUtcSchedulerSlot(now)), expectedCompletedSlot: compactIso(expectedCompletedSlot),
    latestSuccessfulIngestionRun, latestFailedIngestionRun, latestRunningSchedulerSlot,
    runningSlotStale: Number.isFinite(runningStartedAt) && now.getTime() - runningStartedAt >= config.staleAfterMinutes * 60_000,
    overdue: !Number.isFinite(lastSuccessAt) || lastSuccessAt < expectedCompletedSlot.getTime(),
  }
}
