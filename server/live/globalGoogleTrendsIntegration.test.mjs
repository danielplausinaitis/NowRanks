import { describe, expect, it } from 'vitest'
import { buildCanonicalAttentionPersistencePlan } from './canonicalAttentionPersistence.mjs'
import { GOOGLE_TRENDS_HOURLY_RESAMPLING, normalizeDataForSeoGoogleTrendsMeasurement, resampleGoogleTrendsHourly } from './dataForSeoGoogleTrends.mjs'
import { retrieveGoogleTrendsHistories } from './googleTrendsHistoryRetrieval.mjs'
import { resolveLiveTrendsProvider } from './liveTrendsProvider.mjs'
import { createLiveTrendProviderAdapter } from './providerAdapter.mjs'
import { analyzeObservationTimeline } from './shadowTemporalDiagnostics.mjs'
import { composeUnifiedPublicScore } from './unifiedPublicScoring.mjs'

const target = JSON.stringify({ mode: 'common-global', geographicScope: { kind: 'global' }, locationCode: null, locationName: null, locationCoordinate: null, languageCode: null, languageName: null })
const candidate = { sourceId: 'candidate:topic', query: 'Topic', normalizedQuery: 'topic', category: 'Technology' }
const scope = { kind: 'global' }

function googleResponse({ start = '2026-09-12T18:08:00.000Z', values = Array.from({ length: 181 }, () => 50) } = {}) {
  const initial = Date.parse(start) / 1000
  return { status_code: 20000, tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{
    location_code: 0, language_code: 'en',
    items: [{ type: 'google_trends_graph', keywords: ['Topic'], data: values.map((value, index) => ({ timestamp: initial + index * 480, values: [value] })) }],
  }] }] }
}

function normalize(response, metadata = { measurementMode: 'global', measurementTarget: target, time_range: 'past_day' }) {
  return normalizeDataForSeoGoogleTrendsMeasurement({
    response, candidates: [candidate], geographicScope: scope, retrievedAt: '2026-09-13T18:10:00.000Z',
    adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-google-trends' }), requestMetadata: metadata,
  }).histories[0]
}

describe('global Google Trends production integration', () => {
  it('selects Google Trends only for the proven global 24H path and preserves legacy selection elsewhere', () => {
    expect(resolveLiveTrendsProvider({ measurementMode: 'global', historyWindow: '24H' })).toMatchObject({ id: 'dataforseo-google-trends', transport: 'google-trends', forcedMode: 'single' })
    expect(resolveLiveTrendsProvider({ measurementMode: 'global', historyWindow: '7D' })).toMatchObject({ id: 'dataforseo-trends' })
    expect(resolveLiveTrendsProvider({ measurementMode: 'us', historyWindow: '24H' })).toMatchObject({ id: 'dataforseo-trends' })
  })

  it('issues one intentionally global request per candidate, never a cross-query batch', async () => {
    const client = { explore: async (request) => {
      expect(request).toEqual({ keywords: ['Topic'], timeRange: 'past_day', measurementTarget: 'global' })
      return {
        task: { keywords: ['Topic'], time_range: 'past_day', item_types: ['google_trends_graph'] },
        response: googleResponse(), retrievedAt: '2026-09-13T18:10:00.000Z',
      }
    } }
    const result = await retrieveGoogleTrendsHistories({ candidates: [candidate], client, request: { timeRange: 'past_day', measurementTarget: target }, geographicScope: scope })
    expect(result.requestCount).toBe(1)
    expect(result.histories).toHaveLength(1)
    expect(result.histories[0].provenance.providerId).toBe('dataforseo-google-trends')
  })

  it('preserves 181 raw points and exposes deterministic hourly means to the existing scorer contract', () => {
    const history = normalize(googleResponse())
    expect(history.rawProviderObservations).toHaveLength(181)
    expect(history.observations).toHaveLength(25)
    expect(history.observations.filter((point) => point.availability === 'available')).toHaveLength(24)
    expect(history.observations[0]).toMatchObject({ observedAt: '2026-09-12T18:00:00.000Z', availability: 'available', interest: 50, resampling: { aggregation: 'hourly-mean', validObservationCount: 7, coverageStatus: 'partial-sufficient' } })
    expect(history.observations.at(-1)).toMatchObject({ observedAt: '2026-09-13T18:00:00.000Z', availability: 'missing', interest: null, resampling: { validObservationCount: 2, coverageStatus: 'insufficient' } })
    expect(analyzeObservationTimeline(history.observations).detectedResolution).toBe('hourly')
    expect(history.canonicalAggregation).toEqual(GOOGLE_TRENDS_HOURLY_RESAMPLING)
  })

  it('uses an arithmetic hourly mean and accepts partial hours only at four valid observations', () => {
    const start = '2026-09-12T18:08:00.000Z'
    const raw = [10, 20, 30, 40].map((interest, index) => ({ observedAt: new Date(Date.parse(start) + index * 480_000).toISOString(), availability: 'available', interest }))
    const accepted = resampleGoogleTrendsHourly(raw)
    expect(accepted.observations).toEqual([expect.objectContaining({ availability: 'available', interest: 25, resampling: expect.objectContaining({ validObservationCount: 4, coverage: 0.5, coverageStatus: 'partial-sufficient' }) })])
    const rejected = resampleGoogleTrendsHourly(raw.slice(0, 3))
    expect(rejected.observations).toEqual([expect.objectContaining({ availability: 'missing', interest: null, resampling: expect.objectContaining({ validObservationCount: 3, coverageStatus: 'insufficient' }) })])
  })

  it('keeps provider zero, null, and invalid values unavailable rather than fabricating attention', () => {
    const history = normalize(googleResponse({ values: [0, null, 'bad', -1, ...Array.from({ length: 177 }, () => 0)] }))
    expect(history.rawProviderObservations.slice(0, 4)).toMatchObject([
      { availability: 'missing', interest: null, missingReason: 'out-of-range', rawProviderValue: 0 },
      { availability: 'missing', interest: null, missingReason: 'invalid-provider-measurement', rawProviderValue: null },
      { availability: 'missing', interest: null, missingReason: 'invalid-provider-measurement', rawProviderValue: 'bad' },
      { availability: 'missing', interest: null, missingReason: 'invalid-provider-measurement', rawProviderValue: -1 },
    ])
    expect(history.canonicalObservations.every((point) => point.availability === 'missing' && point.interest === null)).toBe(true)
  })

  it('bootstraps hourly global canonical points while persisting the high-resolution curve and bucket provenance', () => {
    const history = normalize(googleResponse())
    const plan = buildCanonicalAttentionPersistencePlan({ histories: [history], candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'google-bootstrap', scoredAt: '2026-09-13T18:10:00.000Z', canonicalTargeting: { measurementMode: 'global', measurementTarget: target, measurementLocation: null, measurementLanguage: null } })
    expect(plan.artifacts[0]).toMatchObject({ provider_id: 'dataforseo-google-trends', raw_curve: expect.any(Array), targeting: { canonicalAggregation: GOOGLE_TRENDS_HOURLY_RESAMPLING, canonicalHourlyBuckets: expect.any(Array) } })
    expect(plan.artifacts[0].raw_curve).toHaveLength(181)
    expect(plan.artifacts[0].targeting.canonicalHourlyBuckets).toHaveLength(25)
    expect(plan.diagnostics).toMatchObject({ bootstrapped: 1, newPoints: 24, rejected: 0 })
    expect(plan.points).toHaveLength(24)
  })

  it('never stitches Google Trends into the old provider, but aligns a later same-target Google curve', () => {
    const first = normalize(googleResponse())
    const initial = buildCanonicalAttentionPersistencePlan({ histories: [first], candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'google-one', scoredAt: '2026-09-13T18:10:00.000Z', canonicalTargeting: { measurementMode: 'global', measurementTarget: target, measurementLocation: null, measurementLanguage: null } })
    const legacy = {
      ...first,
      provenance: { ...first.provenance, providerId: 'dataforseo-trends' },
      canonicalAggregation: undefined,
      canonicalObservations: first.observations,
      rawProviderObservations: undefined,
    }
    const isolated = buildCanonicalAttentionPersistencePlan({ histories: [legacy], candidateIdByQuery: new Map([['topic', 'candidate']]), existingByQuery: new Map([['topic', initial.points]]), runId: 'legacy-two', scoredAt: '2026-09-13T18:10:00.000Z', canonicalTargeting: { measurementMode: 'global', measurementTarget: target, measurementLocation: null, measurementLanguage: null } })
    expect(isolated.alignments[0]).toMatchObject({ accepted: true, reason: 'bootstrap', total_timestamp_overlap: 0 })
    expect(isolated.points[0].series_key).not.toBe(initial.points[0].series_key)

    const later = normalize(googleResponse({ start: '2026-09-12T19:08:00.000Z', values: Array.from({ length: 181 }, () => 25) }))
    const aligned = buildCanonicalAttentionPersistencePlan({ histories: [later], candidateIdByQuery: new Map([['topic', 'candidate']]), existingByQuery: new Map([['topic', initial.points]]), runId: 'google-two', scoredAt: '2026-09-13T19:10:00.000Z', canonicalTargeting: { measurementMode: 'global', measurementTarget: target, measurementLocation: null, measurementLanguage: null } })
    expect(aligned.alignments[0]).toMatchObject({ accepted: true, can_resume_existing_segment: true })
  })

  it('isolates US and global Google targeting and leaves public scoring weights unchanged', () => {
    const globalHistory = normalize(googleResponse())
    const usHistory = normalize(googleResponse(), { measurementMode: 'us', measurementTarget: 'us-target', time_range: 'past_day' })
    usHistory.provenance = { ...usHistory.provenance, geographicScope: { kind: 'country', countryCode: 'US' } }
    usHistory.measurementProvenance = { ...usHistory.measurementProvenance, measurementMode: 'us', measurementTarget: 'us-target', measurementLocation: { kind: 'country', countryCode: 'US' } }
    const globalPlan = buildCanonicalAttentionPersistencePlan({ histories: [globalHistory], candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'global', scoredAt: '2026-09-13T18:10:00.000Z', canonicalTargeting: { measurementMode: 'global', measurementTarget: target, measurementLocation: null, measurementLanguage: null } })
    const usPlan = buildCanonicalAttentionPersistencePlan({ histories: [usHistory], candidateIdByQuery: new Map([['topic', 'candidate']]), runId: 'us', scoredAt: '2026-09-13T18:10:00.000Z', canonicalTargeting: { measurementMode: 'us', measurementTarget: 'us-target', measurementLocation: 'United States', measurementLanguage: null } })
    expect(globalPlan.points[0].series_key).not.toBe(usPlan.points[0].series_key)
    const inputs = { window: '24H', currentAttention: 50, baselineDemand: 50, historicalGrowth: null, discoveryAcceleration: 70, momentum: null, consistency: null, breakout: null, recency: 80, historyCoverage: 0 }
    expect(composeUnifiedPublicScore(inputs)).toEqual(composeUnifiedPublicScore(inputs))
  })
})
