import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { LeaderboardApiResponse } from '../data/leaderboardApi'
import type { Category } from '../domain/types'

afterEach(cleanup)

const apiResult = (topic = 'API topic', window: '24H' | '7D' | '30D' | '1Y' = '7D', category: Category = 'Technology') => ({
  metadata: { providerId: 'google-trending-now', dataMode: 'replay' as const, window, category: null, observedFrom: '2026-08-19', observedThrough: '2026-08-25', generatedAt: '2026-08-26T00:00:00.000Z' },
  entries: [{ rank: 1, candidateId: `google:${topic}`, topic, category, score: 88.5 }],
})

describe('App', () => {
  it('renders the global Top 100 dashboard', async () => {
    render(<App />)
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
    expect(apiClient).toHaveBeenCalledWith(expect.objectContaining({ window: '7D' }))
    expect(screen.getByText(/REPLAY — NOT LIVE GOOGLE DATA.*Observed through 2026-08-25/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Trending/i })).toBeDisabled()
  })

  it('forwards selected windows and category in API mode', async () => {
    const apiClient = vi.fn(async ({ window, category }) => apiResult(`${window}-${category ?? 'All'}`, window, category ?? 'Technology'))
    render(<App useLeaderboardApi apiClient={apiClient} />)
    await screen.findByText('7D-All')
    fireEvent.click(screen.getByRole('button', { name: '30D' }))
    await screen.findByText('30D-All')
    expect(apiClient).toHaveBeenLastCalledWith(expect.objectContaining({ window: '30D' }))
  })

  it('forwards a selected category to the API instead of filtering an old response locally', async () => {
    const initial = apiResult('Technology topic')
    initial.entries.push({ rank: 2, candidateId: 'google:finance', topic: 'Finance topic', category: 'Finance', score: 80 })
    const apiClient: typeof import('../data/leaderboardApi').fetchLeaderboard = vi.fn(async ({ category }) => category ? apiResult('Filtered finance topic', '7D', category === 'Finance' ? category : 'Technology') : initial)
    render(<App useLeaderboardApi apiClient={apiClient} />)
    await screen.findByText('Finance topic')
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Finance' } })
    expect(await screen.findByText('Filtered finance topic')).toBeInTheDocument()
    expect(apiClient).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'Finance' }))
  })

  it('switches All to Sports to Gaming and back to All through API requests', async () => {
    const initial = apiResult('All topic')
    initial.entries.push({ rank: 2, candidateId: 'google:sports', topic: 'Sports topic', category: 'Sports', score: 80 }, { rank: 3, candidateId: 'google:gaming', topic: 'Gaming topic', category: 'Gaming', score: 70 })
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
})
