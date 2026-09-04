import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLeaderboard, LeaderboardApiError } from './leaderboardApi'

afterEach(() => vi.unstubAllGlobals())

describe('leaderboard API client', () => {
  it.each(['24H', '7D', '30D', '1Y'] as const)('constructs a %s request', async (window) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ metadata: {}, entries: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    await fetchLeaderboard({ window, mode: 'trending' })
    expect(fetchMock).toHaveBeenCalledWith(`/api/leaderboard?window=${window}&mode=trending`, expect.objectContaining({ headers: { Accept: 'application/json' } }))
  })

  it('uses distinct cache keys for 30D and 1Y requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ metadata: {}, entries: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    await fetchLeaderboard({ window: '30D', mode: 'overall' })
    await fetchLeaderboard({ window: '1Y', mode: 'overall' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/leaderboard?window=30D&mode=overall',
      '/api/leaderboard?window=1Y&mode=overall',
    ])
  })

  it('adds an optional category and reports a safe API error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { code: 'unavailable' } }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchLeaderboard({ window: '7D', mode: 'overall', category: 'Finance' })).rejects.toBeInstanceOf(LeaderboardApiError)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/leaderboard?window=7D&mode=overall&category=Finance')
  })

  it('surfaces the explicit live no-snapshot error without a replay fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: 'live_snapshot_not_found' } }) }))
    await expect(fetchLeaderboard({ window: '1Y', mode: 'overall' })).rejects.toMatchObject({ code: 'live_snapshot_not_found', message: 'No live snapshot is available for this window yet.' })
  })
})
