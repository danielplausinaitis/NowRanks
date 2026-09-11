import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { UnifiedLiveLeaderboardApiResponse } from '../data/leaderboardApi'
import type { Category } from '../domain/types'

afterEach(() => { cleanup(); window.location.hash = '' })

function unifiedResult({ window = '24H', count = 20, growthPercent = 184 }: { window?: '24H' | '7D' | '30D' | '1Y', count?: number, growthPercent?: number | null } = {}): UnifiedLiveLeaderboardApiResponse {
  const entry = (rank: number, category: Category = 'Technology') => ({
    candidateId: `topic-${rank}`, query: `topic ${rank}`, title: `Topic ${rank}`, normalizedQuery: `topic-${rank}`, category,
    classification: rank === 1 ? 'possible-new-trend' as const : 'established' as const, confidence: rank === 1 ? 'emerging' as const : 'full' as const, confidenceReason: 'test evidence',
    historyObservationCount: 10, historyAvailableCount: 10, historyCoveragePercentage: 100, searchInterest: 75, componentAvailability: {}, growthPercent, growthSource: growthPercent === null ? 'unavailable' as const : 'provider-history' as const, trendHeat: 'surging' as const,
    scoredAt: '2026-09-08T00:00:00.000Z', cycleId: `cycle-${window}`, selectedWindow: window, movement: rank === 1 ? { state: 'new' as const, delta: null, previousRank: null } : { state: 'unchanged' as const, delta: 0 as const, previousRank: rank },
    publicRank: rank, publicScore: 95 - rank, evidenceStatus: rank === 1 ? 'emerging' as const : 'established' as const,
  })
  return { dataMode: 'live', source: 'persisted-live-snapshot', persisted: true, rankingMode: 'unified', window, snapshot: { cycleId: `cycle-${window}`, selectedWindow: window, scoredAt: '2026-09-08T00:00:00.000Z', snapshotFormatVersion: 2 }, metadata: { mode: 'overall', category: null, compatibility: { status: 'supported', diagnostics: [] } }, entries: Array.from({ length: count }, (_, index) => entry(index + 1, index === 6 ? 'Sports' : 'Technology')) }
}

describe('App persisted public leaderboard', () => {
  it('renders exactly the 10 persisted rows without manufacturing rows from any candidate collection', async () => {
    render(<App apiClient={async () => unifiedResult({ count: 10 })} />)
    expect(await screen.findByRole('heading', { name: 'NowRanks public leaderboard' })).toBeInTheDocument()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(10)
    expect(screen.getByText('Topic 10')).toBeInTheDocument()
    expect(screen.queryByText('Topic 11')).toBeNull()
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('94.0')).toBeInTheDocument()
    expect(screen.getAllByText('+184%').length).toBe(10)
  })

  it('renders exactly the 20 persisted rows and preserves their public ranks and scores', async () => {
    render(<App apiClient={async () => unifiedResult({ count: 20 })} />)
    await screen.findByText('Topic 20')
    expect(document.querySelectorAll('tbody tr')).toHaveLength(20)
    expect(screen.getByText('Topic 7').closest('tr')?.firstChild).toHaveTextContent('#7')
    expect(screen.getByText('Topic 7').closest('tr')).toHaveTextContent('88.0')
  })

  it('keeps an unavailable persisted Growth value unavailable rather than rendering zero', async () => {
    render(<App apiClient={async () => unifiedResult({ count: 1, growthPercent: null })} />)
    expect(await screen.findByText('No comparison')).toBeInTheDocument()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('requests each selected persisted window and keeps category filtering on returned rows only', async () => {
    const apiClient = vi.fn(async ({ window, category }) => {
      const result = unifiedResult({ window })
      return category === 'Sports' ? { ...result, entries: result.entries.filter((entry) => entry.category === 'Sports') } : result
    })
    render(<App apiClient={apiClient} />)
    await screen.findByText('Topic 1')
    expect(apiClient.mock.calls[0][0]).toEqual(expect.objectContaining({ window: '24H', mode: 'overall' }))
    fireEvent.click(screen.getByRole('button', { name: '7D' }))
    await screen.findByText('Topic 20')
    expect(apiClient).toHaveBeenLastCalledWith(expect.objectContaining({ window: '7D', mode: 'overall' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'Sports' } })
    await screen.findByText('Topic 7')
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(screen.getByText('Topic 7').closest('tr')?.firstChild).toHaveTextContent('#7')
  })
})
