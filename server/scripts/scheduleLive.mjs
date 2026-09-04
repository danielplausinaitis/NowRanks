import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { prepareLiveSchedulerShared, runLiveIngestion } from './ingestLive.mjs'
import { runScheduledOnce, schedulePlan } from '../live/scheduler.mjs'
import { liveIngestionIdentity } from '../live/livePersistence.mjs'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'
const once = process.argv.includes('--once')
async function executeOnce() {
  const repository = createSupabaseIngestionRepository(createServerSupabaseClient())
  return runScheduledOnce({
    isWindowComplete: async ({ cycleId, window }) => (await repository.findRunByIdempotencyKey(liveIngestionIdentity({ cycleId, historyWindow: window }).idempotencyKey))?.status === 'succeeded',
    prepareShared: (env) => prepareLiveSchedulerShared({ env, dependencies: { repository } }),
    runIngestion: (env, shared) => runLiveIngestion({ env, dependencies: shared }),
  })
}
try {
  const result = once ? await executeOnce() : schedulePlan()
  console.log('NowRanks live scheduler')
  console.log(once ? JSON.stringify({ completedWindows: result.results.length, skippedAlreadyCompleted: result.skipped.length, providerSummary: result.providerSummary }, null, 2) : JSON.stringify(result, null, 2))
} catch (error) { console.error(`NowRanks live scheduler failed: ${formatErrorDiagnostics(error)}`); process.exitCode = 1 }
