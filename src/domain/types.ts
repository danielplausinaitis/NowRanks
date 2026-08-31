import { CATEGORIES } from '../../shared/categories.mjs'

export { CATEGORIES }
export type Category = typeof CATEGORIES[number]

export type TimeWindow = '24H' | '7D' | '30D' | '1Y'

/** Named window metadata keeps additional windows additive rather than requiring a new data shape. */
export interface RankingWindowDefinition {
  id: string
  durationDays: number
}

export type DataMode = 'live' | 'replay' | 'test'

export type CrossQueryComparabilityStatus = 'comparable' | 'not-comparable' | 'unknown'

export interface GeographicScope {
  kind: 'global' | 'country' | 'region' | 'custom'
  countryCode?: string
  regionCode?: string
  label?: string
}

/** Provenance travels with canonical candidates; provider-specific raw payloads do not. */
export interface SourceProvenance {
  providerId: string
  dataMode: DataMode
  sourceObservedAt: string
  ingestedAt: string
  geographicScope: GeographicScope
  sourceVersion?: string
  collectionMethod?: string
  crossQueryComparability: {
    status: CrossQueryComparabilityStatus
    basis?: string
  }
}

export interface SearchTopic {
  /** Stable internal identifier; it is not derived from the display label at read time. */
  id: string
  /** Human-readable query/display text. */
  topic: string
  normalizedQuery: string
  category: Category
  provenance: SourceProvenance
}

interface TopicObservationBase {
  candidateId: string
  date: string
  observedAt: string
}

/** An observed value can be zero; it is distinct from a source that did not provide a value. */
export interface AvailableInterestObservation extends TopicObservationBase {
  availability: 'available'
  interest: number
}

export interface MissingInterestObservation extends TopicObservationBase {
  availability: 'missing'
  interest: null
  missingReason: 'not-reported' | 'source-unavailable' | 'out-of-range' | 'redacted'
}

export type TopicObservation = AvailableInterestObservation | MissingInterestObservation

export interface SearchTopicData extends SearchTopic {
  observations: TopicObservation[]
}

/** A provider-independent historical observation request. */
export interface HistoricalInterestQuery {
  candidate: SearchTopic
  range: InterestRange
}

export interface InterestRange {
  start: string
  end: string
}

/** Google Trends-style interest values are normalized source measurements, not absolute search volume. */
export type HistoricalInterestPoint = TopicObservation

export interface HistoricalInterestProvider {
  getInterest(query: HistoricalInterestQuery): Promise<HistoricalInterestPoint[]>
}

export interface TrendingNowProvider {
  getTrendingNow(): Promise<TrendingNowRecord[]>
}

export interface LeaderboardSnapshotProvider {
  getSnapshots(): Promise<LeaderboardSnapshot[]>
}

export const SCORE_COMPONENT_KEYS = ['searchInterest', 'growth', 'momentum', 'consistency', 'breakout'] as const

export type ScoreComponentKey = typeof SCORE_COMPONENT_KEYS[number]

/** Every component is normalized to the same 0–100 cohort-relative scale before weighting. */
export type ComponentScores = Record<ScoreComponentKey, number>

export type ComponentWeights = Record<ScoreComponentKey, number>

export type ScoringMode = 'overallScore' | 'trendingScore'

export interface ScoredTopic extends SearchTopic {
  componentScores: ComponentScores
  /** Primary five-factor score used by the Overall ranking. */
  finalScore: number
  overallScore: number
  trendingScore: number
}

/** Flat diagnostic row designed for browser developer tools and automated model checks. */
export interface ScoringDiagnostic {
  source: string
  scoreProfile: 'overall' | 'trending'
  query: string
  category: Category
  finalScore: number
  searchInterestComponent: number
  growthComponent: number
  momentumComponent: number
  consistencyComponent: number
  breakoutComponent: number
  searchInterestWeight: number
  growthWeight: number
  momentumWeight: number
  consistencyWeight: number
  breakoutWeight: number
  searchInterestWeightedContribution: number
  growthWeightedContribution: number
  momentumWeightedContribution: number
  consistencyWeightedContribution: number
  breakoutWeightedContribution: number
  finalWeightedContribution: number
}

export interface LeaderboardEntry extends ScoredTopic {
  rank: number
  previousRank?: number
  movement: number | 'NEW' | null
}

/** Immutable daily ranking result for one scoring mode and one selected time window. */
export interface LeaderboardSnapshot {
  date: string
  snapshotAt: string
  scoringMode: ScoringMode
  selectedWindow: TimeWindow
  entries: LeaderboardEntry[]
}

export interface SearchDataProvider extends LeaderboardSnapshotProvider {
  getCandidates(): Promise<SearchTopic[]>
  getObservations(topicId: string, window: TimeWindow): Promise<TopicObservation[]>
  getAllTopicData(): Promise<SearchTopicData[]>
  getSnapshots(): Promise<LeaderboardSnapshot[]>
}

/** A normalized candidate returned by Google Trending Now (or a future equivalent). */
export interface TrendingNowRecord {
  query: string
  normalizedQuery: string
  categories: Category[]
  observedAt: string
  source: string
  provenance: SourceProvenance
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
