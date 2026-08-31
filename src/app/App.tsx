import { useEffect, useMemo, useRef, useState } from 'react'
import { calculateMovement, rankEntries } from '../domain/leaderboard'
import { reportScoringDiagnostics } from '../domain/scoring'
import type { Category, LeaderboardEntry, TimeWindow } from '../domain/types'
import { CATEGORIES } from '../domain/types'
import { GoogleTrendingNowSearchDataProvider } from '../data/googleTrendingNowProvider'
import { fetchLeaderboard, type LeaderboardApiResponse } from '../data/leaderboardApi'

const provider = new GoogleTrendingNowSearchDataProvider()
const windows: TimeWindow[] = ['24H', '7D', '30D', '1Y']
const replayDiagnosticsSource = 'Google Trending Now replay fixture'

type DashboardEntry = Pick<LeaderboardEntry, 'id' | 'topic' | 'category' | 'rank' | 'movement'> & { score: number }
type LeaderboardLoader = typeof fetchLeaderboard

function scoringDiagnosticsEnabled() {
  return import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('scoringDiagnostics') === '1'
}

function movementLabel(movement: LeaderboardEntry['movement']) {
  if (movement === 'NEW') return <span className="movement movement--new">NEW</span>
  if (movement === null || movement === 0) return <span className="movement movement--flat">—</span>
  return movement > 0 ? <span className="movement movement--up">↑ {movement}</span> : <span className="movement movement--down">↓ {Math.abs(movement)}</span>
}

export function App({ useLeaderboardApi = import.meta.env.VITE_USE_LEADERBOARD_API === 'true', apiClient = fetchLeaderboard }: { useLeaderboardApi?: boolean, apiClient?: LeaderboardLoader }) {
  const [entries, setEntries] = useState<DashboardEntry[]>([])
  const [scoreMode, setScoreMode] = useState<'overallScore' | 'trendingScore'>('overallScore')
  const [category, setCategory] = useState<'All' | Category>('All')
  const [window, setWindow] = useState<TimeWindow>('7D')
  const [apiMetadata, setApiMetadata] = useState<LeaderboardApiResponse['metadata'] | null>(null)
  const [apiState, setApiState] = useState<'idle' | 'loading' | 'error' | 'success'>('idle')
  const [retryCount, setRetryCount] = useState(0)
  const requestVersion = useRef(0)
  const effectiveScoreMode = useLeaderboardApi ? 'overallScore' : scoreMode

  useEffect(() => {
    const version = ++requestVersion.current
    if (!useLeaderboardApi) {
      setApiMetadata(null)
      setApiState('idle')
      void (async () => {
        const [data, snapshots] = await Promise.all([provider.getAllTopicData(), provider.getSnapshots()])
        if (version !== requestVersion.current) return
        const ranked = calculateMovement(rankEntries(data, effectiveScoreMode, window), snapshots[0])
        if (scoringDiagnosticsEnabled()) reportScoringDiagnostics(ranked, effectiveScoreMode, replayDiagnosticsSource)
        setEntries(ranked.map((entry) => ({ id: entry.id, topic: entry.topic, category: entry.category, rank: entry.rank, movement: entry.movement, score: entry[effectiveScoreMode] })))
      })()
      return
    }

    const controller = new AbortController()
    setApiState('loading')
    void apiClient({ window, ...(category === 'All' ? {} : { category }), signal: controller.signal })
      .then((result) => {
        if (version !== requestVersion.current) return
        setApiMetadata(result.metadata)
        setEntries(result.entries.map((entry) => ({ id: entry.candidateId, topic: entry.topic, category: entry.category, rank: entry.rank, movement: null, score: entry.score })))
        setApiState('success')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || version !== requestVersion.current) return
        setApiState('error')
      })
    return () => controller.abort()
  }, [apiClient, category, effectiveScoreMode, retryCount, useLeaderboardApi, window])
  const categories = useMemo(() => ['All', ...CATEGORIES] as const, [])
  const visibleEntries = entries
  const sourceLabel = apiMetadata
    ? `${apiMetadata.dataMode.toUpperCase()}${apiMetadata.dataMode === 'replay' ? ' — NOT LIVE GOOGLE DATA' : ''} · ${apiMetadata.providerId} · Observed through ${apiMetadata.observedThrough}`
    : 'Development preview · Google Trending Now replay data'
  return <main className="dashboard">
    <header className="header"><a className="brand" href="#top" aria-label="NowRanks home"><span className="brand__mark">N</span>NowRanks</a><nav aria-label="Primary navigation"><a className="active" href="#leaderboard">Overall</a><a href="#leaderboard">Trending</a><a href="#categories">Categories</a><a href="#history">History</a></nav><span className="header__status"><i /> Updated daily</span></header>
    <section className="intro" id="top"><p className="eyebrow">Global search intelligence</p><h1>What the world is <em>searching</em> for now.</h1><p>NowRanks surfaces the topics combining scale, growth, accelerating attention, and sustained interest.</p></section>
    <section className="leaderboard" id="leaderboard" aria-label="Global NowRanks Top 100"><div className="leaderboard__heading"><div><p className="eyebrow">Global leaderboard</p><h2>NowRanks Top 100</h2><p className="subtle">{sourceLabel}</p></div><div className="mode-switch" aria-label="Ranking type"><button className={effectiveScoreMode === 'overallScore' ? 'selected' : ''} onClick={() => setScoreMode('overallScore')}>Overall <small>importance</small></button><button className={effectiveScoreMode === 'trendingScore' ? 'selected' : ''} onClick={() => setScoreMode('trendingScore')} disabled={useLeaderboardApi} title={useLeaderboardApi ? 'The current API exposes the Overall leaderboard only.' : undefined}>Trending <small>fastest growth</small></button></div></div>
      <div className="controls"><div className="segmented" aria-label="Time window">{windows.map((value) => <button key={value} className={window === value ? 'selected' : ''} onClick={() => setWindow(value)}>{value}</button>)}</div><label>Category <select value={category} onChange={(event) => setCategory(event.target.value as 'All' | Category)}>{categories.map((value) => <option key={value}>{value}</option>)}</select></label></div>
      <p className="definition">{effectiveScoreMode === 'overallScore' ? 'Overall combines search interest (45%), growth (25%), momentum (15%), consistency (10%), and breakout (5%).' : 'Trending emphasizes growth (40%), accelerating attention (35%), and breakout (5%); it is separate from Overall.'}</p>
      {useLeaderboardApi && apiState === 'loading' && <p className="subtle" role="status">Loading persisted leaderboard…</p>}
      {useLeaderboardApi && apiState === 'error' && <p className="empty" role="alert">Unable to load the persisted leaderboard. <button onClick={() => setRetryCount((count) => count + 1)}>Retry</button></p>}
      <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Search topic</th><th>Category</th><th>Score</th><th>Movement</th></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={entry.id}><td><span className={entry.rank < 4 ? 'rank rank--top' : 'rank'}>#{entry.rank}</span></td><td className="topic">{entry.topic}</td><td><span className="category">{entry.category}</span></td><td><strong>{entry.score.toFixed(1)}</strong></td><td>{movementLabel(entry.movement)}</td></tr>)}</tbody></table></div>{visibleEntries.length === 0 && (!useLeaderboardApi || apiState !== 'loading') && <p className="empty">No ranked topics in this category yet.</p>}</section>
    <footer id="history">Replay dashboard · snapshots are retained daily to power historical rank movement.</footer>
  </main>
}
