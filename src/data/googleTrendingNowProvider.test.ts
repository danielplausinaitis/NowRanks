import { describe, expect, it } from 'vitest'
import { rankEntries } from '../domain/leaderboard'
import type { SearchDataProvider } from '../domain/types'
import { googleTrendingNowReplay } from './googleTrendingNowReplay.fixture'
import { GoogleHistoricalInterestReplayProvider, GoogleTrendingNowReplayProvider, GoogleTrendingNowSearchDataProvider, mapGoogleCategories, normalizeGoogleTrendingNow } from './googleTrendingNowProvider'

describe('Google Trending Now replay providers', () => {
  it('loads 100 candidate records from the local Trending Now fixture', async () => {
    const records = await new GoogleTrendingNowReplayProvider().getTrendingNow()
    expect(records).toHaveLength(100)
    expect(records[0]).toMatchObject({ query: 'iPhone 17 Pro release date', normalizedQuery: 'iphone 17 pro release date', source: 'google-trending-now-replay' })
  })

  it('normalizes the captured Google response shape without inventing optional values', () => {
    const [record] = normalizeGoogleTrendingNow(googleTrendingNowReplay)
    expect(record.observedAt).toBe('2026-08-25T00:00:00.000Z')
    expect(record.searchVolumeLabel).toBe('10K+')
    expect(record.newsReferences?.[0].url).toBe('https://news.google.com/')
  })

  it('maps Google categories to the existing dashboard categories', () => {
    expect(mapGoogleCategories(['autos & vehicles', 'technology'])).toEqual(['Cars', 'Technology'])
    expect(mapGoogleCategories(['unknown Google vertical'])).toEqual(['Business'])
  })

  it('loads normalized 0–100 historical interest fixture points for a requested range', async () => {
    const points = await new GoogleHistoricalInterestReplayProvider().getInterest('iphone 17 pro release date', { start: '2026-08-19T00:00:00.000Z', end: '2026-08-25T00:00:00.000Z' })
    expect(points).toHaveLength(7)
    expect(points.every((point) => point.interest >= 0 && point.interest <= 100)).toBe(true)
  })

  it('conforms to SearchDataProvider and feeds the unchanged scoring engine', async () => {
    const provider: SearchDataProvider = new GoogleTrendingNowSearchDataProvider()
    const data = await provider.getAllTopicData()
    const ranked = rankEntries(data)
    expect(data).toHaveLength(100)
    expect(ranked).toHaveLength(100)
    expect(ranked[0].overallScore).toBeGreaterThanOrEqual(0)
  })

  it('produces deterministic candidates, interest, and snapshots', async () => {
    const one = new GoogleTrendingNowSearchDataProvider()
    const two = new GoogleTrendingNowSearchDataProvider()
    await expect(one.getAllTopicData()).resolves.toEqual(await two.getAllTopicData())
    await expect(one.getSnapshots()).resolves.toEqual(await two.getSnapshots())
  })
})
