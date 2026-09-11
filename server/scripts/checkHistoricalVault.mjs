import { pathToFileURL } from 'node:url'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { readTopicHistoricalVault } from '../live/historicalVaultReadService.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

function option(name) {
  const value = process.argv.find((item) => item.startsWith(`${name}=`))
  return value ? value.slice(name.length + 1) : null
}

export async function checkHistoricalVault({ candidateId = option('--candidate-id'), asOf = option('--as-of') ?? new Date().toISOString(), repository = createSupabaseIngestionRepository(createServerSupabaseClient()) } = {}) {
  if (!candidateId) throw new Error('Usage: npm run vault:check -- --candidate-id=<candidate-id> [--as-of=<UTC ISO timestamp>]')
  const rows = await Promise.all(['24H', '7D', '30D', '1Y'].map(async (window) => {
    const history = await readTopicHistoricalVault({ repository, candidateId, window, asOf })
    const coverage = history.coverage
    return { window, points: history.points.length, status: coverage.status, source: coverage.growthSource, growthPercent: coverage.growthPercent, confidence: coverage.confidence, reason: coverage.reason, comparabilityKey: coverage.comparabilityKey ?? null }
  }))
  console.log(JSON.stringify({ readOnly: true, candidateId, asOf, windows: rows }, null, 2))
  return rows
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkHistoricalVault().catch((error) => { console.error(`Historical vault check failed: ${error.message}`); process.exitCode = 1 })
}
