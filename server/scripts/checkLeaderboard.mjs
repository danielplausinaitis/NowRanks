import { createLeaderboardService } from '../application/leaderboardService.mjs'
import { withExistingLeaderboardEngine } from '../application/viteLeaderboardEngine.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { readPersistedTopicData } from '../read/persistedData.mjs'
import { createSupabaseReadRepository } from '../read/supabaseReadRepository.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

const window = process.argv[2] ?? '7D'

async function main() {
  try {
    const result = await withExistingLeaderboardEngine((rankingEngine) => createLeaderboardService({
      rankingEngine,
      readPersistedTopicData: (request) => readPersistedTopicData({
        repository: createSupabaseReadRepository(createServerSupabaseClient()),
        ...request,
      }),
    }).getLeaderboard({ providerId: 'google-trending-now', dataMode: 'replay', window }))

    console.log('NowRanks persisted leaderboard check')
    console.log(`DATA MODE: ${result.dataMode.toUpperCase()} — NOT LIVE GOOGLE DATA`)
    console.log(`Window: ${result.window}; candidates ranked: ${result.entries.length}; range: ${result.observationRange.startDate} to ${result.observationRange.endDate}`)
    console.log('Top 10:')
    for (const entry of result.entries.slice(0, 10)) console.log(`${entry.rank}. ${entry.topic} — ${entry.overallScore.toFixed(2)}`)
  } catch (error) {
    console.error(`NowRanks persisted leaderboard check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}

void main()
