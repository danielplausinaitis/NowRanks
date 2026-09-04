import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { readLiveLeaderboard } from '../live/liveLeaderboardReadService.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

export const LIVE_READ_WINDOW_ENV = 'LIVE_READ_WINDOW'
export const LIVE_READ_CYCLE_ID_ENV = 'LIVE_READ_CYCLE_ID'

function score(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'N/A'
}

export async function runLiveReadCheck({ env = process.env, write = console.log, createClient = createServerSupabaseClient, createRepository = createSupabaseIngestionRepository, read = readLiveLeaderboard } = {}) {
  const selectedWindow = env[LIVE_READ_WINDOW_ENV] || '1Y'
  const cycleId = env[LIVE_READ_CYCLE_ID_ENV]?.trim() || undefined
  const result = await read({ repository: createRepository(createClient(env)), selectedWindow, cycleId })
  write('NowRanks live read check')
  write('LIVE PERSISTED DATA — READ ONLY')
  write('')
  write('Snapshot:')
  write(`cycle: ${result.snapshot.cycleId}`)
  write(`window: ${result.snapshot.selectedWindow}`)
  write(`scored_at: ${result.snapshot.scoredAt}`)
  write('')
  write('Established:')
  result.established.forEach((entry) => write(`#${entry.laneRank} ${entry.title} | overall ${score(entry.overallScore)} | trending ${score(entry.establishedTrendingScore)} | confidence ${entry.confidence}`))
  write('')
  write('Emerging:')
  result.emerging.forEach((entry) => write(`#${entry.laneRank} ${entry.title} | emerging trending ${score(entry.emergingTrendingScore)} | confidence ${entry.confidence}`))
  write('')
  write('Counts:')
  write(`established: ${result.established.length}`)
  write(`emerging: ${result.emerging.length}`)
  write(`total: ${result.established.length + result.emerging.length}`)
  write('')
  write('No writes performed.')
  return result
}

async function main() {
  try {
    await runLiveReadCheck()
  } catch (error) {
    console.error(`NowRanks live read check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) void main()
