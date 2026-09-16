import { describe, expect, it } from 'vitest'
import { composeUnifiedPublicScore } from './unifiedPublicScoring.mjs'
import { mergeGlobalDiscoveryCandidates } from './globalDiscovery.mjs'
import {
  assertCanonicalCurveTargetsCompatible,
  assertStableMeasurementTarget,
  chooseOriginMeasurementTarget,
  globalMeasurementCostModel,
  resolveCommonMeasurementTarget,
} from './measurementGeography.mjs'

describe('global measurement geography planning', () => {
  it('retains merged discovery source geos before measurement planning', () => {
    const merged = mergeGlobalDiscoveryCandidates([
      { geo: 'US', language: 'en', candidates: [{ providerId: 'serpapi-google-trends-trending-now', query: 'World event', normalizedQuery: 'world event', providerDiscoveryRank: 2 }] },
      { geo: 'IN', language: 'hi', candidates: [{ providerId: 'serpapi-google-trends-trending-now', query: 'World event', normalizedQuery: 'world event', providerDiscoveryRank: 1 }] },
    ])[0]
    expect(merged).toMatchObject({ sourceGeos: ['IN', 'US'], sourceLanguages: ['en', 'hi'], geoCount: 2, bestGeo: 'IN', bestProviderPosition: 1 })
  })

  it('chooses a deterministic common target and preserves legacy US reference targeting', () => {
    const legacy = resolveCommonMeasurementTarget({ mode: 'common-reference', locationName: 'United States' })
    expect(legacy).toMatchObject({ mode: 'common-reference', locationName: 'United States', geographicScope: { kind: 'reference-market' } })
    expect(resolveCommonMeasurementTarget({ mode: 'common-reference', locationName: 'United States' })).toEqual(legacy)
    expect(resolveCommonMeasurementTarget({ mode: 'common-global' })).toMatchObject({ mode: 'common-global', geographicScope: { kind: 'global' }, locationName: null, locationCode: null })
  })

  it('chooses an origin location deterministically without depending on source order', () => {
    const first = chooseOriginMeasurementTarget({ sourceGeos: ['US', 'IN'], bestGeo: 'IN' })
    const second = chooseOriginMeasurementTarget({ sourceGeos: ['IN', 'US'], bestGeo: 'IN' })
    expect(first).toEqual(second)
    expect(first.geographicScope).toEqual({ kind: 'country', countryCode: 'IN' })
  })

  it('rejects a silent candidate measurement-geography change across cycles', () => {
    const us = resolveCommonMeasurementTarget({ mode: 'common-reference', locationName: 'United States' })
    const global = resolveCommonMeasurementTarget({ mode: 'common-global' })
    expect(assertStableMeasurementTarget({ previousTarget: us, nextTarget: us })).toEqual(us)
    expect(() => assertStableMeasurementTarget({ previousTarget: us, nextTarget: global })).toThrow(/separate canonical segment/i)
  })

  it('prevents canonical curves from different measurement geographies from being stitched', () => {
    const us = resolveCommonMeasurementTarget({ mode: 'common-reference', locationName: 'United States' })
    const india = chooseOriginMeasurementTarget({ sourceGeos: ['IN'] })
    expect(() => assertCanonicalCurveTargetsCompatible({ existingTarget: us, incomingTarget: india })).toThrow(/separate canonical segment/i)
  })

  it('keeps a common global measurement within the existing 50-topic paid cap', () => {
    const plan = globalMeasurementCostModel({ paidCandidateCount: 50, paidCandidateCap: 50 })
    expect(plan.paidTracking).toEqual({ candidates: 50, cap: 50, withinCap: true })
    expect(plan.candidateGeoPairs).toBe(50)
    expect(plan.trends).toEqual({ perCycle: 10, perDay: 30, perMonth: 900 })
    expect(plan.cost).toMatchObject({ trends: { perCycle: 0.11, perDay: 0.33, perMonth: 9.9 }, baseline: { coldPerCycle: 0.18, perDay: 0.18, perMonth: 5.4 }, coldCycleTotal: 0.29, perDayTotal: 0.51, perMonthTotal: 15.3 })
  })

  it('models source-geo, five-geo, and ten-geo plans without mixing targets in a five-keyword Trends batch', () => {
    const sourceGeo = globalMeasurementCostModel({ candidateGeoPairs: 50, distinctMeasurementGeographies: 5, candidateCountsByMeasurementTarget: [10, 10, 10, 10, 10], baselineRequestCostUsd: 0.09 })
    expect(sourceGeo.trends).toEqual({ perCycle: 10, perDay: 30, perMonth: 900 })
    expect(sourceGeo.cost).toMatchObject({ trends: { perMonth: 9.9 }, baseline: { perMonth: 13.5 }, perMonthTotal: 23.4 })
    const five = globalMeasurementCostModel({ candidateGeoPairs: 250, distinctMeasurementGeographies: 5, candidateCountsByMeasurementTarget: [50, 50, 50, 50, 50], baselineRequestCostUsd: 0.09 })
    expect(five.trends).toEqual({ perCycle: 50, perDay: 150, perMonth: 4500 })
    expect(five.cost).toMatchObject({ trends: { perCycle: 0.55, perDay: 1.65, perMonth: 49.5 }, baseline: { coldPerCycle: 0.45, perDay: 0.45, perMonth: 13.5 }, coldCycleTotal: 1, perDayTotal: 2.1, perMonthTotal: 63 })
    const ten = globalMeasurementCostModel({ candidateGeoPairs: 500, distinctMeasurementGeographies: 10, candidateCountsByMeasurementTarget: Array(10).fill(50), baselineRequestCostUsd: 0.09 })
    expect(ten.cost).toMatchObject({ trends: { perCycle: 1.1, perDay: 3.3, perMonth: 99 }, baseline: { coldPerCycle: 0.9, perDay: 0.9, perMonth: 27 }, coldCycleTotal: 2, perDayTotal: 4.2, perMonthTotal: 126 })
  })

  it('refuses a multi-geo estimate that would silently pool candidates across measurement targets', () => {
    expect(() => globalMeasurementCostModel({ candidateGeoPairs: 50, distinctMeasurementGeographies: 5 })).toThrow(/candidate counts per measurement target/i)
  })

  it('does not alter unified scoring', () => {
    const inputs = { window: '24H', currentAttention: 60, baselineDemand: 40, historicalGrowth: null, discoveryAcceleration: 70, momentum: null, consistency: null, breakout: null, recency: 80, historyCoverage: 0 }
    const before = composeUnifiedPublicScore(inputs)
    globalMeasurementCostModel({ paidCandidateCount: 50 })
    resolveCommonMeasurementTarget({ mode: 'common-global' })
    expect(composeUnifiedPublicScore(inputs)).toEqual(before)
  })
})
