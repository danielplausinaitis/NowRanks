export type Category = 'Technology' | 'Gaming' | 'Sports' | 'Travel' | 'Finance' | 'Entertainment' | 'Cars' | 'Business' | 'Health'

export type TimeWindow = '24H' | '7D' | '30D' | '1Y'

export interface SearchTopic {
  id: string
  topic: string
  category: Category
}

export interface TopicObservation {
  date: string
  interest: number
}

export interface SearchTopicData extends SearchTopic {
  observations: TopicObservation[]
}

/** A normalized candidate returned by Google Trending Now (or a future equivalent). */
export interface TrendingNowRecord {
  query: string
  normalizedQuery: string
  categories: Category[]
  observedAt: string
  source: string
  searchVolume?: number
  searchVolumeLabel?: string
  trendBreakdown?: Record<string, number | string>
  newsReferences?: NewsReference[]
}

export interface NewsReference {
  title: string
  url: string
  source?: string
  publishedAt?: string
}

export interface InterestRange {
  start: string
  end: string
}

/** Google Trends-style, normalized search-interest value (0–100). */
export interface HistoricalInterestPoint extends TopicObservation {}

export interface HistoricalInterestProvider {
  getInterest(normalizedQuery: string, range: InterestRange): Promise<HistoricalInterestPoint[]>
}

export interface TrendingNowProvider {
  getTrendingNow(): Promise<TrendingNowRecord[]>
}

export interface LeaderboardSnapshotProvider {
  getSnapshots(): Promise<LeaderboardSnapshot[]>
}

export interface ComponentScores {
  searchInterest: number
  growth: number
  momentum: number
  consistency: number
}

export interface ScoredTopic extends SearchTopic {
  componentScores: ComponentScores
  overallScore: number
  trendingScore: number
}

export interface LeaderboardEntry extends ScoredTopic {
  rank: number
  previousRank?: number
  movement: number | 'NEW' | null
}

export interface LeaderboardSnapshot {
  date: string
  entries: LeaderboardEntry[]
}

export interface SearchDataProvider extends LeaderboardSnapshotProvider {
  getCandidates(): Promise<SearchTopic[]>
  getObservations(topicId: string, window: TimeWindow): Promise<TopicObservation[]>
  getAllTopicData(): Promise<SearchTopicData[]>
  getSnapshots(): Promise<LeaderboardSnapshot[]>
}
