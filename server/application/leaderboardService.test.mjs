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
    expect(readPersistedTopicData).toHaveBeenCalledWith(request)
    expect(rankingEngine.rankEntries).toHaveBeenCalledWith(expect.any(Array), 'overallScore', '7D')
    expect(result).toMatchObject({ providerId: 'google-trending-now', dataMode: 'replay', window: '7D', generatedAt: '2026-08-26T00:00:00.000Z' })
    expect(result.entries).toHaveLength(2)
  })

  it('filters a supplied category without falling back to global candidates', async () => {
    const { service: leaderboard } = service([candidate('technology', 'Technology'), candidate('finance', 'Finance')])
    const result = await leaderboard.getLeaderboard({ ...request, category: 'Finance' })
    expect(result.category).toBe('Finance')
    expect(result.entries.map((entry) => entry.category)).toEqual(['Finance'])
  })

  it.each(['24H', '7D', '30D', '1Y'])('supports the %s ranking window deterministically', async (window) => {
    const { service: first } = service([candidate('one'), candidate('two', 'Technology', 365, 200)])
    const { service: second } = service([candidate('one'), candidate('two', 'Technology', 365, 200)])
    const input = { ...request, window }
    await expect(first.getLeaderboard(input)).resolves.toEqual(await second.getLeaderboard(input))
  })

  it('preserves replay provenance metadata and never substitutes it for a live request', async () => {
    const { service: replayService } = service([candidate('one')])
    await expect(replayService.getLeaderboard(request)).resolves.toMatchObject({ dataMode: 'replay', observationRange: { startDate: '2025-08-26' } })
    const { service: liveService, readPersistedTopicData } = service([])
    await expect(liveService.getLeaderboard({ ...request, dataMode: 'live' })).rejects.toThrow(/No persisted data.*live mode/)
    expect(readPersistedTopicData).toHaveBeenCalledWith({ ...request, dataMode: 'live' })
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
    expect(readPersistedTopicData).not.toHaveBeenCalled()
  })
})
