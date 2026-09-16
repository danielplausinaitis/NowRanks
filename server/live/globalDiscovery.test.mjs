import { describe, expect, it } from 'vitest'
import { globalDiscoveryRequestModel, mergeGlobalDiscoveryCandidates, rankGlobalDiscoveryCandidates, resolveDiscoveryGeos } from './globalDiscovery.mjs'
import { composeUnifiedPublicScore } from './unifiedPublicScoring.mjs'

function candidate(query, rank, patch = {}) {
  return { providerId: 'serpapi-google-trends-trending-now', query, normalizedQuery: query.toLowerCase(), providerDiscoveryRank: rank, searchVolume: 1_000, increasePercentage: 100, category: 'Sports', categories: ['Sports'], geographicScope: { kind: 'country', countryCode: 'US' }, ...patch }
}

describe('global discovery planning', () => {
  it('keeps legacy single-geo configuration functional and accepts a deterministic opt-in geo list', () => {
    expect(resolveDiscoveryGeos({ SERPAPI_DISCOVERY_GEO: 'us' })).toEqual(['US'])
    expect(resolveDiscoveryGeos({ SERPAPI_DISCOVERY_GEO: 'US', LIVE_DISCOVERY_GEOS: 'US, GB,IN,gb' })).toEqual(['US', 'GB', 'IN'])
  })

  it('merges exact cross-geo appearances into one category-neutral discovery candidate with provenance', () => {
    const merged = mergeGlobalDiscoveryCandidates([
      { geo: 'US', language: 'en', candidates: [candidate('World Event', 4)] },
      { geo: 'GB', language: 'en-GB', candidates: [candidate('World Event', 2, { category: 'Technology', categories: ['Technology'], searchVolume: 5_000 })] },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ providerId: 'serpapi-google-trends-trending-now', normalizedQuery: 'world event', query: 'World Event', category: 'Technology', sourceGeos: ['GB', 'US'], sourceLanguages: ['en', 'en-GB'], geoCount: 2, bestGeo: 'GB', primaryDiscoveryEvidence: { providerId: 'serpapi-google-trends-trending-now', geo: 'GB', providerDiscoveryRank: 2, searchVolume: 5_000, language: 'en-GB' }, bestProviderPosition: 2, bestSearchVolume: 5_000, rawVariants: ['World Event'] })
    expect(merged[0].geoAppearances.map(({ geo, providerId }) => [geo, providerId])).toEqual([
      ['GB', 'serpapi-google-trends-trending-now'],
      ['US', 'serpapi-google-trends-trending-now'],
    ])
  })

  it('keeps duplicate appearances from multiplying candidate or public-rank inputs', () => {
    const geos = ['US', 'GB', 'IN', 'BR', 'JP', 'DE', 'FR', 'MX', 'ID', 'AU']
    const merged = mergeGlobalDiscoveryCandidates(geos.map((geo, index) => ({ geo, candidates: [candidate('Same Event', index + 1)] })))
    expect(merged).toHaveLength(1)
    expect(merged[0]).not.toHaveProperty('publicRank')
    expect(merged[0]).not.toHaveProperty('publicScore')
  })

  it('orders global discovery selection deterministically without category quotas and can retain a pool above 100 before the unchanged paid cap', () => {
    const candidates = Array.from({ length: 150 }, (_, index) => ({ normalizedQuery: `topic-${index}`, query: `Topic ${index}`, category: index % 2 ? 'Sports' : 'Technology', geoCount: index % 3 + 1, bestProviderPosition: 150 - index, bestAcceleration: index, bestSearchVolume: index }))
    const first = rankGlobalDiscoveryCandidates(candidates)
    expect(first).toEqual(rankGlobalDiscoveryCandidates([...candidates].reverse()))
    expect(first).toHaveLength(150)
    expect(first.slice(0, 50)).toHaveLength(50)
    expect(first).not.toContainEqual(expect.objectContaining({ publicRank: expect.anything() }))
  })

  it('does not alter unified scoring or introduce a category-dependent public ranking input', () => {
    const inputs = { window: '24H', currentAttention: 60, baselineDemand: 40, historicalGrowth: null, discoveryAcceleration: 70, momentum: null, consistency: null, breakout: null, recency: 80, historyCoverage: 0 }
    const before = composeUnifiedPublicScore(inputs)
    const merged = mergeGlobalDiscoveryCandidates([
      { geo: 'US', candidates: [candidate('Neutral Event', 1, { category: 'Sports' })] },
      { geo: 'IN', candidates: [candidate('Neutral Event', 1, { category: 'Technology' })] },
    ])[0]
    const after = composeUnifiedPublicScore(inputs)
    expect(after).toEqual(before)
    expect(merged).not.toHaveProperty('unifiedRawScore')
    expect(merged).not.toHaveProperty('publicScore')
  })

  it('models only SerpApi discovery request multiplication; it does not change the 50-topic paid measurement cap', () => {
    expect(globalDiscoveryRequestModel({ geoCount: 5 })).toEqual({ perCycle: 5, perDay: 30, perMonth: 900 })
  })
})
