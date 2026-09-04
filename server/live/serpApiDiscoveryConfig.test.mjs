import { describe, expect, it } from 'vitest'
import { buildSerpApiDiscoveryRequestFromEnv } from './serpApiDiscoveryConfig.mjs'

describe('shared SerpApi discovery configuration', () => {
it('gives discovery and shadow consumers the same complete request config', () => {
  const env = {
    SERPAPI_DISCOVERY_GEO: 'US',
    SERPAPI_DISCOVERY_HOURS: '48',
    SERPAPI_DISCOVERY_LANGUAGE: 'en',
    SERPAPI_DISCOVERY_ONLY_ACTIVE: 'false',
    SERPAPI_DISCOVERY_CATEGORY_ID: '18',
    DATAFORSEO_LOCATION_NAME: 'Must not alter SerpApi geography',
  }
  const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(env)
  const shadowRequest = buildSerpApiDiscoveryRequestFromEnv(env)

  expect(discoveryRequest).toEqual(shadowRequest)
  expect(discoveryRequest).toEqual({
    geo: 'US', hours: 48, language: 'en', onlyActive: false, categoryId: 18,
    geographicScope: { kind: 'country', countryCode: 'US' },
  })
})

it('leaves optional settings unset when absent', () => {
  expect(buildSerpApiDiscoveryRequestFromEnv({ SERPAPI_DISCOVERY_GEO: 'AE' })).toEqual({
    geo: 'AE', hours: undefined, language: undefined, onlyActive: undefined, categoryId: undefined,
    geographicScope: { kind: 'country', countryCode: 'AE' },
  })
})

it('rejects ambiguous only-active configuration', () => {
  expect(() => buildSerpApiDiscoveryRequestFromEnv({ SERPAPI_DISCOVERY_GEO: 'US', SERPAPI_DISCOVERY_ONLY_ACTIVE: 'yes' }))
    .toThrow(/SERPAPI_DISCOVERY_ONLY_ACTIVE must be true or false/)
})
})
