import { CATEGORIES } from '../../shared/categories.mjs'
import { RANKING_MODES, SCORE_TYPE_BY_MODE } from '../../shared/rankingModes.mjs'

const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const DATA_MODES = new Set(['live', 'replay', 'test'])
const CATEGORY_SET = new Set(CATEGORIES)
const MODE_SET = new Set(RANKING_MODES)
const WINDOW_DAYS = Object.freeze({ '24H': 1, '7D': 7, '30D': 30, '1Y': 365 })

function assertRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Leaderboard request is required')
  if (!request.providerId?.trim()) throw new Error('Leaderboard request providerId is required')
  if (!DATA_MODES.has(request.dataMode)) throw new Error('Leaderboard request dataMode must be live, replay, or test')
  if (!WINDOWS.has(request.window)) throw new Error('Leaderboard request window must be 24H, 7D, 30D, or 1Y')
  if (request.mode !== undefined && !MODE_SET.has(request.mode)) throw new Error(`Leaderboard request mode must be one of: ${RANKING_MODES.join(', ')}`)
  if (request.category !== undefined && !CATEGORY_SET.has(request.category)) throw new Error(`Leaderboard request category must be one of: ${CATEGORIES.join(', ')}`)
}

/**
 * Application boundary between persisted canonical data and a future HTTP API.
 * The ranking engine is injected so this layer reuses the existing domain code,
 * rather than carrying a second server-side scoring implementation.
 */
export function createLeaderboardService({ readPersistedTopicData, rankingEngine, now = () => new Date().toISOString() }) {
  if (typeof readPersistedTopicData !== 'function') throw new Error('A persisted-data reader is required')
  if (typeof rankingEngine?.rankEntries !== 'function') throw new Error('The existing rankEntries engine is required')

  return {
    async getLeaderboard(request) {
      assertRequest(request)
      const mode = request.mode ?? 'overall'
      const persisted = await readPersistedTopicData({
        providerId: request.providerId,
        dataMode: request.dataMode,
        window: request.window,
        includePrevious: true,
      })
      if (persisted.data.length === 0) {
        throw new Error(`No persisted data is available for provider ${request.providerId} in ${request.dataMode} mode`)
      }

      const data = request.category === undefined
        ? persisted.data
        : persisted.data.filter((candidate) => candidate.category === request.category)
      if (data.length === 0) throw new Error(`No persisted candidates are available for category ${request.category}`)

      const minimumObservations = WINDOW_DAYS[request.window]
      const insufficient = data.filter((candidate) => candidate.observations.length < minimumObservations)
      if (insufficient.length > 0) {
        throw new Error(`Insufficient observations for ${request.window}: ${insufficient.length} candidate(s) need ${minimumObservations} observations`)
      }

      const entries = rankingEngine.rankEntries(data, SCORE_TYPE_BY_MODE[mode], request.window)
      const comparisonData = persisted.comparisonEndDate
        ? data.map((candidate) => ({ ...candidate, observations: candidate.observations.filter((observation) => observation.date <= persisted.comparisonEndDate) }))
        : []
      const comparisonAvailable = Boolean(persisted.comparisonEndDate)
        && comparisonData.every((candidate) => candidate.observations.length >= minimumObservations)
      const previousRanks = comparisonAvailable
        ? new Map(rankingEngine.rankEntries(comparisonData, SCORE_TYPE_BY_MODE[mode], request.window).map((entry) => [entry.id, entry.rank]))
        : new Map()
      const entriesWithMovement = entries.map((entry) => {
        if (!comparisonAvailable) return { ...entry, movement: { status: 'unavailable', delta: null, previousRank: null } }
        const previousRank = previousRanks.get(entry.id)
        if (previousRank === undefined) return { ...entry, movement: { status: 'new', delta: null, previousRank: null } }
        const delta = previousRank - entry.rank
        return { ...entry, movement: delta === 0
          ? { status: 'unchanged', delta: 0, previousRank }
          : { status: 'moved', delta, previousRank } }
      })
      return {
        providerId: request.providerId,
        dataMode: request.dataMode,
        window: request.window,
        mode,
        ...(request.category === undefined ? {} : { category: request.category }),
        observationRange: { startDate: persisted.startDate, endDate: persisted.endDate },
        comparison: { available: comparisonAvailable, observedThrough: comparisonAvailable ? persisted.comparisonEndDate : null },
        generatedAt: now(),
        entries: entriesWithMovement,
      }
    },
  }
}
