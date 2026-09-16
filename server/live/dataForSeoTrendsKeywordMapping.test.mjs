import { describe, expect, it } from 'vitest'
import { normalizeDataForSeoMeasurementWithDiagnostics } from './dataForSeoTrends.mjs'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'

const geographicScope = { kind: 'global' }
const adapter = createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' })

function candidates(labels) {
  return labels.map((query, index) => ({ sourceId: `candidate-${index + 1}`, query, normalizedQuery: `candidate-${index + 1}`, category: 'Technology' }))
}

function response(returnedKeywords, values = returnedKeywords.map((_keyword, index) => index + 10)) {
  return {
    status_code: 20000,
    tasks: [{
      status_code: 20000,
      result: [{ items: [{
        type: 'dataforseo_trends_graph',
        keywords: returnedKeywords,
        data: [{ timestamp: 1_789_948_800, values }],
      }] }],
    }],
  }
}

function normalize({ labels = ['Alpha', 'Bravo', 'Charlie'], returnedKeywords = labels, values, timeRange = 'past_7_days' } = {}) {
  return normalizeDataForSeoMeasurementWithDiagnostics({
    response: response(returnedKeywords, values),
    candidates: candidates(labels),
    geographicScope,
    retrievedAt: '2026-09-14T00:00:00.000Z',
    adapter,
    requestMetadata: { measurementMode: 'global', measurementTarget: 'common-global', time_range: timeRange },
  })
}

describe('DataForSEO Trends graph keyword identity mapping', () => {
  it.each([
    ['7D', 'past_7_days', ['Alpha', 'Bravo', 'Charlie']],
    ['30D', 'past_30_days', ['Charlie', 'Bravo', 'Alpha']],
    ['1Y', 'past_12_months', ['Bravo', 'Alpha', 'Charlie']],
  ])('maps %s graph columns by returned keyword identity rather than response order', (window, timeRange, returnedKeywords) => {
    const result = normalize({ returnedKeywords, values: returnedKeywords.map((keyword) => ({ Alpha: 11, Bravo: 22, Charlie: 33 })[keyword]), timeRange })
    expect(result.histories.map((history) => [history.normalizedQuery, history.observations[0].interest])).toEqual([['candidate-1', 11], ['candidate-2', 22], ['candidate-3', 33]])
    expect(result.histories.every((history) => history.historyRequest.timeRange === timeRange)).toBe(true)
    expect(window).toMatch(/7D|30D|1Y/)
  })

  it('accepts exact response order and conservative Unicode, case, and whitespace echoes', () => {
    const exact = normalize({ labels: ['Alpha', 'Bravo'], values: [11, 22] })
    expect(exact.histories.map((history) => history.observations[0].interest)).toEqual([11, 22])
    const echoed = normalize({ labels: ['Café Topic', 'Space Topic'], returnedKeywords: ['  CAFÉ   topic ', 'space\tTOPIC'], values: [31, 42] })
    expect(echoed.histories.map((history) => history.observations[0].interest)).toEqual([31, 42])
  })

  it.each([
    ['dollar/comma removal', 'Trump $5,000', 'Trump $5000'],
    ['dollar/comma insertion', 'Trump $5000', 'Trump $5,000'],
    ['bare comma removal', 'Trump 5,000', 'Trump 5000'],
    ['bare comma insertion', 'Trump 5000', 'Trump 5,000'],
  ])('accepts the observed standalone integer echo variant: %s', (_name, submitted, returned) => {
    const result = normalize({ labels: [submitted, 'Bravo', 'Charlie'], returnedKeywords: [returned, 'Bravo', 'Charlie'], values: [71, 22, 33] })
    expect(result.histories[0].observations[0].interest).toBe(71)
  })

  it.each([
    ['unknown returned keyword', { returnedKeywords: ['Alpha', 'Other', 'Charlie'] }, /unexpected keyword: Other/i],
    ['duplicate returned keyword', { returnedKeywords: ['Alpha', ' bravo ', 'BRAVO'] }, /ambiguous.*response/i],
    ['missing requested keyword/count mismatch', { returnedKeywords: ['Alpha', 'Bravo'] }, /keyword count does not match/i],
    ['ambiguous normalized requested keyword', { labels: ['Alpha', ' alpha ', 'Charlie'] }, /ambiguous.*request/i],
    ['ambiguous integer echo identity', { labels: ['Trump $5,000', 'Trump $5000', 'Charlie'] }, /ambiguous.*request/i],
    ['malformed graph value array', { values: [11, 22] }, /graph values do not match returned keywords/i],
    ['fuzzy-but-different label', { returnedKeywords: ['Alfa', 'Bravo', 'Charlie'] }, /unexpected keyword: Alfa/i],
    ['different decimal value', { labels: ['Trump $5,000.10', 'Bravo', 'Charlie'], returnedKeywords: ['Trump $5000.20', 'Bravo', 'Charlie'] }, /unexpected keyword/i],
    ['same decimal with integer formatting changed', { labels: ['Trump $5,000.10', 'Bravo', 'Charlie'], returnedKeywords: ['Trump $5000.10', 'Bravo', 'Charlie'] }, /unexpected keyword/i],
    ['reordered words', { labels: ['Trump $5,000', 'Bravo', 'Charlie'], returnedKeywords: ['$5000 Trump', 'Bravo', 'Charlie'] }, /unexpected keyword/i],
    ['unrelated punctuation', { labels: ['Trump $5,000!', 'Bravo', 'Charlie'], returnedKeywords: ['Trump $5000?', 'Bravo', 'Charlie'] }, /unexpected keyword/i],
  ])('fails closed for %s', (_name, patch, expected) => {
    expect(() => normalize(patch)).toThrow(expected)
  })

  it('does not make an unrelated numeric transformation a match', () => {
    expect(() => normalize({ labels: ['Trump $5,000', 'Bravo', 'Charlie'], returnedKeywords: ['Trump $5001', 'Bravo', 'Charlie'] }))
      .toThrow(/unexpected keyword: Trump \$5001/i)
  })
})
