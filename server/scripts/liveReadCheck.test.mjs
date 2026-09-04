import { describe, expect, it, vi } from 'vitest'
import { runLiveReadCheck } from './liveReadCheck.mjs'

describe('live read check command', () => {
  it('uses only injected read dependencies, prints independent lanes, and performs no writes or provider calls', async () => {
    const createClient = vi.fn(() => ({ from: vi.fn() }))
    const createRepository = vi.fn(() => ({ upsertLiveSnapshot: vi.fn(), upsertLiveSnapshotEntries: vi.fn() }))
    const read = vi.fn(async () => ({ snapshot: { cycleId: 'cycle-1', selectedWindow: '1Y', scoredAt: '2026-09-04T12:00:00.000Z' }, established: [{ laneRank: 1, title: 'Established topic', overallScore: 80, establishedTrendingScore: 70, confidence: 'full' }], emerging: [{ laneRank: 1, title: 'Emerging topic', emergingTrendingScore: 60, confidence: 'emerging' }] }))
    const write = vi.fn()
    await runLiveReadCheck({ env: { LIVE_READ_WINDOW: '1Y', LIVE_READ_CYCLE_ID: 'cycle-1' }, createClient, createRepository, read, write })
    expect(read).toHaveBeenCalledWith({ repository: expect.any(Object), selectedWindow: '1Y', cycleId: 'cycle-1' })
    expect(createRepository.mock.results[0].value.upsertLiveSnapshot).not.toHaveBeenCalled()
    expect(createRepository.mock.results[0].value.upsertLiveSnapshotEntries).not.toHaveBeenCalled()
    expect(write.mock.calls.flat().join('\n')).toContain('No writes performed.')
    expect(write.mock.calls.flat().join('\n')).toContain('emerging trending 60.00')
    expect(write.mock.calls.flat().join('\n')).not.toMatch(/provider|replay|unified rank/i)
  })
})
