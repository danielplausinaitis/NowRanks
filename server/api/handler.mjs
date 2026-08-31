import { CATEGORIES } from '../../shared/categories.mjs'

const SUPPORTED_WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const SUPPORTED_CATEGORIES = new Set(CATEGORIES)
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function json(status, body, headers = {}) {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) }
}

function badRequest(message) {
  return json(400, { error: { code: 'bad_request', message } }, { 'Cache-Control': 'no-store' })
}

function validateLeaderboardQuery(searchParams) {
  const allowed = new Set(['window', 'category'])
  for (const key of searchParams.keys()) if (!allowed.has(key)) throw new Error(`Unsupported query parameter: ${key}`)
  for (const key of allowed) if (searchParams.getAll(key).length > 1) throw new Error(`Query parameter ${key} may only be supplied once`)

  const window = searchParams.get('window') ?? '7D'
  if (!SUPPORTED_WINDOWS.has(window)) throw new Error('window must be one of 24H, 7D, 30D, or 1Y')
  const category = searchParams.get('category')
  if (category !== null && !category.trim()) throw new Error('category must be non-empty when supplied')
  if (category !== null && !SUPPORTED_CATEGORIES.has(category)) throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`)
  return { window, category }
}

/** Pure HTTP request handler; all ranking work stays in the application service. */
export function createApiHandler({ leaderboardService, logger = console }) {
  if (typeof leaderboardService?.getLeaderboard !== 'function') throw new Error('A leaderboard application service is required')

  return async function handleApiRequest({ method, url }) {
    const parsedUrl = new URL(url, 'http://127.0.0.1')
    if (!parsedUrl.pathname.startsWith('/api/')) return json(404, { error: { code: 'not_found', message: 'API route not found' } }, { 'Cache-Control': 'no-store' })
    if (method !== 'GET') return json(405, { error: { code: 'method_not_allowed', message: 'Only GET is supported' } }, { Allow: 'GET', 'Cache-Control': 'no-store' })
    if (parsedUrl.pathname === '/api/health') {
      if ([...parsedUrl.searchParams.keys()].length > 0) return badRequest('Health endpoint does not accept query parameters')
      return json(200, { status: 'ok' }, { 'Cache-Control': 'no-store' })
    }
    if (parsedUrl.pathname !== '/api/leaderboard') return json(404, { error: { code: 'not_found', message: 'API route not found' } }, { 'Cache-Control': 'no-store' })

    let query
    try {
      query = validateLeaderboardQuery(parsedUrl.searchParams)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'Invalid query parameters')
    }
    try {
      const { window, category } = query
      const leaderboard = await leaderboardService.getLeaderboard({
        providerId: 'google-trending-now',
        dataMode: 'replay',
        window,
        ...(category === null ? {} : { category }),
      })
      return json(200, {
        metadata: {
          providerId: leaderboard.providerId,
          dataMode: leaderboard.dataMode,
          window: leaderboard.window,
          category: leaderboard.category ?? null,
          observedFrom: leaderboard.observationRange.startDate,
          observedThrough: leaderboard.observationRange.endDate,
          generatedAt: leaderboard.generatedAt,
        },
        entries: leaderboard.entries.map((entry) => ({ rank: entry.rank, candidateId: entry.id, topic: entry.topic, category: entry.category, score: entry.overallScore })),
      }, { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=300' })
    } catch (error) {
      logger.error?.('NowRanks leaderboard API request failed', error instanceof Error ? error.name : 'Unknown error')
      return json(500, { error: { code: 'internal_error', message: 'Unable to load leaderboard' } }, { 'Cache-Control': 'no-store' })
    }
  }
}
