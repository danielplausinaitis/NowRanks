import { useEffect, useMemo, useState } from 'react'
import { calculateMovement, rankEntries } from '../domain/leaderboard'
import { reportScoringDiagnostics } from '../domain/scoring'
import type { Category, LeaderboardEntry, TimeWindow } from '../domain/types'
import { GoogleTrendingNowSearchDataProvider } from '../data/googleTrendingNowProvider'

const provider = new GoogleTrendingNowSearchDataProvider()
const windows: TimeWindow[] = ['24H', '7D', '30D', '1Y']
const replayDiagnosticsSource = 'Google Trending Now replay fixture'

function scoringDiagnosticsEnabled() {
  return import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('scoringDiagnostics') === '1'
}

function movementLabel(movement: LeaderboardEntry['movement']) {
  if (movement === 'NEW') return <span className="movement movement--new">NEW</span>
  if (movement === null || movement === 0) return <span className="movement movement--flat">—</span>
  return movement > 0 ? <span className="movement movement--up">↑ {movement}</span> : <span className="movement movement--down">↓ {Math.abs(movement)}</span>
}

export function App() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [scoreMode, setScoreMode] = useState<'overallScore' | 'trendingScore'>('overallScore')
  const [category, setCategory] = useState<'All' | Category>('All')
  const [window, setWindow] = useState<TimeWindow>('7D')
  useEffect(() => { void (async () => {
    const [data, snapshots] = await Promise.all([provider.getAllTopicData(), provider.getSnapshots()])
    const ranked = calculateMovement(rankEntries(data, scoreMode, window), snapshots[0])
    if (scoringDiagnosticsEnabled()) reportScoringDiagnostics(ranked, scoreMode, replayDiagnosticsSource)
    setEntries(ranked)
  })() }, [scoreMode, window])
  const categories = useMemo(() => ['All', ...Array.from(new Set(entries.map((entry) => entry.category)))] as const, [entries])
  const visibleEntries = category === 'All' ? entries : entries.filter((entry) => entry.category === category)
  return <main className="dashboard">
    <header className="header"><a className="brand" href="#top" aria-label="NowRanks home"><span className="brand__mark">N</span>NowRanks</a><nav aria-label="Primary navigation"><a className="active" href="#leaderboard">Overall</a><a href="#leaderboard">Trending</a><a href="#categories">Categories</a><a href="#history">History</a></nav><span className="header__status"><i /> Updated daily</span></header>
    <section className="intro" id="top"><p className="eyebrow">Global search intelligence</p><h1>What the world is <em>searching</em> for now.</h1><p>NowRanks surfaces the topics combining scale, growth, accelerating attention, and sustained interest.</p></section>
    <section className="leaderboard" id="leaderboard" aria-label="Global NowRanks Top 100"><div className="leaderboard__heading"><div><p className="eyebrow">Global leaderboard</p><h2>NowRanks Top 100</h2><p className="subtle">Development preview · Google Trending Now replay data</p></div><div className="mode-switch" aria-label="Ranking type"><button className={scoreMode === 'overallScore' ? 'selected' : ''} onClick={() => setScoreMode('overallScore')}>Overall <small>importance</small></button><button className={scoreMode === 'trendingScore' ? 'selected' : ''} onClick={() => setScoreMode('trendingScore')}>Trending <small>fastest growth</small></button></div></div>
      <div className="controls"><div className="segmented" aria-label="Time window">{windows.map((value) => <button key={value} className={window === value ? 'selected' : ''} onClick={() => setWindow(value)}>{value}</button>)}</div><label>Category <select value={category} onChange={(event) => setCategory(event.target.value as 'All' | Category)}>{categories.map((value) => <option key={value}>{value}</option>)}</select></label></div>
      <p className="definition">{scoreMode === 'overallScore' ? 'Overall combines search interest (45%), growth (25%), momentum (15%), consistency (10%), and breakout (5%).' : 'Trending emphasizes growth (40%), accelerating attention (35%), and breakout (5%); it is separate from Overall.'}</p>
      <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Search topic</th><th>Category</th><th>Score</th><th>Movement</th></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={entry.id}><td><span className={entry.rank < 4 ? 'rank rank--top' : 'rank'}>#{entry.rank}</span></td><td className="topic">{entry.topic}</td><td><span className="category">{entry.category}</span></td><td><strong>{entry[scoreMode].toFixed(1)}</strong></td><td>{movementLabel(entry.movement)}</td></tr>)}</tbody></table></div>{visibleEntries.length === 0 && <p className="empty">No ranked topics in this category yet.</p>}</section>
    <footer id="history">Replay dashboard · snapshots are retained daily to power historical rank movement.</footer>
  </main>
}
