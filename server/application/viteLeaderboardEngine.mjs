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
