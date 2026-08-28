import { describe, expect, it } from 'vitest'
import { rankEntries } from '../domain/leaderboard'
import type { SearchDataProvider } from '../domain/types'
import { googleTrendingNowReplay } from './googleTrendingNowReplay.fixture'
import { GoogleHistoricalInterestReplayProvider, GoogleTrendingNowReplayProvider, GoogleTrendingNowSearchDataProvider, mapGoogleCategories, normalizeGoogleTrendingNow } from './googleTrendingNowProvider'

describe('Google Trending Now replay providers', () => {
  it('loads 100 candidate records from the local Trending Now fixture', async () => {
    const records = await new GoogleTrendingNowReplayProvider().getTrendingNow()
    expect(records).toHaveLength(100)
    expect(records[0]).toMatchObject({
      query: 'iPhone 17 Pro release date',
      normalizedQuery: 'iphone 17 pro release date',
      source: 'google-trending-now-replay',
      provenance: { providerId: 'google-trending-now', dataMode: 'replay', geographicScope: { kind: 'global' } },
    })
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
    const [candidate] = await new GoogleTrendingNowSearchDataProvider().getCandidates()
    const points = await new GoogleHistoricalInterestReplayProvider().getInterest({ candidate, range: { start: '2026-08-19T00:00:00.000Z', end: '2026-08-25T00:00:00.000Z' } })
    expect(points).toHaveLength(7)
    expect(points.every((point) => point.availability === 'available' && point.interest >= 0 && point.interest <= 100)).toBe(true)
  })

  it('provides a deterministic 1Y replay history while preserving the trailing 30-day fixture window', async () => {
    const provider = new GoogleTrendingNowSearchDataProvider()
    const [candidate] = await provider.getAllTopicData()
    const day = await provider.getObservations(candidate.id, '24H')
    const week = await provider.getObservations(candidate.id, '7D')
    const year = await provider.getObservations(candidate.id, '1Y')
    const thirtyDays = await provider.getObservations(candidate.id, '30D')
    const originalThirtyDayReplay = Array.from({ length: 30 }, (_, index) => {
      const baseline = 22
      const lift = index < 16 ? 0 : index - 15
      const variation = (index * 3) % 9 - 4
      return Math.max(0, Math.min(100, baseline + lift + variation))
    })

    expect(year).toHaveLength(365)
    expect(thirtyDays).toHaveLength(30)
    expect(day.map((point) => point.interest)).toEqual(originalThirtyDayReplay.slice(-1))
    expect(week.map((point) => point.interest)).toEqual(originalThirtyDayReplay.slice(-7))
    expect(thirtyDays.map((point) => point.interest)).toEqual(originalThirtyDayReplay)
    expect(year.slice(-30)).toEqual(thirtyDays)
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
