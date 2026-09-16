import { describe, expect, it, vi } from 'vitest'
import { normalizeDataForSeoGlobalSearchVolume } from './dataForSeoSearchVolume.mjs'
import { collectLiveSharedInputs } from './liveIngestionPipeline.mjs'
import { mapSearchVolumeRecordsToCandidates, prepareSearchVolumeKeyword, prepareSearchVolumeLookups, sanitizeSearchVolumeKeyword, searchVolumeKeywordWordCount } from './searchVolumeKeyword.mjs'

const scope = { kind: 'global' }
const retrievedAt = '2026-09-13T12:00:00.000Z'
const longQuery = 'How to watch the complete international championship opening ceremony live online'

function candidate(query, extra = {}) {
  return {
    query,
    normalizedQuery: query.toLocaleLowerCase('en-US'),
    category: 'Technology', searchVolume: 100, increasePercentage: 20, providerDiscoveryRank: 1,
    retrievedAt, geographicScope: scope,
    ...extra,
  }
}

function globalResponse(keywords) {
  return {
    status_code: 20000,
    tasks: [{ status_code: 20000, result: [{ items: keywords.map((keyword, index) => ({ keyword, search_volume: 100 + index, country_distribution: [] })) }] }],
  }
}

describe('Search Volume transport-only provider keywords', () => {
  it('leaves a canonical query of ten words or fewer unchanged', () => {
    const item = candidate('Apple iPhone 17 launch event live coverage')
    const prepared = prepareSearchVolumeKeyword(item)
    expect(prepared).toMatchObject({ canonicalQuery: item.query, selectedVariant: item.query, providerKeyword: item.query, keywordShortened: false, keywordSanitized: false, sanitizationReason: [], shorteningReason: 'canonical-within-provider-limit' })
  })

  it.each([
    ['en dash', 'rb leipzig – hsv', 'rb leipzig hsv', 'unicode-dash-to-space'],
    ['em dash', 'rb leipzig — hsv', 'rb leipzig hsv', 'unicode-dash-to-space'],
    ['unicode minus', 'rb leipzig − hsv', 'rb leipzig hsv', 'unicode-dash-to-space'],
    ['curly apostrophe', 'O’Connor transfer news', "O'Connor transfer news", 'curly-apostrophe-to-ascii'],
    ['curly double quotes', '“New” transfer news', 'New transfer news', 'curly-double-quote-removed'],
    ['non-breaking spaces', 'rb\u00a0leipzig\u00a0hsv', 'rb leipzig hsv', 'non-breaking-space-to-space'],
    ['repeated spaces', 'rb   leipzig    hsv', 'rb leipzig hsv', 'whitespace-collapsed'],
    ['leading and trailing punctuation', '--- rb leipzig hsv !!!', 'rb leipzig hsv', 'edge-punctuation-trimmed'],
  ])('sanitizes %s only for the provider transport', (_label, canonical, expected, reason) => {
    const prepared = prepareSearchVolumeKeyword(candidate(canonical))
    expect(prepared.canonicalQuery).toBe(canonical)
    expect(prepared.selectedVariant).toBe(canonical)
    expect(prepared.providerKeyword).toBe(expected)
    expect(prepared.keywordSanitized).toBe(true)
    expect(prepared.sanitizationReason).toContain(reason)
    expect(prepared.providerKeyword).not.toMatch(/[–—−‘’“”\u00a0]/u)
  })

  it('removes unsupported symbols conservatively while retaining provider-compatible text', () => {
    expect(sanitizeSearchVolumeKeyword('ACME™ & Sons / 2026').providerKeyword).toBe('ACME and Sons 2026')
  })

  it('prefers a coherent raw discovery variant under the limit without mutating the canonical topic', () => {
    const item = candidate(longQuery, { rawVariants: ['International championship opening ceremony live', longQuery] })
    const prepared = prepareSearchVolumeKeyword(item)
    expect(prepared).toMatchObject({ canonicalQuery: longQuery, providerKeyword: 'International championship opening ceremony live', keywordShortened: true, shorteningReason: 'raw-discovery-variant-within-provider-limit' })
    expect(searchVolumeKeywordWordCount(prepared.providerKeyword)).toBeLessThanOrEqual(10)
    expect(item.query).toBe(longQuery)
  })

  it('shortens deterministically with a subject-term fallback when no short raw variant exists', () => {
    const item = candidate('The complete official guide to the most anticipated international technology conference keynote')
    const first = prepareSearchVolumeKeyword(item)
    const second = prepareSearchVolumeKeyword(item)
    expect(first).toEqual(second)
    expect(first.canonicalQuery).toBe(item.query)
    expect(first.keywordShortened).toBe(true)
    expect(first.shorteningReason).toBe('fallback-remove-non-subject-words')
    expect(searchVolumeKeywordWordCount(first.providerKeyword)).toBeLessThanOrEqual(10)
  })

  it('keeps distinct candidate identities when their provider keywords collide and maps the response to both canonicals', () => {
    const left = candidate('Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda one')
    const right = candidate('Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda two')
    const prepared = prepareSearchVolumeLookups([left, right])
    expect(prepared.providerKeywords).toEqual(['Alpha beta gamma delta epsilon zeta eta theta iota kappa'])
    const records = mapSearchVolumeRecordsToCandidates({
      records: [{ providerId: 'global', query: prepared.providerKeywords[0], normalizedQuery: prepared.providerKeywords[0].toLowerCase(), availability: 'available', searchVolume: 42, monthlyHistory: null, provenance: {} }],
      preparations: prepared.preparations, providerId: 'global', retrievedAt, geographicScope: scope,
    })
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.query)).toEqual([left.query, right.query])
    expect(records.map((record) => record.normalizedQuery)).toEqual([left.normalizedQuery, right.normalizedQuery])
    expect(records.map((record) => record.searchVolume)).toEqual([42, 42])
  })

  it('keeps an unreturned provider keyword missing rather than fabricating a baseline', () => {
    const item = candidate(longQuery)
    const prepared = prepareSearchVolumeLookups([item])
    const [record] = mapSearchVolumeRecordsToCandidates({ records: [], preparations: prepared.preparations, providerId: 'global', retrievedAt, geographicScope: scope })
    expect(record).toMatchObject({ query: item.query, normalizedQuery: item.normalizedQuery, availability: 'missing', searchVolume: null })
  })

  it('uses transport keywords in the global pipeline while retaining canonical baseline rows and diagnostics', async () => {
    const long = candidate(longQuery, { rawVariants: ['International championship opening ceremony live'] })
    const short = candidate('Short discovery topic', { providerDiscoveryRank: 2 })
    const lookup = vi.fn(async ({ keywords }) => ({ response: globalResponse(keywords), retrievedAt }))
    const volumeClient = { providerId: 'dataforseo-clickstream-global-search-volume', normalize: normalizeDataForSeoGlobalSearchVolume, lookup }
    const shared = await collectLiveSharedInputs({ discoveryLimit: 50, maxPaidCandidates: 50, discoveryRequest: { geographicScope: scope }, volumeRequest: { measurementMode: 'global', providerId: volumeClient.providerId, geographicScope: scope }, discoveryClient: { discover: vi.fn(async () => [long, short]) }, volumeClient })
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ keywords: ['International championship opening ceremony live', short.query] }))
    expect(shared.volumes.map((record) => record.query)).toEqual([long.query, short.query])
    expect(shared.volumes[0].providerKeywordDiagnostics).toMatchObject({ canonicalQuery: long.query, selectedVariant: 'International championship opening ceremony live', providerKeyword: 'International championship opening ceremony live', keywordShortened: true, keywordSanitized: false })
  })

  it('sends the en-dash regression case as a sanitized global provider keyword while preserving its canonical baseline row', async () => {
    const rb = candidate('rb leipzig – hsv')
    const other = candidate('Short discovery topic', { providerDiscoveryRank: 2 })
    const lookup = vi.fn(async ({ keywords }) => ({ response: globalResponse(keywords), retrievedAt }))
    const volumeClient = { providerId: 'dataforseo-clickstream-global-search-volume', normalize: normalizeDataForSeoGlobalSearchVolume, lookup }
    const shared = await collectLiveSharedInputs({ discoveryLimit: 50, maxPaidCandidates: 50, discoveryRequest: { geographicScope: scope }, volumeRequest: { measurementMode: 'global', providerId: volumeClient.providerId, geographicScope: scope }, discoveryClient: { discover: vi.fn(async () => [rb, other]) }, volumeClient })
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ keywords: ['rb leipzig hsv', other.query] }))
    expect(shared.volumes[0]).toMatchObject({ query: 'rb leipzig – hsv', normalizedQuery: 'rb leipzig – hsv', providerKeywordDiagnostics: { providerKeyword: 'rb leipzig hsv', keywordSanitized: true, sanitizationReason: expect.arrayContaining(['unicode-dash-to-space']) } })
  })

  it('uses the same safe transport preparation for the legacy US pipeline without changing its baseline contract', async () => {
    const long = candidate('rb leipzig – hsv', { geographicScope: { kind: 'country', countryCode: 'US' } })
    const short = candidate('Short discovery topic', { providerDiscoveryRank: 2, geographicScope: { kind: 'country', countryCode: 'US' } })
    const lookup = vi.fn(async ({ keywords }) => ({ response: globalResponse(keywords), retrievedAt }))
    const normalize = ({ response, retrievedAt: at, geographicScope }) => normalizeDataForSeoGlobalSearchVolume({ response, retrievedAt: at, geographicScope: { kind: 'global' } }).map((row) => ({ ...row, providerId: 'dataforseo-google-ads-search-volume', geographicScope }))
    const volumeClient = { providerId: 'dataforseo-google-ads-search-volume', normalize, lookup }
    const usScope = { kind: 'country', countryCode: 'US' }
    const shared = await collectLiveSharedInputs({ discoveryLimit: 50, maxPaidCandidates: 50, discoveryRequest: { geographicScope: usScope }, volumeRequest: { providerId: volumeClient.providerId, geographicScope: usScope, locationCode: 2840 }, discoveryClient: { discover: vi.fn(async () => [long, short]) }, volumeClient })
    expect(lookup.mock.calls[0][0].keywords[0]).toBe('rb leipzig hsv')
    expect(shared.volumes[0]).toMatchObject({ query: long.query, normalizedQuery: long.normalizedQuery, providerId: 'dataforseo-google-ads-search-volume', geographicScope: usScope })
  })
})
