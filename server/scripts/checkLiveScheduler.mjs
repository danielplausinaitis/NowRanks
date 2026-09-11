import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { schedulerHealth } from '../live/scheduler.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

try {
  const repository = createSupabaseIngestionRepository(createServerSupabaseClient())
  const runs = await repository.listRecentLiveIngestionRuns({ limit: 100 })
  console.log(JSON.stringify(schedulerHealth({ runs }), null, 2))
} catch (error) {
  console.error(`NowRanks scheduler health check failed: ${formatErrorDiagnostics(error)}`)
  process.exitCode = 1
}
