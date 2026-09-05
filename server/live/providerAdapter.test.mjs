import { describe, expect, it, vi } from 'vitest'
import { createLiveTrendProviderAdapter, LIVE_MISSING_REASONS, LiveProviderError, loadLiveTopicData } from './providerAdapter.mjs'

const retrievedAt = '2026-08-26T00:05:00.000Z'
const payload = () => ({
  sourceObservedAt: '2026-08-26T00:00:00.000Z',
  sourceVersion: 'provider-api-v3',
  geographicScope: { kind: 'global' },
  crossQueryComparability: { status: 'comparable', basis: 'one shared provider scale for this retrieval' },
  topics: [{
    sourceId: 'provider-topic-42', query: 'Space launch', category: 'technology',
    observations: [
      { observedAt: '2026-08-25T00:00:00.000Z', measurement: 0 },
      { observedAt: '2026-08-26T00:00:00.000Z', measurement: null, missingReason: 'not-reported' },
    ],
  }],
})

function adapter() {
  return createLiveTrendProviderAdapter({ providerId: 'legitimate-trend-provider', mapCategory: (category) => category === 'technology' ? 'Technology' : category })
}

describe('live provider adapter boundary', () => {
  it('converts a mocked external response into canonical live topic data without inventing measurements', () => {
    const [topic] = adapter().normalize(payload(), { retrievedAt })
    expect(topic).toMatchObject({
      id: 'legitimate-trend-provider:provider-topic-42', topic: 'Space launch', normalizedQuery: 'space launch', category: 'Technology',
      provenance: { providerId: 'legitimate-trend-provider', dataMode: 'live', sourceObservedAt: '2026-08-26T00:00:00.000Z', ingestedAt: retrievedAt, sourceVersion: 'provider-api-v3', collectionMethod: 'legitimate-live-provider-adapter', crossQueryComparability: { status: 'comparable' } },
    })
    expect(topic.observations).toEqual([
      expect.objectContaining({ availability: 'available', interest: 0 }),
      expect.objectContaining({ availability: 'missing', interest: null, missingReason: 'not-reported' }),
    ])
  })

  it.each(LIVE_MISSING_REASONS)('accepts the closed missing-reason vocabulary: %s', (missingReason) => {
    const value = payload()
    value.topics[0].observations[1].missingReason = missingReason
    expect(adapter().normalize(value, { retrievedAt })[0].observations[1]).toMatchObject({ availability: 'missing', interest: null, missingReason })
  })

  it.each([
    ['missing with numeric measurement', { measurement: 1, missingReason: 'invalid-provider-measurement' }],
    ['available with null measurement', { measurement: null }],
    ['available with a missing reason', { measurement: 1, missingReason: 'out-of-range' }],
    ['unknown missing reason', { measurement: null, missingReason: 'unknown-reason' }],
  ])('rejects invalid availability/value combinations: %s', (_label, observation) => {
    const value = payload()
    value.topics[0].observations[1] = { observedAt: '2026-08-26T00:00:00.000Z', ...observation }
    expect(() => adapter().normalize(value, { retrievedAt })).toThrow(/Live provider response/i)
  })

  it.each([
    ['missing query', (value) => { value.topics[0].query = '' }],
    ['invalid timestamp', (value) => { value.topics[0].observations[0].observedAt = 'not-a-date' }],
    ['negative measurement', (value) => { value.topics[0].observations[0].measurement = -1 }],
    ['unknown category', (value) => { value.topics[0].category = 'unknown' }],
    ['missing measurement', (value) => { delete value.topics[0].observations[0].measurement }],
  ])('rejects malformed external payload: %s', (_label, mutate) => {
    const value = payload()
    mutate(value)
    expect(() => adapter().normalize(value, { retrievedAt })).toThrow(/Live provider response/i)
  })

  it('rejects duplicate topic identities and duplicate observations', () => {
    const duplicateTopic = payload()
    duplicateTopic.topics.push(structuredClone(duplicateTopic.topics[0]))
    expect(() => adapter().normalize(duplicateTopic, { retrievedAt })).toThrow(/duplicate topic identity/i)
    const duplicateObservation = payload()
    duplicateObservation.topics[0].observations.push(structuredClone(duplicateObservation.topics[0].observations[0]))
    expect(() => adapter().normalize(duplicateObservation, { retrievedAt })).toThrow(/duplicate observation/i)
  })

  it('requires explicit comparability instead of assuming provider measurements can be ranked together', () => {
    const value = payload()
    value.crossQueryComparability = { status: 'unknown' }
    expect(adapter().normalize(value, { retrievedAt })[0].provenance.crossQueryComparability.status).toBe('unknown')
    delete value.crossQueryComparability
    expect(() => adapter().normalize(value, { retrievedAt })).toThrow(/explicitly declare cross-query comparability/i)
  })

  it('surfaces a live transport failure and never falls back to replay data or leaks credentials', async () => {
    const fetchLiveResponse = vi.fn(async () => { throw new Error('authorization=sb_secret_should_not_leak') })
    await expect(loadLiveTopicData({ adapter: adapter(), fetchLiveResponse, retrievedAt })).rejects.toBeInstanceOf(LiveProviderError)
    await expect(loadLiveTopicData({ adapter: adapter(), retrievedAt })).rejects.toThrow(/not configured/i)
    try { await loadLiveTopicData({ adapter: adapter(), fetchLiveResponse, retrievedAt }) } catch (error) {
      expect(error.message).toContain('Live provider legitimate-trend-provider failed')
      expect(error.message).not.toContain('sb_secret_should_not_leak')
      expect(error.message).not.toContain('replay')
    }
  })
})
