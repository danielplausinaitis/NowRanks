import { describe, expect, it } from 'vitest'
import { resolveLeaderboardDataSource } from './dataSource.mjs'

describe('leaderboard API data-source configuration', () => {
  it('defaults to replay', () => {
    expect(resolveLeaderboardDataSource({})).toBe('replay')
  })

  it.each(['replay', 'live'])('accepts explicit %s', (source) => {
    expect(resolveLeaderboardDataSource({ LEADERBOARD_DATA_SOURCE: source })).toBe(source)
  })

  it('rejects invalid and VITE lookalike configuration', () => {
    expect(() => resolveLeaderboardDataSource({ LEADERBOARD_DATA_SOURCE: 'providers' })).toThrow('LEADERBOARD_DATA_SOURCE must be replay or live')
    expect(resolveLeaderboardDataSource({ VITE_LEADERBOARD_DATA_SOURCE: 'live' })).toBe('replay')
  })
})
