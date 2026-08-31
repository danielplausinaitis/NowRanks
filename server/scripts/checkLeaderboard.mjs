import { createLeaderboardService } from '../application/leaderboardService.mjs'
import { withExistingLeaderboardEngine } from '../application/viteLeaderboardEngine.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { readPersistedTopicData } from '../read/persistedData.mjs'
import { createSupabaseReadRepository } from '../read/supabaseReadRepository.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

const window = process.argv[2] ?? '7D'
const mode = process.argv[3] ?? 'overall'

async function main() {
  try {
    const result = await withExistingLeaderboardEngine((rankingEngine) => createLeaderboardService({
      rankingEngine,
      readPersistedTopicData: (request) => readPersistedTopicData({
        repository: createSupabaseReadRepository(createServerSupabaseClient()),
        ...request,
      }),
    }).getLeaderboard({ providerId: 'google-trending-now', dataMode: 'replay', window, mode }))

    console.log('NowRanks persisted leaderboard check')
    console.log(`DATA MODE: ${result.dataMode.toUpperCase()} — NOT LIVE GOOGLE DATA`)
    console.log(`Window: ${result.window}; mode: ${result.mode}; candidates ranked: ${result.entries.length}; range: ${result.observationRange.startDate} to ${result.observationRange.endDate}`)
    console.log(`Comparison: ${result.comparison.available ? `through ${result.comparison.observedThrough}` : 'unavailable (insufficient history)'}`)
    console.log('Top 10:')
    for (const entry of result.entries.slice(0, 10)) {
      const score = entry[result.mode === 'trending' ? 'trendingScore' : 'overallScore']
      const movement = entry.movement.status === 'moved' ? (entry.movement.delta > 0 ? `↑ ${entry.movement.delta}` : `↓ ${Math.abs(entry.movement.delta)}`) : entry.movement.status === 'new' ? 'NEW' : entry.movement.status === 'unchanged' ? '—' : 'N/A'
      console.log(`${entry.rank}. ${entry.topic} — ${score.toFixed(2)} ${movement}`)
    }
  } catch (error) {
    console.error(`NowRanks persisted leaderboard check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}

void main()
