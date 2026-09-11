import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Category, RankingMode, TimeWindow } from '../domain/types'
import { CATEGORIES } from '../domain/types'
import { fetchLeaderboard, LeaderboardApiError, type LiveRankMovement, type UnifiedLiveLeaderboardApiResponse } from '../data/leaderboardApi'
import { createBrowserAuthClient, type AuthClient, type AuthUser } from '../auth/authClient'
import { createAnalytics, type Analytics } from '../analytics/events'

const defaultAuthClient = createBrowserAuthClient()
const defaultAnalytics = createAnalytics()
const windows: TimeWindow[] = ['24H', '7D', '30D', '1Y']
type DashboardEntry = { id: string, topic: string, category: Category, rank: number, movement: LiveRankMovement, score: number, lane: 'established' | 'emerging', trendHeat: 'stable' | 'rising' | 'fast' | 'surging' | 'exploding' | null, growthPercent: number | null, growthSaturated?: boolean }
type LeaderboardLoader = typeof fetchLeaderboard

type Route = 'rankings' | 'premium' | 'account' | 'about' | 'methodology' | 'privacy' | 'terms' | 'not-found'
function useHashRoute(): Route {
  const read = () => { const value = window.location.hash.replace(/^#\/?/, '').toLowerCase(); return value === '' || value === 'rankings' ? 'rankings' : ['premium', 'account', 'about', 'methodology', 'privacy', 'terms'].includes(value) ? value as Route : 'not-found' }
  const [route, setRoute] = useState<Route>(read)
  useEffect(() => { const update = () => setRoute(read()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  return route
}

function movementLabel(movement: DashboardEntry['movement']) {
  if (movement.state === 'new') return <span className="movement movement--new">NEW</span>
  if (movement.state === 'unavailable') return <span className="movement movement--flat">N/A</span>
  if (movement.state === 'unchanged') return <span className="movement movement--flat">—</span>
  return movement.state === 'up' ? <span className="movement movement--up">↑ {movement.delta}</span> : <span className="movement movement--down">↓ {Math.abs(movement.delta)}</span>
}
function heatLabel(heat: DashboardEntry['trendHeat']) {
  return heat ? <span className={`heat heat--${heat}`}><i aria-hidden="true" />{heat}</span> : <span className="heat heat--unavailable">Evidence pending</span>
}
function growthLabel(growthPercent: number | null, saturated = false) {
  if (growthPercent === null) return <span className="growth growth--unavailable">No comparison</span>
  const formatted = Math.round(Math.abs(growthPercent)).toLocaleString('en-US')
  const label = saturated && growthPercent === 1000 ? '≥1,000%' : `${growthPercent > 0 ? '+' : growthPercent < 0 ? '−' : ''}${formatted}%`
  return <span className={growthPercent >= 0 ? 'growth growth--positive' : 'growth growth--negative'}>{label}</span>
}
function LeaderboardTable({ entries }: { entries: DashboardEntry[] }) {
  return <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Search topic</th><th>Status</th><th>Heat</th><th>Growth</th><th>Category</th><th>Now Score</th><th>Movement</th></tr></thead><tbody>{entries.map((entry) => {
    return <tr key={entry.id}><td><span className={entry.rank < 4 ? 'rank rank--top' : 'rank'}>#{entry.rank}</span></td><td className="topic">{entry.topic}</td><td><span className={`status-badge status-badge--${entry.lane}`}>{entry.lane === 'emerging' ? 'Emerging' : 'Established'}</span></td><td>{heatLabel(entry.trendHeat)}</td><td>{growthLabel(entry.growthPercent, entry.growthSaturated)}</td><td><span className="category">{entry.category}</span></td><td><div className="score"><strong>{entry.score.toFixed(1)}</strong><span className="score__meter" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, entry.score))}%` }} /></span></div></td><td>{movementLabel(entry.movement)}</td></tr>
  })}</tbody></table></div>
}

function PageShell({ title, eyebrow, children }: { title: string, eyebrow: string, children: ReactNode }) {
  return <main className="dashboard"><header className="header"><a className="brand" href="#/rankings"><span className="brand__mark">N</span>NowRanks</a><nav aria-label="Primary navigation"><a href="#/rankings">Rankings</a><a className="nav-premium" href="#/premium">Premium</a><a href="#/methodology">Methodology</a></nav></header><article className="content-page"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children}</article><footer>© NowRanks · <a href="#/privacy">Privacy</a> · <a href="#/terms">Terms</a> · <a href="#/about">About</a></footer></main>
}

function ProductPage({ route, user, authReady, onSignIn, onSignOut }: { route: Route, user: AuthUser | null, authReady: boolean, onSignIn: () => void, onSignOut: () => void }) {
  if (route === 'not-found') return <PageShell eyebrow="404" title="This signal has moved."><p>The page you requested is not here. <a href="#/rankings">Return to rankings</a>.</p></PageShell>
  if (route === 'premium') return <PageShell eyebrow="NowRanks Premium" title="See the signal before it becomes obvious."><div className="premium-hero"><p>Premium is being designed for people who want deeper context, not louder numbers.</p><div className="feature-grid"><section><b>Available now</b><h3>Open rankings</h3><p>Explore the public global leaderboard and its evidence-based timeframes.</p></section><section><b>Coming soon</b><h3>Signals you can keep</h3><p>Watchlists, alerts, deeper history, categories and country-specific views.</p></section></div><button disabled title="Payments are not connected yet">Premium coming soon</button><p className="subtle">No payment or checkout is connected in this MVP.</p></div></PageShell>
  if (route === 'account') return <PageShell eyebrow="Your account" title={user ? `Welcome${user.name ? `, ${user.name}` : ''}.` : 'Your NowRanks account.'}>{!authReady ? <p role="status">Checking your secure session…</p> : user ? <section className="account-card">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="avatar">{(user.name ?? user.email ?? 'N').slice(0, 1)}</span>}<div><h3>{user.name ?? 'NowRanks member'}</h3><p>{user.email}</p><p className="membership">FREE</p>{user.createdAt && <p className="subtle">Joined {new Date(user.createdAt).toLocaleDateString()}</p>}</div><button onClick={onSignOut}>Sign out</button><p className="subtle">Saved topics and alerts will appear here when available.</p></section> : <section className="account-card"><h3>Save the internet signals that matter to you.</h3><p>Sign in with Google to prepare your account for upcoming watchlists and alerts.</p><button onClick={onSignIn}>Continue with Google</button></section>}</PageShell>
  const copy: Record<Exclude<Route, 'rankings' | 'premium' | 'account' | 'not-found'>, { eyebrow: string, title: string, body: ReactNode }> = {
    about: { eyebrow: 'About NowRanks', title: 'The internet moves too fast. NowRanks makes it readable.', body: <><p>NowRanks helps people understand what the internet is paying attention to—ranked. We turn public and third-party attention signals into a calmer, more useful view of momentum.</p><p>Rankings are estimates, not endorsements or objective truth.</p></> },
    methodology: { eyebrow: 'Methodology', title: 'Attention, made legible.', body: <><p>NowRanks combines current search attention, acceleration, momentum and recency into one comparable public score. Each timeframe evaluates its own evidence: 24H, 7D, 30D and 1Y are not interchangeable.</p><p>Established and Emerging are evidence-status labels, not separate public ranking lanes. Data can be delayed, incomplete, corrected or unavailable, and rankings can change as evidence changes.</p><p>Heat labels are a visual reading of available supporting signals: Stable, Rising, Fast, Surging and Exploding. A growth percentage appears only when the underlying valid comparison is meaningful.</p></> },
    privacy: { eyebrow: 'Privacy Policy · owner review required', title: 'Privacy without guesswork.', body: <><p>This MVP template should be reviewed by the owner before public launch. If you sign in, NowRanks may receive the identity information supplied by your authentication provider, such as name, email and avatar, plus session data needed to keep you signed in.</p><p>We use that information to provide account features. We do not claim analytics, advertising, sale of personal data, or compliance certifications that are not implemented. A future analytics provider must be disclosed here before activation. Contact and retention details require owner completion.</p></> },
    terms: { eyebrow: 'Terms of Use · owner review required', title: 'A clear starting point.', body: <><p>This MVP template is not legal advice and requires owner and legal review before launch. By using NowRanks, you agree to use the service lawfully and protect your account. Rankings are informational algorithmic estimates based partly on third-party services; they are not guarantees of accuracy, completeness or endorsement.</p><p>The owner may change, suspend, or terminate the service. Subscription terms will be added only when payments are offered. Governing law, legal entity, address and contact details must be completed by the owner.</p></> },
  }
  const page = copy[route as keyof typeof copy]
  return <PageShell eyebrow={page.eyebrow} title={page.title}>{page.body}</PageShell>
}

export function App({ apiClient = fetchLeaderboard, authClient = defaultAuthClient, analytics = defaultAnalytics }: { apiClient?: LeaderboardLoader, authClient?: AuthClient | null, analytics?: Analytics }) {
  const [entries, setEntries] = useState<DashboardEntry[]>([])
  const [category, setCategory] = useState<'All' | Category>('All')
  const [window, setWindow] = useState<TimeWindow>('24H')
  const [apiResponse, setApiResponse] = useState<UnifiedLiveLeaderboardApiResponse | null>(null)
  const [apiState, setApiState] = useState<'idle' | 'loading' | 'error' | 'success'>('idle')
  const [apiError, setApiError] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authReady, setAuthReady] = useState(!authClient)
  const [authError, setAuthError] = useState('')
  const requestVersion = useRef(0)
  const route = useHashRoute()
  const rankingMode: RankingMode = 'overall'

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
    const controller = new AbortController()
    setApiState('loading'); setApiError('')
    void apiClient({ window, mode: rankingMode, ...(category === 'All' ? {} : { category }), signal: controller.signal }).then((result) => {
      if (version !== requestVersion.current) return
      setEntries(result.entries.map((entry) => ({ id: entry.candidateId, topic: entry.title || entry.query, category: entry.category, rank: entry.publicRank, movement: entry.movement, score: entry.publicScore, lane: entry.evidenceStatus, trendHeat: entry.trendHeat ?? null, growthPercent: entry.growthPercent ?? null, growthSaturated: entry.growthSaturated })))
      setApiResponse(result); setApiState('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted || version !== requestVersion.current) return
      setApiError(error instanceof LeaderboardApiError && error.code === 'live_snapshot_not_found' ? 'No live snapshot is available for this window yet.' : 'Unable to load the persisted leaderboard.')
      setApiState('error')
    })
    return () => controller.abort()
  }, [apiClient, category, retryCount, window])

  const categories = useMemo(() => ['All', ...CATEGORIES] as const, [])
  const sourceLabel = apiResponse ? `Live persisted snapshot · Updated: ${new Date(apiResponse.snapshot.scoredAt).toLocaleString()} · ${apiResponse.snapshot.selectedWindow}` : 'Loading persisted live snapshot'
  const liveOverallEmpty = Boolean(apiResponse && entries.length === 0)
  const liveOverallShort = Boolean(apiResponse && entries.length > 0 && entries.length < 20)
  useEffect(() => { if (route === 'rankings') analytics.track('rankings_view', { window, mode: 'unified' }) }, [analytics, route, window])
  useEffect(() => { if (route === 'premium') analytics.track('premium_view') }, [analytics, route])
  if (route !== 'rankings') return <ProductPage route={route} user={user} authReady={authReady} onSignIn={signIn} onSignOut={signOut} />
  return <main className="dashboard">
    <header className="header"><a className="brand" href="#/rankings" aria-label="NowRanks home"><span className="brand__mark">N</span>NowRanks</a><nav aria-label="Primary navigation"><a className="active" href="#/rankings">Rankings</a><a className="nav-premium" href="#/premium">Premium</a><a href="#/methodology">Methodology</a></nav>{user ? <a className="account-link" href="#/account">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : (user.name ?? user.email ?? 'Account').slice(0, 1)}</a> : <button className="sign-in" onClick={signIn}>Sign in</button>}<span className="header__status"><i /> {apiResponse ? 'Live snapshot' : 'Loading snapshot'}</span></header>
    <section className="intro" id="top"><p className="eyebrow">Global search intelligence</p><h1>What the world is <em>searching</em> for now.</h1><p>NowRanks surfaces the topics combining scale, growth, accelerating attention, and sustained interest.</p></section>
    <section className="leaderboard" id="leaderboard" aria-label="Global NowRanks public leaderboard"><div className="leaderboard__heading"><div><p className="eyebrow">Global leaderboard</p><h2>NowRanks public leaderboard</h2><p className="subtle">{sourceLabel}</p>{apiResponse && <p className="subtle">Rows and ranks come directly from this persisted public snapshot.</p>}</div></div>
      <div className="controls"><div className="segmented" aria-label="Time window">{windows.map((value) => <button key={value} className={window === value ? 'selected' : ''} onClick={() => { setWindow(value); analytics.track('window_changed', { window: value }) }}>{value}</button>)}</div><label>Category <select value={category} onChange={(event) => setCategory(event.target.value as 'All' | Category)}>{categories.map((value) => <option key={value}>{value}</option>)}</select></label></div>
      <p className="definition">Ranks topics by current attention and momentum, with evidence status shown separately.</p>
      {apiState === 'loading' && <p className="subtle" role="status">Loading persisted leaderboard…</p>}
      {apiState === 'error' && <p className="empty" role="alert">{apiError} <button onClick={() => setRetryCount((count) => count + 1)}>Retry</button></p>}
      {!liveOverallEmpty && apiState === 'success' && <LeaderboardTable entries={entries} />}
      {liveOverallShort && <p className="evidence-note">{entries.length} {entries.length === 1 ? 'topic currently meets' : 'topics currently meet'} the current evidence requirements.</p>}
      {liveOverallEmpty && <div className="empty evidence-empty"><h3>No public topics available yet</h3><p>This timeframe does not yet have enough current discovery evidence for a unified snapshot.</p></div>}
      {entries.length === 0 && !liveOverallEmpty && apiState === 'success' && <p className="empty">No ranked topics in this category yet.</p>}
    </section>
    {authError && <p className="auth-notice" role="alert">{authError}</p>}<footer id="history">Live persisted snapshot · global unified rank movement is shown when a prior comparable snapshot exists. · <a href="#/methodology">Methodology</a> · <a href="#/privacy">Privacy</a> · <a href="#/terms">Terms</a> · <a href="#/about">About</a></footer>
  </main>
}
