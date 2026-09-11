import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { readLiveLeaderboard } from '../live/liveLeaderboardReadService.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

export const LIVE_READ_WINDOW_ENV = 'LIVE_READ_WINDOW'
export const LIVE_READ_CYCLE_ID_ENV = 'LIVE_READ_CYCLE_ID'
const LIVE_WINDOWS = new Set(['24H', '7D', '30D', '1Y'])

export function resolveLiveReadWindow({ env = process.env, args = process.argv.slice(2) } = {}) {
  let commandWindow
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument.startsWith('--window=')) commandWindow = argument.slice('--window='.length)
    else if (argument === '--window') commandWindow = args[++index]
    else throw new Error(`Unsupported live read check argument: ${argument}`)
  }
  const selectedWindow = commandWindow || env[LIVE_READ_WINDOW_ENV] || '24H'
  if (!LIVE_WINDOWS.has(selectedWindow)) throw new Error('Live read window must be 24H, 7D, 30D, or 1Y')
  return selectedWindow
}

function score(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'N/A'
}
function growth(entry) {
  return Number.isFinite(entry.growthPercent) ? `${entry.growthPercent > 0 ? '+' : ''}${entry.growthPercent}% (${entry.growthSource ?? 'unavailable'})` : 'unavailable'
}
function movement(entry) {
  const value = entry.movement
  if (!value || value.state === 'unavailable') return 'N/A'
  if (value.state === 'new') return 'NEW'
  if (value.state === 'unchanged') return '—'
  return value.state === 'up' ? `↑ ${value.delta}` : `↓ ${Math.abs(value.delta)}`
}

export async function runLiveReadCheck({ env = process.env, args, write = console.log, createClient = createServerSupabaseClient, createRepository = createSupabaseIngestionRepository, read = readLiveLeaderboard } = {}) {
  const selectedWindow = resolveLiveReadWindow({ env, ...(args === undefined ? {} : { args }) })
  const cycleId = env[LIVE_READ_CYCLE_ID_ENV]?.trim() || undefined
  const result = await read({ repository: createRepository(createClient(env)), selectedWindow, cycleId })
  write('NowRanks live read check')
  write('LIVE PERSISTED DATA — READ ONLY')
  write(`requested_window: ${selectedWindow}`)
  write('')
  write('Snapshot:')
  write(`cycle: ${result.snapshot.cycleId}`)
  write(`window: ${result.snapshot.selectedWindow}`)
  write(`scored_at: ${result.snapshot.scoredAt}`)
  write(`format: v${result.snapshot.snapshotFormatVersion}`)
  write('')
  if (result.rankingMode === 'unified') {
    write('Unified public leaderboard:')
    result.entries.forEach((entry) => write(`#${entry.publicRank} ${entry.title} | now score ${score(entry.publicScore)} | growth ${growth(entry)} | status ${entry.evidenceStatus} | movement ${movement(entry)}`))
    write('')
    write(`total: ${result.entries.length}`)
    write('No writes performed.')
    return result
  }
  if (result.rankingMode === 'unsupported') {
    write(`Unsupported snapshot format; diagnostics: ${JSON.stringify(result.compatibility.diagnostics)}`)
    write('No writes performed.')
    return result
  }
  write('Established:')
  result.established.forEach((entry) => write(`#${entry.laneRank} ${entry.title} | overall ${score(entry.overallScore)} | trending ${score(entry.establishedTrendingScore)} | movement ${movement(entry)} | confidence ${entry.confidence}`))
  write('')
  write('Emerging:')
  result.emerging.forEach((entry) => write(`#${entry.laneRank} ${entry.title} | emerging trending ${score(entry.emergingTrendingScore)} | movement ${movement(entry)} | confidence ${entry.confidence}`))
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
