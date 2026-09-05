export const LIVE_SCHEDULER_ENABLED_ENV = 'LIVE_SCHEDULER_ENABLED'
const WINDOWS = ['24H', '7D', '30D', '1Y']
const RANGES = { '24H': 'past_day', '7D': 'past_7_days', '30D': 'past_30_days', '1Y': 'past_12_months' }
export const DATAFORSEO_SEARCH_VOLUME_BULK_REQUEST_COST_USD = 0.09
export const DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD = 0.0012
function bool(value, name, fallback) { if (value === undefined || value === '') return fallback; if (value === 'true') return true; if (value === 'false') return false; throw new Error(`${name} must be true or false`) }
function positive(value, name, fallback) { const n = value === undefined || value === '' ? fallback : Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`); return n }
function usd(value) { return Number(value.toFixed(4)) }
export function resolveLiveSchedulerConfig(env = process.env) {
  const cohort = resolveLiveIngestionSafetyConfig(env)
  return { enabled: bool(env.LIVE_SCHEDULER_ENABLED, 'LIVE_SCHEDULER_ENABLED', false), refreshIntervalMinutes: positive(env.LIVE_REFRESH_INTERVAL_MINUTES, 'LIVE_REFRESH_INTERVAL_MINUTES', 240), baselineTtlHours: positive(env.LIVE_BASELINE_TTL_HOURS, 'LIVE_BASELINE_TTL_HOURS', 24), historyTtlHours: positive(env.LIVE_HISTORY_TTL_HOURS, 'LIVE_HISTORY_TTL_HOURS', 4), ...cohort, maxProviderCostUsd: env.LIVE_MAX_PROVIDER_COST_USD === undefined || env.LIVE_MAX_PROVIDER_COST_USD === '' ? null : positive(env.LIVE_MAX_PROVIDER_COST_USD, 'LIVE_MAX_PROVIDER_COST_USD', 0) }
}
export function schedulePlan({ env = process.env, now = new Date() } = {}) {
  const config = resolveLiveSchedulerConfig(env); const slot = new Date(Math.floor(now.getTime() / (config.refreshIntervalMinutes * 60000)) * config.refreshIntervalMinutes * 60000).toISOString().replace('.000Z', 'Z')
  const windowCount = WINDOWS.length
  const trendsRequests = config.maxPaidCandidates * windowCount
  // Each window currently runs full discovery and Trends retrieval. Baseline targeting is shared,
  // so the first cold window refreshes one bulk cache entry cohort for the later windows to reuse.
  const trendsCost = trendsRequests * DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD
  const baselineCost = DATAFORSEO_SEARCH_VOLUME_BULK_REQUEST_COST_USD
  const baselineRefreshFraction = Math.min(1, config.refreshIntervalMinutes / (config.baselineTtlHours * 60))
  const coldCost = trendsCost + baselineCost
  const warmCost = trendsCost
  const steadyCost = trendsCost + baselineCost * baselineRefreshFraction
  const cyclesPerDay = 24 * 60 / config.refreshIntervalMinutes
  const baselineRefreshesPerMonth = Math.min(cyclesPerDay, 24 / config.baselineTtlHours) * 30
  const monthly = (count) => (count * windowCount * DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD * cyclesPerDay * 30) + (baselineCost * baselineRefreshesPerMonth)
  return { config, cycleSlot: slot, windows: WINDOWS.map((window) => ({ window, providerRange: RANGES[window], cycleId: `scheduled:${slot}:${window}` })), estimates: { windowCount, serpApiRequests: 1, trendsRequests, trendsCostUsd: usd(trendsCost), baseline: { coldRequests: 1, warmRequests: 0, coldCostUsd: usd(baselineCost), warmCostUsd: 0, steadyCostUsd: usd(baselineCost * baselineRefreshFraction), requestsAvoidedSteadyState: Number(Math.max(0, 1 - baselineRefreshFraction).toFixed(4)) }, warmInvocationCostUsd: usd(warmCost), coldCycleCostUsd: usd(coldCost), steadyCycleCostUsd: usd(steadyCost), estimatedMonthlyCostUsd: { configuredMaximum: usd(monthly(config.maxPaidCandidates)), candidates10: usd(monthly(10)), candidates50: usd(monthly(50)), candidates100: usd(monthly(100)) } }, writeAuthorized: env.ALLOW_LIVE_DATABASE_WRITE === 'true', withinCostCap: config.maxProviderCostUsd === null || coldCost <= config.maxProviderCostUsd }
}
export async function runScheduledOnce({ env = process.env, now = new Date(), isWindowComplete = async () => false, prepareShared, runIngestion }) {
  const plan = schedulePlan({ env, now })
  if (!plan.config.enabled) throw new Error('LIVE_SCHEDULER_ENABLED=true is required for scheduler execution')
  if (!plan.writeAuthorized) throw new Error('ALLOW_LIVE_DATABASE_WRITE=true is required for scheduler execution')
  if (!plan.withinCostCap) throw new Error('Scheduled cycle exceeds LIVE_MAX_PROVIDER_COST_USD before provider work')
  const completion = await Promise.all(plan.windows.map(async (window) => ({ window, complete: await isWindowComplete(window) })))
  const pending = completion.filter(({ complete }) => !complete).map(({ window }) => window)
  const skipped = completion.filter(({ complete }) => complete).map(({ window }) => window)
  if (pending.length === 0) return { plan, results: [], skipped, providerSummary: { shared: { serpApi: 0, dataForSeoSearchVolume: 0 }, windows: [], aggregate: { serpApi: 0, dataForSeoSearchVolume: 0, dataForSeoTrends: 0, dataForSeoCost: 0 } } }
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
import { resolveLiveIngestionSafetyConfig } from './livePersistence.mjs'
