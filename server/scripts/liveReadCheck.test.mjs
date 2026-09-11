import { describe, expect, it, vi } from 'vitest'
import { resolveLiveReadWindow, runLiveReadCheck } from './liveReadCheck.mjs'

describe('live read check command', () => {
  it('prints a v2 unified leaderboard without writes or provider calls', async () => {
    const createClient = vi.fn(() => ({ from: vi.fn() }))
    const createRepository = vi.fn(() => ({ upsertLiveSnapshot: vi.fn(), upsertLiveSnapshotEntries: vi.fn() }))
    const read = vi.fn(async () => ({ rankingMode: 'unified', snapshot: { cycleId: 'cycle-v2', selectedWindow: '1Y', scoredAt: '2026-09-04T12:00:00.000Z', snapshotFormatVersion: 2 }, entries: [{ publicRank: 1, title: 'Unified topic', publicScore: 88, growthPercent: 184, growthSource: 'provider-history', evidenceStatus: 'emerging', movement: { state: 'new' } }] }))
    const write = vi.fn()
    await runLiveReadCheck({ env: { LIVE_READ_WINDOW: '1Y', LIVE_READ_CYCLE_ID: 'cycle-v2' }, createClient, createRepository, read, write })
    expect(read).toHaveBeenCalledWith({ repository: expect.any(Object), selectedWindow: '1Y', cycleId: 'cycle-v2' })
    expect(createRepository.mock.results[0].value.upsertLiveSnapshot).not.toHaveBeenCalled()
    expect(write.mock.calls.flat().join('\n')).toContain('now score 88.00')
    expect(write.mock.calls.flat().join('\n')).toContain('growth +184% (provider-history)')
    expect(write.mock.calls.flat().join('\n')).toContain('No writes performed.')
  })

  it('defaults its diagnostic read to 24H and accepts --window overrides', () => {
    expect(resolveLiveReadWindow({ env: {}, args: [] })).toBe('24H')
    expect(resolveLiveReadWindow({ env: { LIVE_READ_WINDOW: '7D' }, args: ['--window=30D'] })).toBe('30D')
    expect(resolveLiveReadWindow({ env: {}, args: ['--window', '1Y'] })).toBe('1Y')
  })
})
