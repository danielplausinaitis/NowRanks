export type FrontendLeaderboardDataSource = 'replay' | 'live'

/** Browser rendering contract only; the server independently selects its data source. */
export function resolveFrontendLeaderboardDataSource(env: Record<string, string | boolean | undefined>): FrontendLeaderboardDataSource {
  const source = env.VITE_LEADERBOARD_DATA_SOURCE
  if (source === undefined || source === '') return 'replay'
  if (source === 'replay' || source === 'live') return source
  throw new Error('VITE_LEADERBOARD_DATA_SOURCE must be replay or live')
}
