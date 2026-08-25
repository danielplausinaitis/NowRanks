import type { Category, HistoricalInterestPoint, HistoricalInterestProvider, InterestRange, LeaderboardSnapshot, LeaderboardSnapshotProvider, SearchDataProvider, SearchTopic, SearchTopicData, TimeWindow, TopicObservation, TrendingNowProvider, TrendingNowRecord } from '../domain/types'
import { TIME_WINDOWS } from '../domain/config'
import { rankEntries } from '../domain/leaderboard'
import { googleInterestReplayFixture, googleTrendingNowReplay, type GoogleTrendingNowReplayResponse } from './googleTrendingNowReplay.fixture'

const categoryMap: Record<string, Category> = {
  technology: 'Technology', games: 'Gaming', sports: 'Sports', travel: 'Travel', finance: 'Finance',
  'arts & entertainment': 'Entertainment', 'autos & vehicles': 'Cars', business: 'Business', health: 'Health',
}

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
  async getInterest(normalizedQuery: string, range: InterestRange): Promise<HistoricalInterestPoint[]> {
    const values = googleInterestReplayFixture[normalizedQuery] ?? []
    const days = Math.max(1, Math.floor((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1)
    return values.slice(-days).map((interest, index, points) => ({
      date: new Date(Date.parse(range.end) - (points.length - 1 - index) * 86_400_000).toISOString().slice(0, 10), interest,
    }))
  }
}

export class FixtureLeaderboardSnapshotProvider implements LeaderboardSnapshotProvider {
  constructor(private readonly data: SearchTopicData[]) {}
  async getSnapshots(): Promise<LeaderboardSnapshot[]> {
    const previous = this.data.map((item, index) => ({ ...item, observations: item.observations.map((point, day) => ({ ...point, interest: Math.max(0, point.interest - (day > 23 ? (index % 5) : 0)) })) }))
    return [{ date: '2026-08-24', entries: rankEntries(previous) }, { date: '2026-08-25', entries: rankEntries(this.data) }]
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
    return (await this.candidateProvider.getTrendingNow()).map((record) => ({ id: `google:${record.normalizedQuery}`, topic: record.query, category: record.categories[0] }))
  }

  async getObservations(topicId: string, window: TimeWindow): Promise<TopicObservation[]> {
    const item = (await this.getAllTopicData()).find((candidate) => candidate.id === topicId)
    return item?.observations.slice(-TIME_WINDOWS[window]) ?? []
  }

  async getAllTopicData(): Promise<SearchTopicData[]> {
    if (!this.cachedData) {
      const candidates = await this.getCandidates()
      const range = { start: '2026-07-27T00:00:00.000Z', end: '2026-08-25T00:00:00.000Z' }
      this.cachedData = await Promise.all(candidates.map(async (candidate) => ({ ...candidate, observations: await this.interestProvider.getInterest(candidate.id.replace('google:', ''), range) })))
    }
    return this.cachedData.map((item) => ({ ...item, observations: [...item.observations] }))
  }

  async getSnapshots(): Promise<LeaderboardSnapshot[]> {
    const data = await this.getAllTopicData()
    this.snapshotProvider ??= new FixtureLeaderboardSnapshotProvider(data)
    return this.snapshotProvider.getSnapshots()
  }
}
