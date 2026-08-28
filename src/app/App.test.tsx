import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

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
})
