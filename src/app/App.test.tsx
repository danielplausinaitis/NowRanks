import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { LeaderboardApiResponse, LiveLeaderboardApiResponse, ReplayLeaderboardApiResponse } from '../data/leaderboardApi'
import type { Category } from '../domain/types'

afterEach(() => { cleanup(); window.location.hash = '' })

const apiResult = (topic = 'API topic', window: '24H' | '7D' | '30D' | '1Y' = '7D', category: Category = 'Technology'): ReplayLeaderboardApiResponse => ({
  metadata: { providerId: 'google-trending-now', dataMode: 'replay', window, mode: 'overall', category: null, observedFrom: '2026-08-19', observedThrough: '2026-08-25', comparisonAvailable: true, comparisonObservedThrough: '2026-08-24', generatedAt: '2026-08-26T00:00:00.000Z' },
  entries: [{ rank: 1, candidateId: `google:${topic}`, topic, category, score: 88.5, movement: { status: 'unchanged', delta: 0, previousRank: 1 } }],
})

function liveResult(): LiveLeaderboardApiResponse {
  const entry = (lane: 'established' | 'emerging', rank: number, category: Category = 'Technology') => ({
    candidateId: `${lane}-${rank}`, query: `${lane} query ${rank}`, title: `${lane} topic ${rank}`, normalizedQuery: `${lane}-${rank}`, category, scoreLane: lane, laneRank: rank,
    classification: lane === 'established' ? 'established' as const : 'possible-new-trend' as const, confidence: lane === 'established' ? 'full' as const : 'emerging' as const, confidenceReason: 'persisted evidence', scoreBasis: lane === 'established' ? 'historical-trending' as const : 'current-emerging-evidence' as const,
    overallScore: lane === 'established' ? 88 : null, establishedTrendingScore: lane === 'established' ? 71 : null, emergingTrendingScore: lane === 'emerging' ? 63 : null,
    historyObservationCount: 365, historyAvailableCount: 365, historyCoveragePercentage: 100, searchInterest: 42, componentAvailability: {}, scoredAt: '2026-09-02T18:00:00.000Z', cycleId: 'cycle-1', selectedWindow: '1Y' as const, movement: { state: 'unavailable' as const, delta: null, previousRank: null },
  })
  return { dataMode: 'live', source: 'persisted-live-snapshot', persisted: true, snapshot: { cycleId: 'cycle-1', selectedWindow: '1Y', scoredAt: '2026-09-02T18:00:00.000Z' }, metadata: { mode: 'overall', category: null, establishedCount: 2, emergingCount: 0, categoryRankSemantics: 'persisted-global-lane-rank' }, established: [entry('established', 1), entry('established', 4, 'Sports')], emerging: [entry('emerging', 1), entry('emerging', 3, 'Sports')] }
}

function liveResultWithCounts(establishedCount: number, emergingCount: number): LiveLeaderboardApiResponse {
  const result = liveResult()
  const make = (lane: 'established' | 'emerging', count: number) => Array.from({ length: count }, (_, index) => {
    const base = lane === 'established' ? result.established[0] : result.emerging[0]
    const rank = index + 1
    return { ...base, candidateId: `${lane}-${rank}`, query: `${lane} query ${rank}`, title: `${lane} topic ${rank}`, normalizedQuery: `${lane}-${rank}`, laneRank: rank, category: rank % 2 === 0 ? 'Sports' as const : 'Technology' as const }
  })
  result.established = make('established', establishedCount)
  result.emerging = make('emerging', emergingCount)
  result.metadata = { ...result.metadata, establishedCount, emergingCount }
  return result
}

describe('App', () => {
  it('renders the global Top 100 dashboard', async () => {
    render(<App useLeaderboardApi={false} />)
    expect(screen.getByRole('heading', { name: /NowRanks Top 100/i })).toBeInTheDocument()
    expect(await screen.findByText('iPhone 17 Pro release date')).toBeInTheDocument()
    expect(screen.getByText(/Google Trending Now replay data/i)).toBeInTheDocument()
    const sevenDay = screen.getByRole('button', { name: '7D' })
    const thirtyDay = screen.getByRole('button', { name: '30D' })
    expect(sevenDay).toHaveClass('selected')
    fireEvent.click(thirtyDay)
    expect(thirtyDay).toHaveClass('selected')
  })

  it('keeps the local replay path active when the API feature switch is false', async () => {
    const apiClient = async () => apiResult()
    render(<App useLeaderboardApi={false} apiClient={apiClient} />)
    expect(await screen.findByText('iPhone 17 Pro release date')).toBeInTheDocument()
  })

  it('uses the API in feature-switch mode and discloses response replay metadata', async () => {
    const apiClient = vi.fn(async () => apiResult())
    render(<App useLeaderboardApi apiClient={apiClient} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Loading persisted leaderboard/i)
    expect(await screen.findByText('API topic')).toBeInTheDocument()
    expect(apiClient).toHaveBeenCalledWith(expect.objectContaining({ window: '7D', mode: 'overall' }))
    expect(screen.getByText(/REPLAY — NOT LIVE GOOGLE DATA.*Observed through 2026-08-25/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trending/i })).not.toBeDisabled()
  })

  it('forwards selected windows and category in API mode', async () => {
    const apiClient = vi.fn(async ({ window, category }) => apiResult(`${window}-${category ?? 'All'}`, window, category ?? 'Technology'))
    render(<App useLeaderboardApi apiClient={apiClient} />)
    await screen.findByText('7D-All')
    fireEvent.click(screen.getByRole('button', { name: '30D' }))
    await screen.findByText('30D-All')
    expect(apiClient).toHaveBeenLastCalledWith(expect.objectContaining({ window: '30D', mode: 'overall' }))
  })

  it('forwards a selected category to the API instead of filtering an old response locally', async () => {
    const initial = apiResult('Technology topic')
    initial.entries.push({ rank: 2, candidateId: 'google:finance', topic: 'Finance topic', category: 'Finance', score: 80, movement: { status: 'unchanged', delta: 0, previousRank: 2 } })
    const apiClient: typeof import('../data/leaderboardApi').fetchLeaderboard = vi.fn(async ({ category }) => category ? apiResult('Filtered finance topic', '7D', category === 'Finance' ? category : 'Technology') : initial)
    render(<App useLeaderboardApi apiClient={apiClient} />)
    await screen.findByText('Finance topic')
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Finance' } })
    expect(await screen.findByText('Filtered finance topic')).toBeInTheDocument()
    expect(apiClient).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'Finance' }))
  })

  it('switches All to Sports to Gaming and back to All through API requests', async () => {
    const initial = apiResult('All topic')
    initial.entries.push({ rank: 2, candidateId: 'google:sports', topic: 'Sports topic', category: 'Sports', score: 80, movement: { status: 'unchanged', delta: 0, previousRank: 2 } }, { rank: 3, candidateId: 'google:gaming', topic: 'Gaming topic', category: 'Gaming', score: 70, movement: { status: 'unchanged', delta: 0, previousRank: 3 } })
    const apiClient: typeof import('../data/leaderboardApi').fetchLeaderboard = vi.fn(async ({ category }) => category ? apiResult(`${category} cohort`, '7D', category === 'Gaming' ? 'Finance' : 'Technology') : initial)
    render(<App useLeaderboardApi apiClient={apiClient} />)
    await screen.findByText('All topic')
    const categorySelect = screen.getByLabelText('Category')
    fireEvent.change(categorySelect, { target: { value: 'Sports' } })
    expect(await screen.findByText('Sports cohort')).toBeInTheDocument()
    fireEvent.change(categorySelect, { target: { value: 'Gaming' } })
    expect(await screen.findByText('Gaming cohort')).toBeInTheDocument()
    fireEvent.change(categorySelect, { target: { value: 'All' } })
    await screen.findByText('All topic')
    expect(apiClient).toHaveBeenLastCalledWith(expect.not.objectContaining({ category: expect.anything() }))
  })

  it('shows API failure and retries without silently rendering local replay data', async () => {
    let attempt = 0
    const apiClient = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('offline')
      return apiResult('Recovered API topic')
    })
    render(<App useLeaderboardApi apiClient={apiClient} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unable to load the persisted leaderboard/i)
    expect(screen.queryByText('iPhone 17 Pro release date')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Recovered API topic')).toBeInTheDocument()
    expect(apiClient).toHaveBeenCalledTimes(2)
  })

  it('ignores an older response after a newer window request completes', async () => {
    let resolveSevenDay: ((value: LeaderboardApiResponse) => void) | undefined
    let resolveThirtyDay: ((value: LeaderboardApiResponse) => void) | undefined
    const apiClient: typeof import('../data/leaderboardApi').fetchLeaderboard = vi.fn(({ window }) => new Promise<LeaderboardApiResponse>((resolve) => {
      if (window === '7D') resolveSevenDay = resolve
      if (window === '30D') resolveThirtyDay = resolve
    }))
    render(<App useLeaderboardApi apiClient={apiClient} />)
    fireEvent.click(screen.getByRole('button', { name: '30D' }))
    resolveThirtyDay?.(apiResult('New 30D topic', '30D'))
    expect(await screen.findByText('New 30D topic')).toBeInTheDocument()
    resolveSevenDay?.(apiResult('Old 7D topic', '7D'))
    await waitFor(() => expect(screen.queryByText('Old 7D topic')).not.toBeInTheDocument())
  })

  it('replaces a 30D response with the distinct 1Y response', async () => {
    const apiClientMock = vi.fn(async ({ window, mode }: { window: '24H' | '7D' | '30D' | '1Y', mode: 'overall' | 'trending' }) => {
      const result = apiResult(window === '30D' ? '30D best savings account' : '1Y interest rate decision', window)
      result.metadata.mode = mode
      result.metadata.observedFrom = window === '30D' ? '2026-07-27' : '2025-08-26'
      result.entries[0].score = window === '30D' ? 77.6 : 81.82
      return result
    })
    const apiClient = apiClientMock as typeof import('../data/leaderboardApi').fetchLeaderboard
    render(<App useLeaderboardApi apiClient={apiClient} />)
    fireEvent.click(screen.getByRole('button', { name: '30D' }))
    expect(await screen.findByText('30D best savings account')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '1Y' }))
    expect(await screen.findByText('1Y interest rate decision')).toBeInTheDocument()
    expect(screen.queryByText('30D best savings account')).not.toBeInTheDocument()
    expect(apiClientMock.mock.calls.map(([request]) => request.window)).toContain('30D')
    expect(apiClientMock.mock.calls.map(([request]) => request.window)).toContain('1Y')
  })

  it('requests and renders trending mode without recalculating the API score', async () => {
    const trendingResponse = apiResult('Trending API topic')
    trendingResponse.metadata.mode = 'trending'
    trendingResponse.entries[0].score = 63.2
    const apiClient = vi.fn(async ({ mode }) => mode === 'trending' ? trendingResponse : apiResult())
    render(<App useLeaderboardApi apiClient={apiClient} />)
    await screen.findByText('API topic')
    fireEvent.click(screen.getByRole('button', { name: /Trending/i }))
    expect(await screen.findByText('Trending API topic')).toBeInTheDocument()
    expect(apiClient).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'trending' }))
    expect(screen.getByText('63.2')).toBeInTheDocument()
  })

  it('renders server-provided moved, unchanged, new, and unavailable movement without calculating it locally', async () => {
    const result = apiResult('Moved topic')
    result.entries = [
      { rank: 1, candidateId: 'google:up', topic: 'Moved topic', category: 'Technology', score: 90, movement: { status: 'moved', delta: 6, previousRank: 7 } },
      { rank: 2, candidateId: 'google:flat', topic: 'Flat topic', category: 'Technology', score: 80, movement: { status: 'unchanged', delta: 0, previousRank: 2 } },
      { rank: 3, candidateId: 'google:new', topic: 'New topic', category: 'Technology', score: 70, movement: { status: 'new', delta: null, previousRank: null } },
      { rank: 4, candidateId: 'google:na', topic: 'Unavailable topic', category: 'Technology', score: 60, movement: { status: 'unavailable', delta: null, previousRank: null } },
    ]
    render(<App useLeaderboardApi apiClient={vi.fn(async () => result)} />)
    await screen.findByText('Moved topic')
    expect(screen.getByText('↑ 6')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('NEW')).toBeInTheDocument()
    expect(screen.getByText('N/A')).toBeInTheDocument()
  })

  it('renders live Overall as Established-only with snapshot disclosure and no replay disclosure', async () => {
    const response = liveResult()
    render(<App useLeaderboardApi leaderboardDataSource="live" apiClient={vi.fn(async () => response)} />)
    expect(await screen.findByText('established topic 1')).toBeInTheDocument()
    expect(screen.queryByText('emerging topic 1')).not.toBeInTheDocument()
    expect(screen.getByText(/Live persisted snapshot.*1Y/i)).toBeInTheDocument()
    expect(screen.queryByText(/NOT LIVE GOOGLE DATA/i)).not.toBeInTheDocument()
    expect(screen.getAllByText('N/A')).toHaveLength(2)
  })

  it('renders 7 Established and 3 Emerging topics as one truthful ten-position Trending table', async () => {
    const response = liveResultWithCounts(7, 3); response.metadata.mode = 'trending'
    render(<App useLeaderboardApi leaderboardDataSource="live" apiClient={vi.fn(async ({ mode }) => ({ ...response, metadata: { ...response.metadata, mode } }))} />)
    await screen.findByText('established topic 1')
    fireEvent.click(screen.getByRole('button', { name: /Trending/i }))
    expect(await screen.findByText('emerging topic 3')).toBeInTheDocument()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.getAllByRole('row')).toHaveLength(11)
    expect(screen.queryByRole('heading', { name: 'Established Trending' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Emerging' })).not.toBeInTheDocument()
    expect(screen.getByText('emerging topic 1')).toBeInTheDocument()
    expect(screen.getAllByText('Established')).toHaveLength(7)
    expect(screen.getAllByText('Emerging')).toHaveLength(3)
    for (let position = 1; position <= 10; position += 1) expect(screen.getByText(`#${position}`)).toBeInTheDocument()
    expect(response.emerging[0].laneRank).toBe(1)
    expect(screen.getByText('emerging topic 1').closest('tr')?.firstChild).toHaveTextContent('#8')
  })

  it('renders short and empty live Overall states without fabricating rows', async () => {
    const short = liveResultWithCounts(7, 3)
    const apiClient = vi.fn(async () => short)
    const { rerender } = render(<App useLeaderboardApi leaderboardDataSource="live" apiClient={apiClient} />)
    expect(await screen.findByText('established topic 7')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(8)
    expect(screen.getByText(/7 topics currently meet the Overall evidence requirements/i)).toBeInTheDocument()
    const empty = liveResultWithCounts(0, 3)
    rerender(<App useLeaderboardApi leaderboardDataSource="live" apiClient={vi.fn(async () => empty)} />)
    expect(await screen.findByRole('heading', { name: 'Not enough established evidence yet' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View Trending' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders fewer eligible Trending topics truthfully and keeps category-filtered lane ranks in the API result', async () => {
    const all = liveResultWithCounts(2, 1)
    const sports = liveResultWithCounts(1, 1)
    sports.established[0] = { ...sports.established[0], category: 'Sports', laneRank: 2 }
    sports.emerging[0] = { ...sports.emerging[0], category: 'Sports', laneRank: 3 }
    const apiClient = vi.fn(async ({ category, mode }) => ({ ...(category === 'Sports' ? sports : all), metadata: { ...(category === 'Sports' ? sports : all).metadata, mode } }))
    render(<App useLeaderboardApi leaderboardDataSource="live" apiClient={apiClient} />)
    await screen.findByText('established topic 1')
    fireEvent.click(screen.getByRole('button', { name: /Trending/i }))
    expect(await screen.findByText('emerging topic 1')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(screen.queryByText('#4')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Sports' } })
    await waitFor(() => expect(apiClient).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'Sports', mode: 'trending' })))
    expect(sports.established[0].laneRank).toBe(2)
    expect(sports.emerging[0].laneRank).toBe(3)
    expect(screen.getByText('established topic 1').closest('tr')?.firstChild).toHaveTextContent('#1')
  })

  it('renders server-provided lane-isolated live movement without recalculating it', async () => {
    const response = liveResult()
    response.established[0].movement = { state: 'up', delta: 3, previousRank: 4 }
    response.established[1].movement = { state: 'down', delta: -2, previousRank: 2 }
    response.emerging[0].movement = { state: 'new', delta: null, previousRank: null }
    response.emerging[1].movement = { state: 'unchanged', delta: 0, previousRank: 3 }
    const apiClient = vi.fn(async ({ mode }) => ({ ...response, metadata: { ...response.metadata, mode: mode as 'overall' | 'trending' } }))
    render(<App useLeaderboardApi leaderboardDataSource="live" apiClient={apiClient} />)
    await screen.findByText('established topic 1')
    fireEvent.click(screen.getByRole('button', { name: /Trending/i }))
    expect(await screen.findByText('↑ 3')).toBeInTheDocument()
    expect(screen.getByText('↓ 2')).toBeInTheDocument()
    expect(screen.getByText('NEW')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows the live no-snapshot error and never falls back to replay', async () => {
    const apiClient = vi.fn(async () => { throw new (await import('../data/leaderboardApi')).LeaderboardApiError('missing', 404, 'live_snapshot_not_found') })
    render(<App useLeaderboardApi leaderboardDataSource="live" apiClient={apiClient} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('No live snapshot is available for this window yet.')
    expect(screen.queryByText('iPhone 17 Pro release date')).not.toBeInTheDocument()
  })

  it('renders window-specific heat and a truthful growth comparison from the live response', async () => {
    const response = liveResult()
    response.metadata.mode = 'trending'
    response.established[0] = { ...response.established[0], trendHeat: 'surging', growthPercent: 184 }
    render(<App useLeaderboardApi leaderboardDataSource="live" apiClient={vi.fn(async ({ mode }) => ({ ...response, metadata: { ...response.metadata, mode } }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Trending/i }))
    expect(await screen.findByText('surging')).toBeInTheDocument()
    expect(screen.getByText('+184%')).toBeInTheDocument()
  })

  it('routes to Premium, legal, and an unknown-page state without changing leaderboard data', async () => {
    window.location.hash = '#/premium'
    render(<App useLeaderboardApi apiClient={vi.fn(async () => apiResult())} />)
    expect(screen.getByRole('heading', { name: /See the signal before it becomes obvious/i })).toBeInTheDocument()
    window.location.hash = '#/methodology'; window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(await screen.findByRole('heading', { name: /Attention, made legible/i })).toBeInTheDocument()
    window.location.hash = '#/missing'; window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(await screen.findByRole('heading', { name: /This signal has moved/i })).toBeInTheDocument()
  })

  it('shows a graceful sign-in configuration state and never pretends authentication succeeded', async () => {
    render(<App useLeaderboardApi apiClient={vi.fn(async () => apiResult())} authClient={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/i)
  })
})
