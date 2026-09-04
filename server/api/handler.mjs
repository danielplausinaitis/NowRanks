import { CATEGORIES } from '../../shared/categories.mjs'
import { RANKING_MODES } from '../../shared/rankingModes.mjs'

const SUPPORTED_WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const SUPPORTED_CATEGORIES = new Set(CATEGORIES)
const SUPPORTED_MODES = new Set(RANKING_MODES)
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function json(status, body, headers = {}) {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) }
}

function badRequest(message) {
  return json(400, { error: { code: 'bad_request', message } }, { 'Cache-Control': 'no-store' })
}

function validateLeaderboardQuery(searchParams) {
  const allowed = new Set(['window', 'category', 'mode'])
  for (const key of searchParams.keys()) if (!allowed.has(key)) throw new Error(`Unsupported query parameter: ${key}`)
  for (const key of allowed) if (searchParams.getAll(key).length > 1) throw new Error(`Query parameter ${key} may only be supplied once`)

  const window = searchParams.get('window') ?? '7D'
  if (!SUPPORTED_WINDOWS.has(window)) throw new Error('window must be one of 24H, 7D, 30D, or 1Y')
  const category = searchParams.get('category')
  if (category !== null && !category.trim()) throw new Error('category must be non-empty when supplied')
  if (category !== null && !SUPPORTED_CATEGORIES.has(category)) throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`)
  const mode = searchParams.get('mode') ?? 'overall'
  if (!SUPPORTED_MODES.has(mode)) throw new Error('mode must be one of: overall, trending')
  return { window, category, mode }
}

function liveEntry(entry) {
  return {
    candidateId: entry.candidateId, query: entry.query, title: entry.title, normalizedQuery: entry.normalizedQuery, category: entry.category,
    scoreLane: entry.scoreLane, laneRank: entry.laneRank, classification: entry.classification, confidence: entry.confidence,
    confidenceReason: entry.confidenceReason, scoreBasis: entry.scoreBasis, overallScore: entry.overallScore,
    establishedTrendingScore: entry.establishedTrendingScore, emergingTrendingScore: entry.emergingTrendingScore,
    historyObservationCount: entry.historyObservationCount, historyAvailableCount: entry.historyAvailableCount,
    historyCoveragePercentage: entry.historyCoveragePercentage, searchInterest: entry.searchInterest,
    componentAvailability: entry.componentAvailability, scoredAt: entry.scoredAt, cycleId: entry.cycleId, selectedWindow: entry.selectedWindow,
  }
}

function liveResponse({ result, mode, category }) {
  // Snapshot ranks are persisted for the full cohort. A category filter therefore
  // narrows each lane but deliberately preserves those ranks rather than fabricating reranks.
  const withinCategory = (entry) => category === null || entry.category === category
  const established = result.established.filter(withinCategory)
  const emerging = mode === 'trending' ? result.emerging.filter(withinCategory) : []
  return {
    dataMode: 'live', source: 'persisted-live-snapshot', persisted: true,
    snapshot: { cycleId: result.snapshot.cycleId, selectedWindow: result.snapshot.selectedWindow, scoredAt: result.snapshot.scoredAt },
    metadata: {
      mode, category, establishedCount: established.length, emergingCount: emerging.length,
      categoryRankSemantics: category === null ? 'persisted-global-lane-rank' : 'persisted-global-lane-rank-not-reranked',
    },
    established: established.map(liveEntry),
    emerging: emerging.map(liveEntry),
  }
}

/** Pure HTTP request handler; replay and persisted-live reads are explicit and isolated. */
export function createApiHandler({ dataSource = 'replay', leaderboardService, liveLeaderboardRead, logger = console }) {
  if (!['replay', 'live'].includes(dataSource)) throw new Error('Leaderboard data source must be replay or live')
  if (dataSource === 'replay' && typeof leaderboardService?.getLeaderboard !== 'function') throw new Error('A leaderboard application service is required')
  if (dataSource === 'live' && typeof liveLeaderboardRead !== 'function') throw new Error('A live leaderboard read service is required')

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
      const { window, category, mode } = query
      if (dataSource === 'live') {
        const live = await liveLeaderboardRead({ selectedWindow: window })
        return json(200, liveResponse({ result: live, mode, category }), { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=300' })
      }
      const leaderboard = await leaderboardService.getLeaderboard({
        providerId: 'google-trending-now',
        dataMode: 'replay',
        window,
        mode,
        ...(category === null ? {} : { category }),
      })
      return json(200, {
        metadata: {
          providerId: leaderboard.providerId,
          dataMode: leaderboard.dataMode,
          window: leaderboard.window,
          mode: leaderboard.mode,
          category: leaderboard.category ?? null,
          observedFrom: leaderboard.observationRange.startDate,
          observedThrough: leaderboard.observationRange.endDate,
          comparisonAvailable: leaderboard.comparison.available,
          comparisonObservedThrough: leaderboard.comparison.observedThrough,
          generatedAt: leaderboard.generatedAt,
        },
        entries: leaderboard.entries.map((entry) => ({ rank: entry.rank, candidateId: entry.id, topic: entry.topic, category: entry.category, score: entry[leaderboard.mode === 'trending' ? 'trendingScore' : 'overallScore'], movement: entry.movement })),
      }, { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=300' })
    } catch (error) {
      logger.error?.('NowRanks leaderboard API request failed', error instanceof Error ? error.name : 'Unknown error')
      if (dataSource === 'live' && error?.code === 'live_snapshot_not_found') {
        return json(404, { error: { code: 'live_snapshot_not_found', message: 'No persisted live snapshot is available for the requested window' } }, { 'Cache-Control': 'no-store' })
      }
      return json(500, { error: { code: 'internal_error', message: 'Unable to load leaderboard' } }, { 'Cache-Control': 'no-store' })
    }
  }
}
