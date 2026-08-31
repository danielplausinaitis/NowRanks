import { describe, expect, it, vi } from 'vitest'
import { rankEntries } from '../../src/domain/leaderboard.ts'
import { createLeaderboardService } from './leaderboardService.mjs'

function candidate(id, category = 'Technology', days = 365, base = 100) {
  return {
    id,
    topic: id,
    normalizedQuery: id.toLowerCase(),
    category,
    provenance: {
      providerId: 'google-trending-now', dataMode: 'replay',
      sourceObservedAt: '2026-08-25T00:00:00.000Z', ingestedAt: '2026-08-25T00:00:00.000Z',
      geographicScope: { kind: 'global' }, crossQueryComparability: { status: 'comparable', basis: 'fixture' },
    },
    observations: Array.from({ length: days }, (_, index) => {
      const observedAt = new Date(Date.UTC(2025, 7, 26) + index * 86_400_000).toISOString()
      return { candidateId: id, date: observedAt.slice(0, 10), observedAt, availability: 'available', interest: base + index }
    }),
  }
}

function reader(data) {
  return vi.fn(async (request) => ({ data, startDate: '2025-08-26', endDate: '2026-08-25', observationCount: data.reduce((total, item) => total + item.observations.length, 0), request }))
}

function service(data, engine = { rankEntries }) {
  const readPersistedTopicData = reader(data)
  return { service: createLeaderboardService({ readPersistedTopicData, rankingEngine: engine, now: () => '2026-08-26T00:00:00.000Z' }), readPersistedTopicData }
}

describe('application leaderboard service', () => {
  const request = { providerId: 'google-trending-now', dataMode: 'replay', window: '7D' }

  it('loads global persisted data and delegates ranking to the existing engine', async () => {
    const rankingEngine = { rankEntries: vi.fn((data) => data.map((item, index) => ({ ...item, rank: index + 1, overallScore: 100 - index, movement: null }))) }
    const { service: leaderboard, readPersistedTopicData } = service([candidate('first'), candidate('second')], rankingEngine)
    const result = await leaderboard.getLeaderboard(request)
    expect(readPersistedTopicData).toHaveBeenCalledWith({ ...request, includePrevious: true })
    expect(rankingEngine.rankEntries).toHaveBeenCalledWith(expect.any(Array), 'overallScore', '7D')
    expect(result).toMatchObject({ providerId: 'google-trending-now', dataMode: 'replay', window: '7D', mode: 'overall', generatedAt: '2026-08-26T00:00:00.000Z' })
    expect(result.entries).toHaveLength(2)
  })

  it('filters a supplied category without falling back to global candidates', async () => {
    const { service: leaderboard } = service([candidate('technology', 'Technology'), candidate('finance', 'Finance')])
    const result = await leaderboard.getLeaderboard({ ...request, category: 'Finance' })
    expect(result.category).toBe('Finance')
    expect(result.entries.map((entry) => entry.category)).toEqual(['Finance'])
  })

  it.each(['Sports', 'Gaming'])('ranks the %s cohort before assigning ranks', async (category) => {
    const { service: leaderboard } = service([
      candidate('global-high', 'Technology', 365, 900),
      candidate(`${category}-one`, category, 365, 100),
      candidate(`${category}-two`, category, 365, 200),
      candidate('other', 'Finance', 365, 500),
    ])
    const result = await leaderboard.getLeaderboard({ ...request, category })
    expect(result.entries.map((entry) => entry.category)).toEqual([category, category])
    expect(result.entries.map((entry) => entry.rank)).toEqual([1, 2])
  })

  it('uses the existing trending score type for a selected category cohort', async () => {
    const rankingEngine = { rankEntries: vi.fn((data, scoreType) => data.map((item, index) => ({ ...item, rank: index + 1, overallScore: 10, trendingScore: 90 - index, movement: null }))) }
    const { service: leaderboard } = service([candidate('sports-one', 'Sports'), candidate('sports-two', 'Sports'), candidate('other', 'Technology')], rankingEngine)
    const result = await leaderboard.getLeaderboard({ ...request, category: 'Sports', mode: 'trending' })
    expect(rankingEngine.rankEntries).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ category: 'Sports' })]), 'trendingScore', '7D')
    expect(result).toMatchObject({ mode: 'trending', category: 'Sports' })
    expect(result.entries.map((entry) => entry.rank)).toEqual([1, 2])
  })

  it('rejects an unsupported category instead of treating it as global', async () => {
    const { service: leaderboard, readPersistedTopicData } = service([candidate('one')])
    await expect(leaderboard.getLeaderboard({ ...request, category: 'sports' })).rejects.toThrow(/category must be one of/i)
    expect(readPersistedTopicData).not.toHaveBeenCalled()
  })

  it.each(['24H', '7D', '30D', '1Y'])('supports the %s ranking window deterministically', async (window) => {
    const { service: first } = service([candidate('one'), candidate('two', 'Technology', 365, 200)])
    const { service: second } = service([candidate('one'), candidate('two', 'Technology', 365, 200)])
    const input = { ...request, window }
    await expect(first.getLeaderboard(input)).resolves.toEqual(await second.getLeaderboard(input))
  })

  it('forwards distinct 30D and 1Y windows unchanged to the persisted-data reader and ranker', async () => {
    const rankingEngine = { rankEntries: vi.fn(() => []) }
    const { service: leaderboard, readPersistedTopicData } = service([candidate('one')], rankingEngine)
    await leaderboard.getLeaderboard({ ...request, window: '30D' })
    await leaderboard.getLeaderboard({ ...request, window: '1Y' })
    expect(readPersistedTopicData.mock.calls.map(([call]) => call.window)).toEqual(['30D', '1Y'])
    expect(rankingEngine.rankEntries.mock.calls.map(([, , window]) => window)).toEqual(['30D', '1Y'])
  })

  it('calculates moved, unchanged, and new ranks from the matching previous leaderboard', async () => {
    const data = ['up', 'down', 'flat', 'new'].map((id) => candidate(id, 'Sports', 8))
    const readPersistedTopicData = vi.fn(async () => ({ data, startDate: '2026-08-19', endDate: '2026-08-25', comparisonEndDate: '2026-08-24' }))
    const rankingEngine = { rankEntries: vi.fn()
      .mockReturnValueOnce([
        { ...data[0], id: 'up', rank: 4 }, { ...data[1], id: 'down', rank: 8 }, { ...data[2], id: 'flat', rank: 7 }, { ...data[3], id: 'new', rank: 9 },
      ])
      .mockReturnValueOnce([
        { ...data[0], id: 'up', rank: 10 }, { ...data[1], id: 'down', rank: 3 }, { ...data[2], id: 'flat', rank: 7 },
      ]) }
    const leaderboard = createLeaderboardService({ readPersistedTopicData, rankingEngine, now: () => '2026-08-26T00:00:00.000Z' })
    const result = await leaderboard.getLeaderboard({ ...request, category: 'Sports' })
    expect(result.comparison).toEqual({ available: true, observedThrough: '2026-08-24' })
    expect(result.entries.map(({ id, movement }) => [id, movement])).toEqual([
      ['up', { status: 'moved', delta: 6, previousRank: 10 }],
      ['down', { status: 'moved', delta: -5, previousRank: 3 }],
      ['flat', { status: 'unchanged', delta: 0, previousRank: 7 }],
      ['new', { status: 'new', delta: null, previousRank: null }],
    ])
  })

  it('reports unavailable movement rather than fabricating a 1Y comparison with only 365 days', async () => {
    const { service: leaderboard } = service([candidate('one', 'Technology', 365)])
    const result = await leaderboard.getLeaderboard({ ...request, window: '1Y' })
    expect(result.comparison).toEqual({ available: false, observedThrough: null })
    expect(result.entries[0].movement).toEqual({ status: 'unavailable', delta: null, previousRank: null })
  })

  it('uses the requested trending mode and category cohort for both current and previous rankings', async () => {
    const data = [candidate('sports', 'Sports', 8), candidate('finance', 'Finance', 8)]
    const rankingEngine = { rankEntries: vi.fn((items, scoreType) => items.map((item, index) => ({ ...item, rank: index + 1, overallScore: 10, trendingScore: 90 - index }))) }
    const readPersistedTopicData = vi.fn(async () => ({ data, startDate: '2026-08-19', endDate: '2026-08-25', comparisonEndDate: '2026-08-24' }))
    const leaderboard = createLeaderboardService({ readPersistedTopicData, rankingEngine })
    await leaderboard.getLeaderboard({ ...request, category: 'Sports', mode: 'trending' })
    expect(rankingEngine.rankEntries).toHaveBeenCalledTimes(2)
    for (const [items, scoreType, window] of rankingEngine.rankEntries.mock.calls) {
      expect(items.map((item) => item.category)).toEqual(['Sports'])
      expect(scoreType).toBe('trendingScore')
      expect(window).toBe('7D')
    }
  })

  it('preserves replay provenance metadata and never substitutes it for a live request', async () => {
    const { service: replayService } = service([candidate('one')])
    await expect(replayService.getLeaderboard(request)).resolves.toMatchObject({ dataMode: 'replay', observationRange: { startDate: '2025-08-26' } })
    const { service: liveService, readPersistedTopicData } = service([])
    await expect(liveService.getLeaderboard({ ...request, dataMode: 'live' })).rejects.toThrow(/No persisted data.*live mode/)
    expect(readPersistedTopicData).toHaveBeenCalledWith({ ...request, dataMode: 'live', includePrevious: true })
  })

  it('reports no candidates and insufficient window data clearly', async () => {
    const { service: empty } = service([])
    await expect(empty.getLeaderboard(request)).rejects.toThrow(/No persisted data/)
    const { service: short } = service([candidate('short', 'Technology', 6)])
    await expect(short.getLeaderboard(request)).rejects.toThrow(/Insufficient observations.*7D/)
  })

  it('rejects malformed requests before the persisted-data reader is called', async () => {
    const { service: leaderboard, readPersistedTopicData } = service([candidate('one')])
    await expect(leaderboard.getLeaderboard({ ...request, window: '90D' })).rejects.toThrow(/window must be/)
    await expect(leaderboard.getLeaderboard({ ...request, dataMode: 'invalid' })).rejects.toThrow(/dataMode must be/)
    await expect(leaderboard.getLeaderboard({ ...request, mode: 'banana' })).rejects.toThrow(/mode must be/)
    expect(readPersistedTopicData).not.toHaveBeenCalled()
  })
})
