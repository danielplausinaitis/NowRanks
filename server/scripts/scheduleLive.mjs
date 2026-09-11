import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { schedulePlan } from '../live/scheduler.mjs'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'
import { createProductionLiveSchedulerController } from './liveSchedulerRuntime.mjs'
const once = process.argv.includes('--once')
async function executeOnce() {
  const repository = createSupabaseIngestionRepository(createServerSupabaseClient())
  return createProductionLiveSchedulerController({ repository }).runSlot()
}
try {
  const result = once ? await executeOnce() : schedulePlan()
  console.log('NowRanks live scheduler')
  console.log(once ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2))
} catch (error) { console.error(`NowRanks live scheduler failed: ${formatErrorDiagnostics(error)}`); process.exitCode = 1 }
