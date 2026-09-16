import { createIngestionRunSlotGuard, createLiveSchedulerController, resolveLiveSchedulerConfig, runScheduledOnce, startLiveScheduler } from '../live/scheduler.mjs'
import { liveIngestionIdentity } from '../live/livePersistence.mjs'
import { prepareLiveSchedulerShared, runLiveIngestion } from './ingestLive.mjs'

export function schedulerConsoleDiagnostic(event) {
  console.log(`NowRanks scheduler: ${JSON.stringify(event)}`)
}

/** The scheduler delegates to exactly the normal live-ingestion entrypoint. */
export async function executeProductionScheduledSlot({ env, repository, slot }) {
  return runScheduledOnce({
    env,
    now: slot,
    isWindowComplete: async ({ cycleId, window }) => (await repository.findRunByIdempotencyKey(liveIngestionIdentity({ cycleId, historyWindow: window }).idempotencyKey))?.status === 'succeeded',
    prepareShared: (executionEnv, plan) => prepareLiveSchedulerShared({
      env: executionEnv, dependencies: { repository }, forceFreshDiscovery: plan.discoveryDue,
      discoveryFreshnessHours: plan.config.discoveryRefreshHours, baselineRefreshHours: plan.config.baselineRefreshHours,
    }),
    runIngestion: (executionEnv, shared) => runLiveIngestion({ env: executionEnv, dependencies: shared }),
  })
}

function controllerOptions({ env, repository, now, sleep, log }) {
  const config = resolveLiveSchedulerConfig(env)
  if (config.enabled && !repository) throw new Error('An ingestion repository is required when the live scheduler is enabled')
  return {
    env, now, sleep, log,
    slotGuard: config.enabled ? createIngestionRunSlotGuard({ repository, now, staleAfterMinutes: config.staleAfterMinutes }) : null,
    executeOnce: ({ slot }) => executeProductionScheduledSlot({ env, repository, slot }),
  }
}

export function createProductionLiveScheduler({ env = process.env, repository = null, now = () => new Date(), sleep, log = schedulerConsoleDiagnostic, setTimer, clearTimer }) {
  return startLiveScheduler({ ...controllerOptions({ env, repository, now, sleep, log }), setTimer, clearTimer })
}

export function createProductionLiveSchedulerController({ env = process.env, repository = null, now = () => new Date(), sleep, log = schedulerConsoleDiagnostic }) {
  return createLiveSchedulerController(controllerOptions({ env, repository, now, sleep, log }))
}
