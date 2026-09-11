import { DATAFORSEO_SEARCH_VOLUME_BULK_REQUEST_COST_USD, DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD } from './scheduler.mjs'

const WINDOWS = ['24H', '7D', '30D', '1Y']
function round(value) { return Number(value.toFixed(4)) }
function positive(value, label) { if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`); return value }

/** Pure planning only. It never claims a saving until a horizon has a validated vault metric. */
export function planHistoricalVaultCosts({ candidates = 50, refreshIntervalMinutes = 240, baselineTtlHours = 24, historyRefreshHours = { '24H': 4, '7D': 4, '30D': 4, '1Y': 4 }, vaultMatureWindows = [], providerHistoryWindowsCovered = [] } = {}) {
  positive(candidates, 'candidate count'); positive(refreshIntervalMinutes, 'refresh interval'); positive(baselineTtlHours, 'baseline TTL')
  const cyclesPerDay = 1440 / refreshIntervalMinutes
  const mature = new Set(vaultMatureWindows)
  // A vault Growth percentage alone cannot replace Trends: unified scoring still
  // consumes provider momentum/consistency/breakout. Savings require every needed
  // historical feature for that horizon to have a validated vault replacement.
  const providerHistoryCovered = new Set(providerHistoryWindowsCovered)
  const trendsRequestsPerDay = (windows) => windows.reduce((sum, window) => sum + candidates * 24 / positive(historyRefreshHours[window], `history refresh ${window}`), 0)
  const currentTrends = candidates * WINDOWS.length * cyclesPerDay
  const vaultAwareTrends = trendsRequestsPerDay(WINDOWS.filter((window) => !providerHistoryCovered.has(window)))
  const baselinePerDay = 24 / baselineTtlHours
  const currentDaily = currentTrends * DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD + baselinePerDay * DATAFORSEO_SEARCH_VOLUME_BULK_REQUEST_COST_USD
  const vaultDaily = vaultAwareTrends * DATAFORSEO_TRENDS_SINGLE_TOPIC_REQUEST_COST_USD + baselinePerDay * DATAFORSEO_SEARCH_VOLUME_BULK_REQUEST_COST_USD
  return {
    assumptions: { candidates, cyclesPerDay, baselineTtlHours, historyRefreshHours, vaultMatureWindows: [...mature], providerHistoryWindowsCovered: [...providerHistoryCovered] },
    current: { trendsRequestsPerDay: currentTrends, dailyUsd: round(currentDaily), monthlyUsd: round(currentDaily * 30) },
    vaultAware: { trendsRequestsPerDay: vaultAwareTrends, dailyUsd: round(vaultDaily), monthlyUsd: round(vaultDaily * 30) },
    avoided: { trendsRequestsPerDay: currentTrends - vaultAwareTrends, dailyUsd: round(currentDaily - vaultDaily), monthlyUsd: round((currentDaily - vaultDaily) * 30) },
  }
}
