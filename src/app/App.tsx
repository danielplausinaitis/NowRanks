import { useEffect, useMemo, useRef, useState } from 'react'
import { calculateMovement, rankEntries } from '../domain/leaderboard'
import { reportScoringDiagnostics } from '../domain/scoring'
import type { Category, LeaderboardEntry, RankingMode, TimeWindow } from '../domain/types'
import { CATEGORIES } from '../domain/types'
import { GoogleTrendingNowSearchDataProvider } from '../data/googleTrendingNowProvider'
import { fetchLeaderboard, LeaderboardApiError, type ApiRankMovement, type LeaderboardApiResponse, type LiveLeaderboardApiResponse, type ReplayLeaderboardApiResponse } from '../data/leaderboardApi'
import { resolveFrontendLeaderboardDataSource, type FrontendLeaderboardDataSource } from '../config/leaderboardDataSource'

const provider = new GoogleTrendingNowSearchDataProvider()
const windows: TimeWindow[] = ['24H', '7D', '30D', '1Y']
const replayDiagnosticsSource = 'Google Trending Now replay fixture'
type DashboardEntry = Pick<LeaderboardEntry, 'id' | 'topic' | 'category' | 'rank'> & { movement: LeaderboardEntry['movement'] | ApiRankMovement, score: number, emerging?: boolean }
type LeaderboardLoader = typeof fetchLeaderboard

function scoringDiagnosticsEnabled() { return import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('scoringDiagnostics') === '1' }
function movementLabel(movement: DashboardEntry['movement']) {
  if (movement !== null && typeof movement === 'object') {
    if (movement.status === 'new') return <span className="movement movement--new">NEW</span>
    if (movement.status === 'unavailable') return <span className="movement movement--flat">N/A</span>
    if (movement.status === 'unchanged') return <span className="movement movement--flat">—</span>
    return movement.delta > 0 ? <span className="movement movement--up">↑ {movement.delta}</span> : <span className="movement movement--down">↓ {Math.abs(movement.delta)}</span>
  }
  if (movement === 'NEW') return <span className="movement movement--new">NEW</span>
  if (movement === null || movement === 0) return <span className="movement movement--flat">—</span>
  return movement > 0 ? <span className="movement movement--up">↑ {movement}</span> : <span className="movement movement--down">↓ {Math.abs(movement)}</span>
}
function LeaderboardTable({ entries }: { entries: DashboardEntry[] }) {
  return <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Search topic</th><th>Category</th><th>Score</th><th>Movement</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td><span className={entry.rank < 4 ? 'rank rank--top' : 'rank'}>#{entry.rank}</span></td><td className="topic">{entry.topic}{entry.emerging && <span className="emerging-badge">Emerging</span>}</td><td><span className="category">{entry.category}</span></td><td><strong>{entry.score.toFixed(1)}</strong></td><td>{movementLabel(entry.movement)}</td></tr>)}</tbody></table></div>
}
function isLiveResponse(response: LeaderboardApiResponse): response is LiveLeaderboardApiResponse { return 'dataMode' in response }

export function App({ useLeaderboardApi = import.meta.env.VITE_USE_LEADERBOARD_API === 'true', leaderboardDataSource = resolveFrontendLeaderboardDataSource(import.meta.env), apiClient = fetchLeaderboard }: { useLeaderboardApi?: boolean, leaderboardDataSource?: FrontendLeaderboardDataSource, apiClient?: LeaderboardLoader }) {
  const [entries, setEntries] = useState<DashboardEntry[]>([])
  const [emergingEntries, setEmergingEntries] = useState<DashboardEntry[]>([])
  const [scoreMode, setScoreMode] = useState<'overallScore' | 'trendingScore'>('overallScore')
  const [category, setCategory] = useState<'All' | Category>('All')
  const [window, setWindow] = useState<TimeWindow>('7D')
  const [apiResponse, setApiResponse] = useState<LeaderboardApiResponse | null>(null)
  const [apiState, setApiState] = useState<'idle' | 'loading' | 'error' | 'success'>('idle')
  const [apiError, setApiError] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const requestVersion = useRef(0)
  const rankingMode: RankingMode = scoreMode === 'overallScore' ? 'overall' : 'trending'

  useEffect(() => {
    const version = ++requestVersion.current
    if (!useLeaderboardApi) {
      setApiResponse(null); setEmergingEntries([]); setApiState('idle')
      void (async () => {
        const [data, snapshots] = await Promise.all([provider.getAllTopicData(), provider.getSnapshots()])
        if (version !== requestVersion.current) return
        const ranked = calculateMovement(rankEntries(data, scoreMode, window), snapshots[0])
        if (scoringDiagnosticsEnabled()) reportScoringDiagnostics(ranked, scoreMode, replayDiagnosticsSource)
        setEntries(ranked.map((entry) => ({ id: entry.id, topic: entry.topic, category: entry.category, rank: entry.rank, movement: entry.movement, score: entry[scoreMode] })))
      })()
      return
    }
    const controller = new AbortController()
    setApiState('loading'); setApiError('')
    void apiClient({ window, mode: rankingMode, ...(category === 'All' ? {} : { category }), signal: controller.signal }).then((result) => {
      if (version !== requestVersion.current) return
      if (isLiveResponse(result)) {
        if (leaderboardDataSource !== 'live') throw new LeaderboardApiError('The leaderboard service returned an unexpected data source.')
        const unavailable: ApiRankMovement = { status: 'unavailable', delta: null, previousRank: null }
        const established = result.established.map((entry) => {
          const score = rankingMode === 'overall' ? entry.overallScore : entry.establishedTrendingScore
          if (score === null) throw new LeaderboardApiError('The live leaderboard returned an invalid Established score.')
          return { id: entry.candidateId, topic: entry.title || entry.query, category: entry.category, rank: entry.laneRank, movement: unavailable, score }
        })
        const emerging = result.emerging.map((entry) => {
          if (entry.emergingTrendingScore === null) throw new LeaderboardApiError('The live leaderboard returned an invalid Emerging score.')
          return { id: entry.candidateId, topic: entry.title || entry.query, category: entry.category, rank: entry.laneRank, movement: unavailable, score: entry.emergingTrendingScore, emerging: true }
        })
        setEntries(established); setEmergingEntries(rankingMode === 'trending' ? emerging : [])
      } else {
        if (leaderboardDataSource !== 'replay') throw new LeaderboardApiError('The leaderboard service returned an unexpected data source.')
        setEntries(result.entries.map((entry) => ({ id: entry.candidateId, topic: entry.topic, category: entry.category, rank: entry.rank, movement: entry.movement, score: entry.score }))); setEmergingEntries([])
      }
      setApiResponse(result); setApiState('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted || version !== requestVersion.current) return
      setApiError(error instanceof LeaderboardApiError && error.code === 'live_snapshot_not_found' ? 'No live snapshot is available for this window yet.' : 'Unable to load the persisted leaderboard.')
      setApiState('error')
    })
    return () => controller.abort()
  }, [apiClient, category, leaderboardDataSource, rankingMode, retryCount, scoreMode, useLeaderboardApi, window])

  const categories = useMemo(() => ['All', ...CATEGORIES] as const, [])
  const liveResponse = apiResponse && isLiveResponse(apiResponse) ? apiResponse : null
  const replayResponse: ReplayLeaderboardApiResponse | null = apiResponse && !isLiveResponse(apiResponse) ? apiResponse : null
  const sourceLabel = liveResponse ? `Live persisted snapshot · Updated: ${new Date(liveResponse.snapshot.scoredAt).toLocaleString()} · ${liveResponse.snapshot.selectedWindow}` : replayResponse ? `${replayResponse.metadata.dataMode.toUpperCase()}${replayResponse.metadata.dataMode === 'replay' ? ' — NOT LIVE GOOGLE DATA' : ''} · ${replayResponse.metadata.providerId} · ${replayResponse.metadata.mode} · Observed through ${replayResponse.metadata.observedThrough}` : 'Development preview · Google Trending Now replay data'
  const liveTrending = Boolean(liveResponse && rankingMode === 'trending')
  return <main className="dashboard">
    <header className="header"><a className="brand" href="#top" aria-label="NowRanks home"><span className="brand__mark">N</span>NowRanks</a><nav aria-label="Primary navigation"><a className="active" href="#leaderboard">Overall</a><a href="#leaderboard">Trending</a><a href="#categories">Categories</a><a href="#history">History</a></nav><span className="header__status"><i /> Updated daily</span></header>
    <section className="intro" id="top"><p className="eyebrow">Global search intelligence</p><h1>What the world is <em>searching</em> for now.</h1><p>NowRanks surfaces the topics combining scale, growth, accelerating attention, and sustained interest.</p></section>
    <section className="leaderboard" id="leaderboard" aria-label="Global NowRanks Top 100"><div className="leaderboard__heading"><div><p className="eyebrow">Global leaderboard</p><h2>NowRanks Top 100</h2><p className="subtle">{sourceLabel}</p></div><div className="mode-switch" aria-label="Ranking type"><button className={scoreMode === 'overallScore' ? 'selected' : ''} onClick={() => setScoreMode('overallScore')}>Overall <small>importance</small></button><button className={scoreMode === 'trendingScore' ? 'selected' : ''} onClick={() => setScoreMode('trendingScore')}>Trending <small>fastest growth</small></button></div></div>
      <div className="controls"><div className="segmented" aria-label="Time window">{windows.map((value) => <button key={value} className={window === value ? 'selected' : ''} onClick={() => setWindow(value)}>{value}</button>)}</div><label>Category <select value={category} onChange={(event) => setCategory(event.target.value as 'All' | Category)}>{categories.map((value) => <option key={value}>{value}</option>)}</select></label></div>
      <p className="definition">{scoreMode === 'overallScore' ? 'Overall combines search interest (45%), growth (25%), momentum (15%), consistency (10%), and breakout (5%).' : 'Trending emphasizes growth (40%), accelerating attention (35%), and breakout (5%); it is separate from Overall.'}</p>
      {useLeaderboardApi && apiState === 'loading' && <p className="subtle" role="status">Loading persisted leaderboard…</p>}
      {useLeaderboardApi && apiState === 'error' && <p className="empty" role="alert">{apiError} <button onClick={() => setRetryCount((count) => count + 1)}>Retry</button></p>}
      {liveTrending ? <><h3 className="lane-heading">Established Trending</h3><LeaderboardTable entries={entries} /><h3 className="lane-heading">Emerging</h3><p className="subtle">Newly emerging topics with limited historical evidence; ranked separately.</p><LeaderboardTable entries={emergingEntries} /></> : <LeaderboardTable entries={entries} />}
      {entries.length === 0 && (!useLeaderboardApi || apiState !== 'loading') && <p className="empty">No ranked topics in this category yet.</p>}
    </section>
    <footer id="history">{liveResponse ? 'Live persisted snapshot · movement is not yet available.' : 'Replay dashboard · snapshots are retained daily to power historical rank movement.'}</footer>
  </main>
}
