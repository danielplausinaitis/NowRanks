export const LEADERBOARD_DATA_SOURCE_ENV = 'LEADERBOARD_DATA_SOURCE'
const SOURCES = new Set(['replay', 'live'])

/** Resolves the server-only public leaderboard source; persisted live is the default. */
export function resolveLeaderboardDataSource(env = process.env) {
  const source = env[LEADERBOARD_DATA_SOURCE_ENV] ?? 'live'
  if (!SOURCES.has(source)) throw new Error(`${LEADERBOARD_DATA_SOURCE_ENV} must be replay or live`)
  return source
}
