import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { calculateMovement, rankEntries } from '../domain/leaderboard'
import { reportScoringDiagnostics } from '../domain/scoring'
import type { Category, LeaderboardEntry, RankingMode, TimeWindow } from '../domain/types'
import { CATEGORIES } from '../domain/types'
import { GoogleTrendingNowSearchDataProvider } from '../data/googleTrendingNowProvider'
import { fetchLeaderboard, LeaderboardApiError, type ApiRankMovement, type LeaderboardApiResponse, type LiveLeaderboardApiResponse, type LiveRankMovement, type ReplayLeaderboardApiResponse } from '../data/leaderboardApi'
import { resolveFrontendLeaderboardDataSource, type FrontendLeaderboardDataSource } from '../config/leaderboardDataSource'
import { createBrowserAuthClient, type AuthClient, type AuthUser } from '../auth/authClient'
import { createAnalytics, type Analytics } from '../analytics/events'

const provider = new GoogleTrendingNowSearchDataProvider()
const defaultAuthClient = createBrowserAuthClient()
const defaultAnalytics = createAnalytics()
const windows: TimeWindow[] = ['24H', '7D', '30D', '1Y']
const replayDiagnosticsSource = 'Google Trending Now replay fixture'
type DashboardEntry = Pick<LeaderboardEntry, 'id' | 'topic' | 'category' | 'rank'> & { movement: LeaderboardEntry['movement'] | ApiRankMovement | LiveRankMovement, score: number, lane?: 'established' | 'emerging', displayPosition?: number, trendHeat: 'stable' | 'rising' | 'fast' | 'surging' | 'exploding' | null, growthPercent: number | null }
type LeaderboardLoader = typeof fetchLeaderboard

type Route = 'rankings' | 'premium' | 'account' | 'about' | 'methodology' | 'privacy' | 'terms' | 'not-found'
function useHashRoute(): Route {
  const read = () => { const value = window.location.hash.replace(/^#\/?/, '').toLowerCase(); return value === '' || value === 'rankings' ? 'rankings' : ['premium', 'account', 'about', 'methodology', 'privacy', 'terms'].includes(value) ? value as Route : 'not-found' }
  const [route, setRoute] = useState<Route>(read)
  useEffect(() => { const update = () => setRoute(read()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  return route
}

function scoringDiagnosticsEnabled() { return import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('scoringDiagnostics') === '1' }
function movementLabel(movement: DashboardEntry['movement']) {
  if (movement !== null && typeof movement === 'object') {
    if ('state' in movement) {
      if (movement.state === 'new') return <span className="movement movement--new">NEW</span>
      if (movement.state === 'unavailable') return <span className="movement movement--flat">N/A</span>
      if (movement.state === 'unchanged') return <span className="movement movement--flat">—</span>
      return movement.state === 'up' ? <span className="movement movement--up">↑ {movement.delta}</span> : <span className="movement movement--down">↓ {Math.abs(movement.delta)}</span>
    }
    if (movement.status === 'new') return <span className="movement movement--new">NEW</span>
    if (movement.status === 'unavailable') return <span className="movement movement--flat">N/A</span>
    if (movement.status === 'unchanged') return <span className="movement movement--flat">—</span>
    return movement.delta > 0 ? <span className="movement movement--up">↑ {movement.delta}</span> : <span className="movement movement--down">↓ {Math.abs(movement.delta)}</span>
  }
  if (movement === 'NEW') return <span className="movement movement--new">NEW</span>
  if (movement === null || movement === 0) return <span className="movement movement--flat">—</span>
  return movement > 0 ? <span className="movement movement--up">↑ {movement}</span> : <span className="movement movement--down">↓ {Math.abs(movement)}</span>
}
function heatLabel(heat: DashboardEntry['trendHeat']) {
  return heat ? <span className={`heat heat--${heat}`}><i aria-hidden="true" />{heat}</span> : <span className="heat heat--unavailable">Evidence pending</span>
}
function growthLabel(growthPercent: number | null) {
  return growthPercent === null ? <span className="growth growth--unavailable">No comparison</span> : <span className={growthPercent >= 0 ? 'growth growth--positive' : 'growth growth--negative'}>{growthPercent > 0 ? '+' : ''}{Math.round(growthPercent)}%</span>
}
function LeaderboardTable({ entries, unifiedTrending = false }: { entries: DashboardEntry[], unifiedTrending?: boolean }) {
  return <div className="table-wrap"><table><thead><tr><th>{unifiedTrending ? 'Position' : 'Rank'}</th><th>Search topic</th>{unifiedTrending && <th>Status</th>}<th>Heat</th><th>Growth</th><th>Category</th><th>Score</th><th>Movement</th></tr></thead><tbody>{entries.map((entry) => {
    const position = unifiedTrending ? entry.displayPosition : entry.rank
    return <tr key={entry.id}><td><span className={position !== undefined && position < 4 ? 'rank rank--top' : 'rank'}>#{position}</span></td><td className="topic">{entry.topic}</td>{unifiedTrending && <td><span className={`status-badge status-badge--${entry.lane}`}>{entry.lane === 'emerging' ? 'Emerging' : 'Established'}</span></td>}<td>{heatLabel(entry.trendHeat)}</td><td>{growthLabel(entry.growthPercent)}</td><td><span className="category">{entry.category}</span></td><td><div className="score"><strong>{entry.score.toFixed(1)}</strong><span className="score__meter" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, entry.score))}%` }} /></span></div></td><td>{movementLabel(entry.movement)}</td></tr>
  })}</tbody></table></div>
}
function isLiveResponse(response: LeaderboardApiResponse): response is LiveLeaderboardApiResponse { return 'dataMode' in response }

function PageShell({ title, eyebrow, children }: { title: string, eyebrow: string, children: ReactNode }) {
  return <main className="dashboard"><header className="header"><a className="brand" href="#/rankings"><span className="brand__mark">N</span>NowRanks</a><nav aria-label="Primary navigation"><a href="#/rankings">Rankings</a><a className="nav-premium" href="#/premium">Premium</a><a href="#/methodology">Methodology</a></nav></header><article className="content-page"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children}</article><footer>© NowRanks · <a href="#/privacy">Privacy</a> · <a href="#/terms">Terms</a> · <a href="#/about">About</a></footer></main>
}

function ProductPage({ route, user, authReady, onSignIn, onSignOut }: { route: Route, user: AuthUser | null, authReady: boolean, onSignIn: () => void, onSignOut: () => void }) {
  if (route === 'not-found') return <PageShell eyebrow="404" title="This signal has moved."><p>The page you requested is not here. <a href="#/rankings">Return to rankings</a>.</p></PageShell>
  if (route === 'premium') return <PageShell eyebrow="NowRanks Premium" title="See the signal before it becomes obvious."><div className="premium-hero"><p>Premium is being designed for people who want deeper context, not louder numbers.</p><div className="feature-grid"><section><b>Available now</b><h3>Open rankings</h3><p>Explore the public global leaderboard and its evidence-based timeframes.</p></section><section><b>Coming soon</b><h3>Signals you can keep</h3><p>Watchlists, alerts, deeper history, categories and country-specific views.</p></section></div><button disabled title="Payments are not connected yet">Premium coming soon</button><p className="subtle">No payment or checkout is connected in this MVP.</p></div></PageShell>
  if (route === 'account') return <PageShell eyebrow="Your account" title={user ? `Welcome${user.name ? `, ${user.name}` : ''}.` : 'Your NowRanks account.'}>{!authReady ? <p role="status">Checking your secure session…</p> : user ? <section className="account-card">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="avatar">{(user.name ?? user.email ?? 'N').slice(0, 1)}</span>}<div><h3>{user.name ?? 'NowRanks member'}</h3><p>{user.email}</p><p className="membership">FREE</p>{user.createdAt && <p className="subtle">Joined {new Date(user.createdAt).toLocaleDateString()}</p>}</div><button onClick={onSignOut}>Sign out</button><p className="subtle">Saved topics and alerts will appear here when available.</p></section> : <section className="account-card"><h3>Save the internet signals that matter to you.</h3><p>Sign in with Google to prepare your account for upcoming watchlists and alerts.</p><button onClick={onSignIn}>Continue with Google</button></section>}</PageShell>
  const copy: Record<Exclude<Route, 'rankings' | 'premium' | 'account' | 'not-found'>, { eyebrow: string, title: string, body: ReactNode }> = {
    about: { eyebrow: 'About NowRanks', title: 'The internet moves too fast. NowRanks makes it readable.', body: <><p>NowRanks helps people understand what the internet is paying attention to—ranked. We turn public and third-party attention signals into a calmer, more useful view of momentum.</p><p>Rankings are estimates, not endorsements or objective truth.</p></> },
    methodology: { eyebrow: 'Methodology', title: 'Attention, made legible.', body: <><p>NowRanks combines multiple public and third-party signals of search and online attention to estimate what is gaining momentum. Each timeframe evaluates its own evidence: 24H, 7D, 30D and 1Y are not interchangeable.</p><p>Trending emphasizes acceleration and momentum. Established and Emerging topics remain separate evidence lanes; an Emerging score is never presented as comparable Overall importance. Data can be delayed, incomplete, corrected or unavailable, and rankings can change as evidence changes.</p><p>Heat labels are a visual reading of available Trending components and score: Stable, Rising, Fast, Surging and Exploding. A growth percentage appears only when the underlying valid comparison is meaningful.</p></> },
    privacy: { eyebrow: 'Privacy Policy · owner review required', title: 'Privacy without guesswork.', body: <><p>This MVP template should be reviewed by the owner before public launch. If you sign in, NowRanks may receive the identity information supplied by your authentication provider, such as name, email and avatar, plus session data needed to keep you signed in.</p><p>We use that information to provide account features. We do not claim analytics, advertising, sale of personal data, or compliance certifications that are not implemented. A future analytics provider must be disclosed here before activation. Contact and retention details require owner completion.</p></> },
    terms: { eyebrow: 'Terms of Use · owner review required', title: 'A clear starting point.', body: <><p>This MVP template is not legal advice and requires owner and legal review before launch. By using NowRanks, you agree to use the service lawfully and protect your account. Rankings are informational algorithmic estimates based partly on third-party services; they are not guarantees of accuracy, completeness or endorsement.</p><p>The owner may change, suspend, or terminate the service. Subscription terms will be added only when payments are offered. Governing law, legal entity, address and contact details must be completed by the owner.</p></> },
  }
  const page = copy[route as keyof typeof copy]
  return <PageShell eyebrow={page.eyebrow} title={page.title}>{page.body}</PageShell>
}

export function App({ useLeaderboardApi = import.meta.env.VITE_USE_LEADERBOARD_API === 'true', leaderboardDataSource = resolveFrontendLeaderboardDataSource(import.meta.env), apiClient = fetchLeaderboard, authClient = defaultAuthClient, analytics = defaultAnalytics }: { useLeaderboardApi?: boolean, leaderboardDataSource?: FrontendLeaderboardDataSource, apiClient?: LeaderboardLoader, authClient?: AuthClient | null, analytics?: Analytics }) {
  const [entries, setEntries] = useState<DashboardEntry[]>([])
  const [emergingEntries, setEmergingEntries] = useState<DashboardEntry[]>([])
  const [scoreMode, setScoreMode] = useState<'overallScore' | 'trendingScore'>('overallScore')
  const [category, setCategory] = useState<'All' | Category>('All')
  const [window, setWindow] = useState<TimeWindow>('7D')
  const [apiResponse, setApiResponse] = useState<LeaderboardApiResponse | null>(null)
  const [apiState, setApiState] = useState<'idle' | 'loading' | 'error' | 'success'>('idle')
  const [apiError, setApiError] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authReady, setAuthReady] = useState(!authClient)
  const [authError, setAuthError] = useState('')
  const requestVersion = useRef(0)
  const route = useHashRoute()
  const rankingMode: RankingMode = scoreMode === 'overallScore' ? 'overall' : 'trending'

  useEffect(() => {
    analytics.track('app_open')
    if (!authClient) return
    let active = true
    void authClient.getUser().then((nextUser) => { if (active) { setUser(nextUser); setAuthReady(true); if (nextUser) analytics.track('sign_in_completed') } }).catch(() => { if (active) { setAuthError('Sign-in is unavailable right now. Please try again later.'); setAuthReady(true) } })
    return authClient.onChange((nextUser) => { setUser(nextUser); setAuthReady(true); if (nextUser) analytics.track('sign_in_completed') })
  }, [analytics, authClient])

  const signIn = async () => {
    if (!authClient) { setAuthError('Google sign-in is not configured for this environment yet.'); return }
    setAuthError(''); analytics.track('sign_in_started')
    const result = await authClient.signInWithGoogle()
    if (result.error) setAuthError('Google sign-in could not start. Please try again.')
  }
  const signOut = async () => { if (authClient) { const result = await authClient.signOut(); if (result.error) setAuthError('Could not sign out. Please try again.') } }

  useEffect(() => {
    const version = ++requestVersion.current
    if (!useLeaderboardApi) {
      setApiResponse(null); setEmergingEntries([]); setApiState('idle')
      void (async () => {
        const [data, snapshots] = await Promise.all([provider.getAllTopicData(), provider.getSnapshots()])
        if (version !== requestVersion.current) return
        const ranked = calculateMovement(rankEntries(data, scoreMode, window), snapshots[0])
        if (scoringDiagnosticsEnabled()) reportScoringDiagnostics(ranked, scoreMode, replayDiagnosticsSource)
        setEntries(ranked.map((entry) => ({ id: entry.id, topic: entry.topic, category: entry.category, rank: entry.rank, movement: entry.movement, score: entry[scoreMode], trendHeat: null, growthPercent: null })))
      })()
      return
    }
    const controller = new AbortController()
    setApiState('loading'); setApiError('')
    void apiClient({ window, mode: rankingMode, ...(category === 'All' ? {} : { category }), signal: controller.signal }).then((result) => {
      if (version !== requestVersion.current) return
      if (isLiveResponse(result)) {
        if (leaderboardDataSource !== 'live') throw new LeaderboardApiError('The leaderboard service returned an unexpected data source.')
        const established = result.established.map((entry) => {
          const score = rankingMode === 'overall' ? entry.overallScore : entry.establishedTrendingScore
          if (score === null) throw new LeaderboardApiError('The live leaderboard returned an invalid Established score.')
          return { id: entry.candidateId, topic: entry.title || entry.query, category: entry.category, rank: entry.laneRank, movement: entry.movement, score, lane: 'established' as const, trendHeat: entry.trendHeat ?? null, growthPercent: entry.growthPercent ?? null }
        })
        const emerging = result.emerging.map((entry) => {
          if (entry.emergingTrendingScore === null) throw new LeaderboardApiError('The live leaderboard returned an invalid Emerging score.')
          return { id: entry.candidateId, topic: entry.title || entry.query, category: entry.category, rank: entry.laneRank, movement: entry.movement, score: entry.emergingTrendingScore, lane: 'emerging' as const, trendHeat: entry.trendHeat ?? null, growthPercent: entry.growthPercent ?? null }
        })
        setEntries(established); setEmergingEntries(rankingMode === 'trending' ? emerging : [])
      } else {
        if (leaderboardDataSource !== 'replay') throw new LeaderboardApiError('The leaderboard service returned an unexpected data source.')
        setEntries(result.entries.map((entry) => ({ id: entry.candidateId, topic: entry.topic, category: entry.category, rank: entry.rank, movement: entry.movement, score: entry.score, trendHeat: null, growthPercent: null }))); setEmergingEntries([])
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
  const displayedTrendingEntries = liveTrending
    ? [...entries, ...emergingEntries].map((entry, index) => ({ ...entry, displayPosition: index + 1 }))
    : entries
  const liveOverallEmpty = Boolean(liveResponse && rankingMode === 'overall' && entries.length === 0)
  const liveOverallShort = Boolean(liveResponse && rankingMode === 'overall' && entries.length > 0 && entries.length < 10)
  useEffect(() => { if (route === 'rankings') analytics.track('rankings_view', { window, mode: rankingMode }) }, [analytics, rankingMode, route, window])
  useEffect(() => { if (route === 'premium') analytics.track('premium_view') }, [analytics, route])
  if (route !== 'rankings') return <ProductPage route={route} user={user} authReady={authReady} onSignIn={signIn} onSignOut={signOut} />
  return <main className="dashboard">
    <header className="header"><a className="brand" href="#/rankings" aria-label="NowRanks home"><span className="brand__mark">N</span>NowRanks</a><nav aria-label="Primary navigation"><a className="active" href="#/rankings">Rankings</a><a className="nav-premium" href="#/premium">Premium</a><a href="#/methodology">Methodology</a></nav>{user ? <a className="account-link" href="#/account">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : (user.name ?? user.email ?? 'Account').slice(0, 1)}</a> : <button className="sign-in" onClick={signIn}>Sign in</button>}<span className="header__status"><i /> {liveResponse ? 'Live snapshot' : 'Updated daily'}</span></header>
    <section className="intro" id="top"><p className="eyebrow">Global search intelligence</p><h1>What the world is <em>searching</em> for now.</h1><p>NowRanks surfaces the topics combining scale, growth, accelerating attention, and sustained interest.</p></section>
    <section className="leaderboard" id="leaderboard" aria-label={liveResponse ? 'Global NowRanks Top 10' : 'Global NowRanks Top 100'}><div className="leaderboard__heading"><div><p className="eyebrow">Global leaderboard</p><h2>{liveResponse ? 'NowRanks Top 10' : 'NowRanks Top 100'}</h2><p className="subtle">{sourceLabel}</p>{liveResponse && <p className="subtle">Up to 10 ranked topics are shown when source evidence meets the eligibility rules.</p>}</div><div className="mode-switch" aria-label="Ranking type"><button className={scoreMode === 'overallScore' ? 'selected' : ''} onClick={() => { setScoreMode('overallScore'); analytics.track('mode_changed', { mode: 'overall' }) }}>Overall <small>importance</small></button><button className={scoreMode === 'trendingScore' ? 'selected' : ''} onClick={() => { setScoreMode('trendingScore'); analytics.track('mode_changed', { mode: 'trending' }) }}>Trending <small>fastest growth</small></button></div></div>
      <div className="controls"><div className="segmented" aria-label="Time window">{windows.map((value) => <button key={value} className={window === value ? 'selected' : ''} onClick={() => { setWindow(value); analytics.track('window_changed', { window: value }) }}>{value}</button>)}</div><label>Category <select value={category} onChange={(event) => setCategory(event.target.value as 'All' | Category)}>{categories.map((value) => <option key={value}>{value}</option>)}</select></label></div>
      <p className="definition">{scoreMode === 'overallScore' ? 'Ranks established topics by overall importance and sustained attention.' : 'Ranks topics gaining attention fastest right now.'}</p>
      {useLeaderboardApi && apiState === 'loading' && <p className="subtle" role="status">Loading persisted leaderboard…</p>}
      {useLeaderboardApi && apiState === 'error' && <p className="empty" role="alert">{apiError} <button onClick={() => setRetryCount((count) => count + 1)}>Retry</button></p>}
      {liveTrending ? <LeaderboardTable entries={displayedTrendingEntries} unifiedTrending /> : !liveOverallEmpty && <LeaderboardTable entries={entries} />}
      {liveOverallShort && <p className="evidence-note">{entries.length} {entries.length === 1 ? 'topic currently meets' : 'topics currently meet'} the Overall evidence requirements.</p>}
      {liveOverallEmpty && <div className="empty evidence-empty"><h3>Not enough established evidence yet</h3><p>Overall rankings require stronger historical evidence. Switch to Trending to see newer topics gaining attention.</p><button className="empty-action" onClick={() => setScoreMode('trendingScore')}>View Trending</button></div>}
      {entries.length === 0 && !liveOverallEmpty && (!useLeaderboardApi || apiState !== 'loading') && <p className="empty">No ranked topics in this category yet.</p>}
    </section>
    {authError && <p className="auth-notice" role="alert">{authError}</p>}<footer id="history">{liveResponse ? 'Live persisted snapshot · lane-isolated rank movement is shown when a prior comparable snapshot exists.' : 'Replay dashboard · snapshots are retained daily to power historical rank movement.'} · <a href="#/methodology">Methodology</a> · <a href="#/privacy">Privacy</a> · <a href="#/terms">Terms</a> · <a href="#/about">About</a></footer>
  </main>
}
