import { describe, expect, it } from 'vitest'
import { composeLiveMeasurementSignals } from './liveSignalComposition.mjs'
import { normalizeDataForSeoGlobalSearchVolume, normalizeDataForSeoSearchVolume } from './dataForSeoSearchVolume.mjs'

const retrievedAt = '2026-09-13T12:00:00.000Z'
const globalScope = { kind: 'global' }

function globalResponse(item) {
  return { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [item] }] }] }
}

function normalizeGlobal(item) {
  return normalizeDataForSeoGlobalSearchVolume({ response: globalResponse(item), retrievedAt, geographicScope: globalScope })[0]
}

describe('DataForSEO Clickstream Global Search Volume normalization', () => {
  it('retains a valid worldwide total with a fully valid country distribution', () => {
    const record = normalizeGlobal({ keyword: 'topic', search_volume: 99, country_distribution: [{ country_iso_code: 'IN', search_volume: 70, percentage: 70.7 }, { country_iso_code: 'US', search_volume: 29, percentage: 29.3 }] })
    expect(record).toMatchObject({ availability: 'available', searchVolume: 99, globalSearchVolume: 99, countryDistributionValidCount: 2, countryDistributionSkippedCount: 0, countryDistributionIssues: [] })
    expect(record.countryDistribution).toEqual([{ countryIsoCode: 'IN', searchVolume: 70, percentage: 70.7 }, { countryIsoCode: 'US', searchVolume: 29, percentage: 29.3 }])
  })

  it('keeps a valid worldwide total when one auxiliary country row has no identifier', () => {
    const record = normalizeGlobal({ keyword: 'topic', search_volume: 99, country_distribution: [{ country_iso_code: 'IN', search_volume: 70, percentage: 70 }, { search_volume: 29, percentage: 29 }] })
    expect(record).toMatchObject({ searchVolume: 99, countryDistributionValidCount: 1, countryDistributionSkippedCount: 1, countryDistributionIssues: [{ index: 1, reason: 'missing-country-identifier' }] })
    expect(record.countryDistribution).toEqual([{ countryIsoCode: 'IN', searchVolume: 70, percentage: 70 }])
    expect(JSON.stringify(record.countryDistribution)).not.toContain('Unknown')
  })

  it('accepts an empty optional country distribution without changing the worldwide baseline', () => {
    const record = normalizeGlobal({ keyword: 'topic', search_volume: 99, country_distribution: [] })
    expect(record).toMatchObject({ searchVolume: 99, countryDistribution: [], countryDistributionValidCount: 0, countryDistributionSkippedCount: 0, countryDistributionIssues: [] })
  })

  it('skips malformed auxiliary country rows while preserving valid rows and the worldwide total', () => {
    const record = normalizeGlobal({ keyword: 'topic', search_volume: 99, country_distribution: [{ country_iso_code: 'IN', search_volume: 'invalid', percentage: 70 }, null, { country_iso_code: 'BR', search_volume: 12, percentage: null }] })
    expect(record).toMatchObject({ searchVolume: 99, countryDistributionValidCount: 1, countryDistributionSkippedCount: 2, countryDistributionIssues: [{ index: 0, reason: 'invalid-country-distribution-values' }, { index: 1, reason: 'malformed-country-distribution-entry' }] })
    expect(record.countryDistribution).toEqual([{ countryIsoCode: 'BR', searchVolume: 12, percentage: null }])
  })

  it('keeps a missing worldwide total unavailable instead of converting it to zero', () => {
    const record = normalizeGlobal({ keyword: 'topic', search_volume: null, country_distribution: [{ country_iso_code: 'IN', search_volume: 70, percentage: 70 }] })
    expect(record).toMatchObject({ availability: 'missing', searchVolume: null, globalSearchVolume: null, countryDistributionValidCount: 1 })
  })

  it('does not permit malformed worldwide totals merely because country metadata exists', () => {
    expect(() => normalizeGlobal({ keyword: 'topic', search_volume: '99', country_distribution: [{ country_iso_code: 'IN', search_volume: 70, percentage: 70 }] })).toThrow(/global search volume/i)
  })

  it('keeps the baseline-demand contract used by scoring independent of country diagnostics', () => {
    const baselineDemand = normalizeGlobal({ keyword: 'topic', search_volume: 99, country_distribution: [{ search_volume: 99, percentage: 100 }] })
    const composition = composeLiveMeasurementSignals({
      candidate: { normalizedQuery: 'topic' },
      currentTrendIntensity: { providerId: 'serpapi', searchVolume: 10 },
      baselineDemand,
      historicalTrendShape: { providerId: 'dataforseo-trends', observations: [] },
    })
    expect(composition.signals.baselineDemand).toMatchObject({ providerId: 'dataforseo-clickstream-global-search-volume', searchVolume: 99, availability: 'available' })
  })

  it('leaves the legacy US Google Ads normalization contract unchanged', () => {
    const response = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ keyword: 'topic', search_volume: 99, competition: null, competition_index: null, cpc: null, monthly_searches: null }] }] }
    const [record] = normalizeDataForSeoSearchVolume({ response, retrievedAt, geographicScope: { kind: 'country', countryCode: 'US' } })
    expect(record).toMatchObject({ providerId: 'dataforseo-google-ads-search-volume', searchVolume: 99, availability: 'available', monthlyHistory: null })
    expect(record).not.toHaveProperty('countryDistribution')
  })
})
