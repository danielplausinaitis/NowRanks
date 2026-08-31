import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLeaderboard, LeaderboardApiError } from './leaderboardApi'

afterEach(() => vi.unstubAllGlobals())

describe('leaderboard API client', () => {
  it.each(['24H', '7D', '30D', '1Y'] as const)('constructs a %s request', async (window) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ metadata: {}, entries: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    await fetchLeaderboard({ window })
    expect(fetchMock).toHaveBeenCalledWith(`/api/leaderboard?window=${window}`, expect.objectContaining({ headers: { Accept: 'application/json' } }))
  })

  it('adds an optional category and reports a safe API error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchLeaderboard({ window: '7D', category: 'Finance' })).rejects.toBeInstanceOf(LeaderboardApiError)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/leaderboard?window=7D&category=Finance')
  })
})
