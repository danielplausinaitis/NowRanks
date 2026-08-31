import { describe, expect, it, vi } from 'vitest'
import { createApiHandler } from './handler.mjs'

function leaderboardResult({ window = '7D', mode = 'overall', category } = {}) {
  return {
    providerId: 'google-trending-now', dataMode: 'replay', window, mode, ...(category ? { category } : {}),
    observationRange: { startDate: '2026-08-19', endDate: '2026-08-25' }, generatedAt: '2026-08-26T00:00:00.000Z',
    comparison: { available: true, observedThrough: '2026-08-24' },
    entries: [{ id: 'google:one', rank: 1, topic: 'One', category: category ?? 'Technology', overallScore: 88.5, movement: { status: 'unchanged', delta: 0, previousRank: 1 } }],
  }
}

function setup({ reject } = {}) {
  const leaderboardService = { getLeaderboard: reject ? vi.fn().mockRejectedValue(reject) : vi.fn(async (request) => leaderboardResult(request)) }
  const logger = { error: vi.fn() }
  return { handler: createApiHandler({ leaderboardService, logger }), leaderboardService, logger }
}

async function response(handler, url, method = 'GET') {
  const result = await handler({ method, url })
  return { ...result, json: JSON.parse(result.body) }
}

describe('read-only leaderboard HTTP API handler', () => {
  it('serves a cheap health response', async () => {
    const { handler, leaderboardService } = setup()
    const result = await response(handler, '/api/health')
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ status: 'ok' })
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(leaderboardService.getLeaderboard).not.toHaveBeenCalled()
  })

  it('serves a valid replay 7D leaderboard through the application service', async () => {
    const { handler, leaderboardService } = setup()
    const result = await response(handler, '/api/leaderboard?window=7D')
    expect(result.status).toBe(200)
    expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith({ providerId: 'google-trending-now', dataMode: 'replay', window: '7D', mode: 'overall' })
    expect(result.json).toMatchObject({
      metadata: { providerId: 'google-trending-now', dataMode: 'replay', window: '7D', mode: 'overall', category: null, comparisonAvailable: true, comparisonObservedThrough: '2026-08-24' },
      entries: [{ rank: 1, candidateId: 'google:one', score: 88.5, movement: { status: 'unchanged', delta: 0, previousRank: 1 } }],
    })
    expect(result.headers['Content-Type']).toContain('application/json')
  })

  it.each(['24H', '7D', '30D', '1Y'])('forwards supported %s windows', async (window) => {
    const { handler, leaderboardService } = setup()
    await expect(response(handler, `/api/leaderboard?window=${window}`)).resolves.toMatchObject({ status: 200 })
    expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ window }))
  })

  it('keeps 30D and 1Y metadata distinct in API responses', async () => {
    const leaderboardService = {
      getLeaderboard: vi.fn(async ({ window, mode }) => ({
        ...leaderboardResult({ window, mode }),
        observationRange: window === '30D'
          ? { startDate: '2026-07-27', endDate: '2026-08-25' }
          : { startDate: '2025-08-26', endDate: '2026-08-25' },
        entries: [{ id: `google:${window}`, rank: 1, topic: window, category: 'Technology', overallScore: window === '30D' ? 77.6 : 81.83, trendingScore: 0, movement: { status: 'unchanged', delta: 0, previousRank: 1 } }],
      })),
    }
    const handler = createApiHandler({ leaderboardService, logger: { error: vi.fn() } })
    const thirtyDay = await response(handler, '/api/leaderboard?window=30D')
    const year = await response(handler, '/api/leaderboard?window=1Y')
    expect(thirtyDay.json.metadata).toMatchObject({ window: '30D', observedFrom: '2026-07-27' })
    expect(year.json.metadata).toMatchObject({ window: '1Y', observedFrom: '2025-08-26' })
    expect(thirtyDay.json.entries[0].score).toBe(77.6)
    expect(year.json.entries[0].score).toBe(81.83)
  })

  it('defaults omitted mode to overall and forwards trending explicitly', async () => {
    const { handler, leaderboardService } = setup()
    await response(handler, '/api/leaderboard?window=7D')
    expect(leaderboardService.getLeaderboard).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'overall' }))
    await response(handler, '/api/leaderboard?window=7D&mode=trending&category=Sports')
    expect(leaderboardService.getLeaderboard).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'trending', category: 'Sports' }))
  })

  it('forwards an exact category filter', async () => {
    const { handler, leaderboardService } = setup()
    const result = await response(handler, '/api/leaderboard?window=7D&category=Finance')
    expect(result.status).toBe(200)
    expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ category: 'Finance' }))
    expect(result.json.metadata.category).toBe('Finance')
  })

  it.each(['Sports', 'Gaming'])('forwards canonical %s category cohorts', async (category) => {
    const { handler, leaderboardService } = setup()
    const result = await response(handler, `/api/leaderboard?window=7D&category=${category}`)
    expect(result.status).toBe(200)
    expect(leaderboardService.getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ category }))
  })

  it('returns JSON 400 for invalid or unknown query input', async () => {
    const { handler, leaderboardService } = setup()
    await expect(response(handler, '/api/leaderboard?window=banana')).resolves.toMatchObject({ status: 400, json: { error: { code: 'bad_request' } } })
    await expect(response(handler, '/api/leaderboard?debug=true')).resolves.toMatchObject({ status: 400 })
    await expect(response(handler, '/api/leaderboard?category=sports')).resolves.toMatchObject({ status: 400, json: { error: { code: 'bad_request' } } })
    await expect(response(handler, '/api/leaderboard?mode=banana')).resolves.toMatchObject({ status: 400, json: { error: { code: 'bad_request' } } })
    expect(leaderboardService.getLeaderboard).not.toHaveBeenCalled()
  })

  it('returns 405 for non-GET and 404 for unknown API routes', async () => {
    const { handler } = setup()
    await expect(response(handler, '/api/leaderboard', 'POST')).resolves.toMatchObject({ status: 405 })
    await expect(response(handler, '/api/unknown')).resolves.toMatchObject({ status: 404 })
  })

  it('returns a safe 500 response when the application service fails without leaking secrets', async () => {
    const secret = 'sb_secret_should_not_appear'
    const { handler, logger } = setup({ reject: new Error(`Supabase failure ${secret}`) })
    const result = await response(handler, '/api/leaderboard?window=7D')
    expect(result).toMatchObject({ status: 500, json: { error: { code: 'internal_error', message: 'Unable to load leaderboard' } } })
    expect(result.body).not.toContain(secret)
    expect(logger.error).toHaveBeenCalledWith('NowRanks leaderboard API request failed', 'Error')
  })
})
