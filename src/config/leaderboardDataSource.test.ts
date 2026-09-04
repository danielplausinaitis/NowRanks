import { describe, expect, it } from 'vitest'
import { resolveFrontendLeaderboardDataSource } from './leaderboardDataSource'

describe('frontend leaderboard data-source configuration', () => {
  it('defaults to replay and accepts only the explicit browser values', () => {
    expect(resolveFrontendLeaderboardDataSource({})).toBe('replay')
    expect(resolveFrontendLeaderboardDataSource({ VITE_LEADERBOARD_DATA_SOURCE: 'live' })).toBe('live')
    expect(resolveFrontendLeaderboardDataSource({ VITE_LEADERBOARD_DATA_SOURCE: 'replay' })).toBe('replay')
  })
  it('fails clearly for an invalid browser source', () => {
    expect(() => resolveFrontendLeaderboardDataSource({ VITE_LEADERBOARD_DATA_SOURCE: 'providers' })).toThrow('VITE_LEADERBOARD_DATA_SOURCE must be replay or live')
  })
})
