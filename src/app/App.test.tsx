import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App', () => {
  it('introduces NowRanks', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'NowRanks' })).toBeInTheDocument()
    expect(screen.getByText(/track the Google search rankings/i)).toBeInTheDocument()
  })
})
