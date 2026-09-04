export const LEADERBOARD_DATA_SOURCE_ENV = 'LEADERBOARD_DATA_SOURCE'
const SOURCES = new Set(['replay', 'live'])

/** Resolves the server-only leaderboard source; replay remains intentionally default. */
export function resolveLeaderboardDataSource(env = process.env) {
  const source = env[LEADERBOARD_DATA_SOURCE_ENV] ?? 'replay'
  if (!SOURCES.has(source)) throw new Error(`${LEADERBOARD_DATA_SOURCE_ENV} must be replay or live`)
  return source
}
