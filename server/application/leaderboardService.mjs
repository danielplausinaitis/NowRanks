const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const DATA_MODES = new Set(['live', 'replay', 'test'])

function assertRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Leaderboard request is required')
  if (!request.providerId?.trim()) throw new Error('Leaderboard request providerId is required')
  if (!DATA_MODES.has(request.dataMode)) throw new Error('Leaderboard request dataMode must be live, replay, or test')
  if (!WINDOWS.has(request.window)) throw new Error('Leaderboard request window must be 24H, 7D, 30D, or 1Y')
  if (request.category !== undefined && !request.category.trim()) throw new Error('Leaderboard request category must be non-empty when supplied')
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
      const persisted = await readPersistedTopicData({
        providerId: request.providerId,
        dataMode: request.dataMode,
        window: request.window,
      })
      if (persisted.data.length === 0) {
        throw new Error(`No persisted data is available for provider ${request.providerId} in ${request.dataMode} mode`)
      }

      const data = request.category === undefined
        ? persisted.data
        : persisted.data.filter((candidate) => candidate.category === request.category)
      if (data.length === 0) throw new Error(`No persisted candidates are available for category ${request.category}`)

      const minimumObservations = { '24H': 1, '7D': 7, '30D': 30, '1Y': 365 }[request.window]
      const insufficient = data.filter((candidate) => candidate.observations.length < minimumObservations)
      if (insufficient.length > 0) {
        throw new Error(`Insufficient observations for ${request.window}: ${insufficient.length} candidate(s) need ${minimumObservations} observations`)
      }

      const entries = rankingEngine.rankEntries(data, 'overallScore', request.window)
      return {
        providerId: request.providerId,
        dataMode: request.dataMode,
        window: request.window,
        ...(request.category === undefined ? {} : { category: request.category }),
        observationRange: { startDate: persisted.startDate, endDate: persisted.endDate },
        generatedAt: now(),
        entries,
      }
    },
  }
}
