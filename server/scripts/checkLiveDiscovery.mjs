import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { buildSerpApiDiscoveryRequestFromEnv } from '../live/serpApiDiscoveryConfig.mjs'
import { createSerpApiTrendingNowClient } from '../live/serpApiTrendingNow.mjs'

async function main() {
  try {
    const request = buildSerpApiDiscoveryRequestFromEnv(process.env)
    const results = await createSerpApiTrendingNowClient().discover(request)
    console.log('NowRanks live discovery check')
    console.log('LIVE EXTERNAL DATA — NOT PERSISTED; no Supabase writes or ingestion occurred.')
    console.log(`Candidates: ${results.length}; geography: ${request.geo}`)
    for (const candidate of results.slice(0, 10)) console.log(`${candidate.query} · ${candidate.category ?? 'UNMAPPED CATEGORY'}${candidate.active === undefined ? '' : candidate.active ? ' · active' : ' · inactive'}`)
  } catch (error) {
    console.error(`NowRanks live discovery check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}
void main()
