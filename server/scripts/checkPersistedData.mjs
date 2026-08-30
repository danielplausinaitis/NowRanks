import { createSupabaseReadRepository } from '../read/supabaseReadRepository.mjs'
import { readPersistedTopicData } from '../read/persistedData.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'

async function main() {
  try {
    const result = await readPersistedTopicData({
      repository: createSupabaseReadRepository(createServerSupabaseClient()),
      providerId: 'google-trending-now',
      dataMode: 'replay',
      window: '1Y',
    })
    console.log('NowRanks persisted-data read check: replay data only — NOT live Google measurements.')
    console.log(`Candidates: ${result.data.length}; observations: ${result.observationCount}; provenance records: ${result.provenanceCount}.`)
    console.log(`Range: ${result.startDate ?? 'none'} to ${result.endDate ?? 'none'}; canonical reconstruction validation succeeded.`)
  } catch (error) {
    console.error(`NowRanks persisted-data read check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}

void main()
