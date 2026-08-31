import { describe, expect, it } from 'vitest'
import { readPersistedTopicData, reconstructPersistedTopicData } from './persistedData.mjs'
import { fetchAllPages } from './supabaseReadRepository.mjs'

const candidate = { candidate_id: 'google:example', query_text: 'Example query', normalized_query: 'example query', category: 'Technology' }
const provenance = {
  provenance_id: 'provenance-1', provider_id: 'google-trending-now', data_mode: 'replay',
  source_observed_at: '2026-08-25T00:00:00.000Z', ingested_at: '2026-08-25T00:01:00.000Z',
  geographic_scope: { kind: 'global' }, source_version: 'fixture-v1', collection_method: 'replay',
  cross_query_comparability_status: 'comparable', cross_query_comparability_basis: 'fixture',
}
const available = { candidate_id: 'google:example', provenance_id: 'provenance-1', observation_date: '2026-08-25', observed_at: '2026-08-25T00:00:00.000Z', availability: 'available', interest_value: 0, missing_reason: null }
const missing = { candidate_id: 'google:example', provenance_id: 'provenance-1', observation_date: '2026-08-24', observed_at: '2026-08-24T00:00:00.000Z', availability: 'missing', interest_value: null, missing_reason: 'not-reported' }

function readRepository({ provenances = [provenance], observations = [available, missing], candidates = [candidate] } = {}) {
  const calls = []
  return {
    calls,
    async listProvenance(filter) { calls.push(['provenance', filter]); return provenances },
    async getLatestObservationDate() { return '2026-08-25' },
    async listObservations(filter) { calls.push(['observations', filter]); return observations },
    async listCandidates(filter) { calls.push(['candidates', filter]); return candidates },
  }
}

describe('persisted canonical-data reconstruction', () => {
  it('reconstructs candidates and replay provenance with a stable ID', () => {
    const [result] = reconstructPersistedTopicData({ candidates: [candidate], provenances: [provenance], observations: [available] })
    expect(result).toMatchObject({
      id: 'google:example', topic: 'Example query', normalizedQuery: 'example query',
      provenance: { providerId: 'google-trending-now', dataMode: 'replay', geographicScope: { kind: 'global' } },
    })
  })

  it('preserves valid zero interest and missing NULL interest with its reason', () => {
    const [result] = reconstructPersistedTopicData({ candidates: [candidate], provenances: [provenance], observations: [available, missing] })
    expect(result.observations).toContainEqual(expect.objectContaining({ availability: 'available', interest: 0 }))
    expect(result.observations).toContainEqual(expect.objectContaining({ availability: 'missing', interest: null, missingReason: 'not-reported' }))
  })

  it('uses explicit provider/mode filters and selected-window dates with no replay-to-live fallback', async () => {
    const repository = readRepository()
    const result = await readPersistedTopicData({ repository, providerId: 'google-trending-now', dataMode: 'replay', window: '7D' })
    expect(result).toMatchObject({ observationCount: 2, startDate: '2026-08-19', endDate: '2026-08-25' })
    expect(repository.calls[0]).toEqual(['provenance', { providerId: 'google-trending-now', dataMode: 'replay' }])
    expect(repository.calls[1]).toEqual(['observations', { provenanceIds: ['provenance-1'], startDate: '2026-08-19', endDate: '2026-08-25' }])

    const noLiveRepository = readRepository({ provenances: [] })
    await expect(readPersistedTopicData({ repository: noLiveRepository, providerId: 'google-trending-now', dataMode: 'live' }))
      .resolves.toMatchObject({ data: [], observationCount: 0 })
    expect(noLiveRepository.calls[0]).toEqual(['provenance', { providerId: 'google-trending-now', dataMode: 'live' }])
  })

  it('uses distinct 30D and 1Y date ranges from the same latest observation', async () => {
    const thirtyDayRepository = readRepository()
    const yearRepository = readRepository()
    await readPersistedTopicData({ repository: thirtyDayRepository, providerId: 'google-trending-now', dataMode: 'replay', window: '30D' })
    await readPersistedTopicData({ repository: yearRepository, providerId: 'google-trending-now', dataMode: 'replay', window: '1Y' })
    expect(thirtyDayRepository.calls[1][1]).toMatchObject({ startDate: '2026-07-27', endDate: '2026-08-25' })
    expect(yearRepository.calls[1][1]).toMatchObject({ startDate: '2025-08-26', endDate: '2026-08-25' })
  })

  it('reads one bounded overlapping range when a previous comparable window is requested', async () => {
    const repository = readRepository()
    const result = await readPersistedTopicData({ repository, providerId: 'google-trending-now', dataMode: 'replay', window: '7D', includePrevious: true })
    expect(repository.calls[1]).toEqual(['observations', { provenanceIds: ['provenance-1'], startDate: '2026-08-18', endDate: '2026-08-25' }])
    expect(result).toMatchObject({ startDate: '2026-08-19', comparisonEndDate: '2026-08-24', readStartDate: '2026-08-18' })
  })

  it('fails clearly for malformed persisted observation rows', () => {
    expect(() => reconstructPersistedTopicData({
      candidates: [candidate], provenances: [provenance], observations: [{ ...missing, interest_value: 0 }],
    })).toThrow(/missing observation.*NULL/i)
  })

  it('fails rather than silently collapsing multiple provenance records for one canonical candidate', () => {
    expect(() => reconstructPersistedTopicData({
      candidates: [candidate], provenances: [provenance, { ...provenance, provenance_id: 'provenance-2' }],
      observations: [available, { ...available, provenance_id: 'provenance-2' }],
    })).toThrow(/multiple provenance/i)
  })
})

describe('Supabase Data API pagination', () => {
  it('collects more rows than one mocked Data API response using bounded pages', async () => {
    const allRows = Array.from({ length: 2_501 }, (_, id) => ({ id }))
    const ranges = []
    const rows = await fetchAllPages(async (from, to) => {
      ranges.push([from, to])
      return allRows.slice(from, to + 1)
    }, { pageSize: 1_000 })
    expect(rows).toHaveLength(2_501)
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
})
