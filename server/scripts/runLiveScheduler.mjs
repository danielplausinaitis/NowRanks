import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { resolveLiveSchedulerConfig } from '../live/scheduler.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'
import { createProductionLiveScheduler } from './liveSchedulerRuntime.mjs'

try {
  const config = resolveLiveSchedulerConfig()
  const repository = config.enabled ? createSupabaseIngestionRepository(createServerSupabaseClient()) : null
  const scheduler = createProductionLiveScheduler({ repository })
  const stop = () => { scheduler.stop(); console.log('NowRanks scheduler: stopped') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  console.error(`NowRanks scheduler failed to start: ${formatErrorDiagnostics(error)}`)
  process.exitCode = 1
}
