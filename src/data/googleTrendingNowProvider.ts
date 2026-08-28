import type { Category, HistoricalInterestPoint, HistoricalInterestProvider, LeaderboardSnapshot, LeaderboardSnapshotProvider, SearchDataProvider, SearchTopic, SearchTopicData, TimeWindow, TopicObservation, TrendingNowProvider, TrendingNowRecord } from '../domain/types'
import { TIME_WINDOWS } from '../domain/config'
import { rankEntries } from '../domain/leaderboard'
import { googleInterestReplayFixture, googleTrendingNowReplay, type GoogleTrendingNowReplayResponse } from './googleTrendingNowReplay.fixture'

const categoryMap: Record<string, Category> = {
  technology: 'Technology', games: 'Gaming', sports: 'Sports', travel: 'Travel', finance: 'Finance',
  'arts & entertainment': 'Entertainment', 'autos & vehicles': 'Cars', business: 'Business', health: 'Health',
}

const replayIngestedAt = '2026-08-25T00:00:00.000Z'

export function normalizeGoogleQuery(query: string) {
  return query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

export function mapGoogleCategories(categories: string[] | undefined): Category[] {
  const mapped = (categories ?? []).map((category) => categoryMap[category.toLocaleLowerCase('en-US')]).filter((category): category is Category => Boolean(category))
  return mapped.length ? [...new Set(mapped)] : ['Business']
}

export function normalizeGoogleTrendingNow(response: GoogleTrendingNowReplayResponse): TrendingNowRecord[] {
  return response.default.trendingSearchesDays.flatMap(({ date, trendingSearches }) => trendingSearches.map((item) => ({
    query: item.title.query,
    normalizedQuery: normalizeGoogleQuery(item.title.query),
    categories: mapGoogleCategories(item.categories),
    observedAt: `${date}T00:00:00.000Z`,
    source: 'google-trending-now-replay',
    provenance: {
      providerId: 'google-trending-now',
      dataMode: 'replay',
      sourceObservedAt: `${date}T00:00:00.000Z`,
      ingestedAt: replayIngestedAt,
      geographicScope: { kind: 'global' },
      sourceVersion: 'trending-now-replay-v1',
      collectionMethod: 'local-deterministic-replay-fixture',
      crossQueryComparability: { status: 'comparable', basis: 'controlled deterministic fixture for model testing only' },
    },
    searchVolume: item.traffic,
    searchVolumeLabel: item.formattedTraffic,
    newsReferences: item.articles?.map((article) => ({ title: article.title, url: article.url, source: article.source, publishedAt: article.time })),
  })))
}

export class GoogleTrendingNowReplayProvider implements TrendingNowProvider {
  async getTrendingNow(): Promise<TrendingNowRecord[]> {
    return normalizeGoogleTrendingNow(googleTrendingNowReplay)
  }
}

/** Local Google Trends-style interest fixture; the official provider can replace this class directly. */
export class GoogleHistoricalInterestReplayProvider implements HistoricalInterestProvider {
  async getInterest({ candidate, range }: Parameters<HistoricalInterestProvider['getInterest']>[0]): Promise<HistoricalInterestPoint[]> {
    const values = googleInterestReplayFixture[candidate.normalizedQuery] ?? []
    const days = Math.max(1, Math.floor((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1)
    return values.slice(-days).map((interest, index, points) => {
      const observedAt = new Date(Date.parse(range.end) - (points.length - 1 - index) * 86_400_000).toISOString()
      return { candidateId: candidate.id, date: observedAt.slice(0, 10), observedAt, availability: 'available' as const, interest }
    })
  }
}

export class FixtureLeaderboardSnapshotProvider implements LeaderboardSnapshotProvider {
  constructor(private readonly data: SearchTopicData[]) {}
  async getSnapshots(): Promise<LeaderboardSnapshot[]> {
    const previous = this.data.map((item, index) => {
      const trailingThirtyStart = Math.max(0, item.observations.length - 30)
      return {
        ...item,
        observations: item.observations.map((point, day) => point.availability === 'missing'
          ? point
          : { ...point, interest: Math.max(0, point.interest - (day > trailingThirtyStart + 23 ? (index % 5) : 0)) }),
      }
    })
    return [
      { date: '2026-08-24', snapshotAt: '2026-08-24T00:00:00.000Z', scoringMode: 'overallScore', selectedWindow: '30D', entries: rankEntries(previous) },
      { date: '2026-08-25', snapshotAt: '2026-08-25T00:00:00.000Z', scoringMode: 'overallScore', selectedWindow: '30D', entries: rankEntries(this.data) },
    ]
  }
}

export class GoogleTrendingNowSearchDataProvider implements SearchDataProvider {
  private readonly candidateProvider: TrendingNowProvider
  private readonly interestProvider: HistoricalInterestProvider
  private cachedData?: SearchTopicData[]
  private snapshotProvider?: FixtureLeaderboardSnapshotProvider

  constructor(candidateProvider: TrendingNowProvider = new GoogleTrendingNowReplayProvider(), interestProvider: HistoricalInterestProvider = new GoogleHistoricalInterestReplayProvider()) {
    this.candidateProvider = candidateProvider
    this.interestProvider = interestProvider
  }

  async getCandidates(): Promise<SearchTopic[]> {
    return (await this.candidateProvider.getTrendingNow()).map((record) => ({
      id: `google:${record.normalizedQuery}`,
      topic: record.query,
      normalizedQuery: record.normalizedQuery,
      category: record.categories[0],
      provenance: record.provenance,
    }))
  }

  async getObservations(topicId: string, window: TimeWindow): Promise<TopicObservation[]> {
    const item = (await this.getAllTopicData()).find((candidate) => candidate.id === topicId)
    return item?.observations.slice(-TIME_WINDOWS[window]) ?? []
  }

  async getAllTopicData(): Promise<SearchTopicData[]> {
    if (!this.cachedData) {
      const candidates = await this.getCandidates()
      // Deterministic replay fixture range; it is not a live Google history request.
      const range = { start: '2025-08-26T00:00:00.000Z', end: '2026-08-25T00:00:00.000Z' }
      this.cachedData = await Promise.all(candidates.map(async (candidate) => ({ ...candidate, observations: await this.interestProvider.getInterest({ candidate, range }) })))
    }
    return this.cachedData.map((item) => ({ ...item, observations: [...item.observations] }))
  }

  async getSnapshots(): Promise<LeaderboardSnapshot[]> {
    const data = await this.getAllTopicData()
    this.snapshotProvider ??= new FixtureLeaderboardSnapshotProvider(data)
    return this.snapshotProvider.getSnapshots()
  }
}
