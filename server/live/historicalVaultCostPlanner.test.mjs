import { describe, expect, it } from 'vitest'
import { planHistoricalVaultCosts } from './historicalVaultCostPlanner.mjs'

describe('historical vault cost planner', () => {
  it('does not claim a saving from Growth maturity alone and requires all provider-history features to be covered', () => {
    const current = planHistoricalVaultCosts({ candidates: 20, vaultMatureWindows: [] })
    const growthOnly = planHistoricalVaultCosts({ candidates: 20, vaultMatureWindows: ['24H'] })
    const featureComplete = planHistoricalVaultCosts({ candidates: 20, vaultMatureWindows: ['24H'], providerHistoryWindowsCovered: ['24H'] })
    expect(current.avoided).toEqual({ trendsRequestsPerDay: 0, dailyUsd: 0, monthlyUsd: 0 })
    expect(growthOnly.avoided).toEqual(current.avoided)
    expect(featureComplete.avoided.trendsRequestsPerDay).toBeGreaterThan(0)
    expect(featureComplete.vaultAware.dailyUsd).toBeLessThan(featureComplete.current.dailyUsd)
  })
})
