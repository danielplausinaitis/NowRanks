import { createServer } from 'vite'

/** Loads the existing TypeScript leaderboard domain module for development-only server scripts. */
export async function withExistingLeaderboardEngine(callback) {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  try {
    const leaderboard = await vite.ssrLoadModule('/src/domain/leaderboard.ts')
    return await callback({ rankEntries: leaderboard.rankEntries })
  } finally {
    await vite.close()
  }
}

/** Loads the existing signal formulas and component weights for server-only shadow diagnostics. */
export async function withExistingScoringEngine(callback) {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  try {
    const scoring = await vite.ssrLoadModule('/src/domain/scoring.ts')
    const config = await vite.ssrLoadModule('/src/domain/config.ts')
    return await callback({
      signalEngine: {
        normalize: scoring.normalize,
        growthSignal: scoring.growthSignal,
        momentumSignal: scoring.momentumSignal,
        consistencySignal: scoring.consistencySignal,
        breakoutSignal: scoring.breakoutSignal,
      },
      scoreWeights: config.SCORE_WEIGHTS,
    })
  } finally {
    await vite.close()
  }
}

/** Keeps the shared TypeScript ranking module available for a development API process. */
export async function createViteLeaderboardEngine() {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  try {
    const leaderboard = await vite.ssrLoadModule('/src/domain/leaderboard.ts')
    return { rankingEngine: { rankEntries: leaderboard.rankEntries }, close: () => vite.close() }
  } catch (error) {
    await vite.close()
    throw error
  }
}
