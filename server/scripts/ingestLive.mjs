import { pathToFileURL } from 'node:url'
import { withExistingScoringEngine } from '../application/viteLeaderboardEngine.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { getIngestionStaleAfterMinutes } from '../ingestion/persistence.mjs'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { createDataForSeoSearchVolumeClient } from '../live/dataForSeoSearchVolume.mjs'
import { createDataForSeoTrendsClient } from '../live/dataForSeoTrends.mjs'
import { resolveShadowHistoryWindow, shadowHistoryRequestForWindow } from '../live/elapsedShadowHistory.mjs'
import { collectLiveIngestionCycle, collectLiveSharedInputs } from '../live/liveIngestionPipeline.mjs'
import {
  assertLiveDatabaseWriteAllowed,
  buildLivePersistencePlan,
  executeLivePersistence,
  resolveLiveIngestionSafetyConfig,
  summarizeLiveDryRun,
} from '../live/livePersistence.mjs'
import { buildSerpApiDiscoveryRequestFromEnv } from '../live/serpApiDiscoveryConfig.mjs'
import { createSerpApiTrendingNowClient } from '../live/serpApiTrendingNow.mjs'
import { resolveShadowTrendsMode } from '../live/shadowHistoryRetrieval.mjs'
import { scoreElapsedTimeShadowLiveCohort } from '../live/shadowScoring.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

function optionalInteger(value, name) {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`)
  return number
}

function locationRequest(env) {
  return {
    locationCode: optionalInteger(env.DATAFORSEO_LOCATION_CODE, 'DATAFORSEO_LOCATION_CODE'),
    locationName: env.DATAFORSEO_LOCATION_NAME || undefined,
    locationCoordinate: env.DATAFORSEO_LOCATION_COORDINATE || undefined,
  }
}

function liveHistoryWindow(env) {
  return resolveShadowHistoryWindow({ LIVE_SHADOW_HISTORY_WINDOW: env.LIVE_INGEST_HISTORY_WINDOW })
}

function liveTrendsMode(env) {
  return resolveShadowTrendsMode({ LIVE_SHADOW_TRENDS_MODE: env.LIVE_INGEST_TRENDS_MODE })
}

function printSummary(summary) {
  console.log(`Cycle: ${summary.cycleId}`)
  console.log(`Idempotency key: ${summary.idempotencyKey}`)
  console.log(`Candidates: ${summary.candidates}; established: ${summary.established}; emerging: ${summary.emerging}; insufficient: ${summary.insufficient}.`)
  console.log(`Would write: ${summary.observations} observations; ${summary.provenances} provenance rows; ${summary.evidence} evidence rows; ${summary.snapshots} snapshot header; ${summary.snapshotEntries} ranked snapshot entries.`)
  const requests = summary.providerRequests
  const costs = summary.providerCosts
  console.log(`Provider requests: SerpApi ${requests.serpApi}; DataForSEO Search Volume ${requests.dataForSeoSearchVolume}; DataForSEO Trends ${requests.dataForSeoTrends}.`)
  console.log(`Provider-reported cost: Search Volume $${Number(costs.searchVolume).toFixed(4)}; Trends $${Number(costs.trends).toFixed(4)}; total $${Number(costs.total).toFixed(4)}; SerpApi ${costs.serpApi}.`)
  const cache = summary.baselineCache
  if (cache) console.log(`Baseline cache: fresh hits ${cache.freshHits}; stale/missing ${cache.staleOrMissing}; Search Volume keywords requested ${cache.requestedKeywords}; provider requests avoided ${cache.requestsAvoided}; cache rows refreshed ${cache.rowsRefreshed}; cache writes skipped ${cache.writesSkipped}.`)
}

function volumeRequest(env) {
  return { ...locationRequest(env), languageCode: env.DATAFORSEO_LANGUAGE_CODE || undefined, languageName: env.DATAFORSEO_LANGUAGE_NAME || undefined, dateFrom: env.DATAFORSEO_VOLUME_DATE_FROM || undefined, dateTo: env.DATAFORSEO_VOLUME_DATE_TO || undefined }
}

export async function prepareLiveSchedulerShared({ env = process.env, dependencies = {} } = {}) {
  const safety = resolveLiveIngestionSafetyConfig(env)
  if (!safety.dryRun) assertLiveDatabaseWriteAllowed(env)
  const repository = dependencies.repository ?? createSupabaseIngestionRepository(createServerSupabaseClient(env))
  const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(env)
  const sharedInputs = await collectLiveSharedInputs({ candidateLimit: safety.candidateLimit, discoveryRequest, volumeRequest: volumeRequest(env), discoveryClient: dependencies.discoveryClient ?? createSerpApiTrendingNowClient({ env }), volumeClient: dependencies.volumeClient ?? createDataForSeoSearchVolumeClient({ env }), baselineCacheRepository: repository, baselineCacheTtlHours: Number(env.LIVE_BASELINE_TTL_HOURS || 24), writeBaselineCache: !safety.dryRun, onProgress: (stage) => console.log(`NowRanks live scheduler shared stage: ${stage}`) })
  return { sharedInputs, repository }
}

export async function runLiveIngestion({ env = process.env, dependencies = {} } = {}) {
  const safety = resolveLiveIngestionSafetyConfig(env)
  if (!safety.dryRun) assertLiveDatabaseWriteAllowed(env)
  const historyWindow = liveHistoryWindow(env)
  const trendsMode = liveTrendsMode(env)
  const repository = dependencies.repository ?? createSupabaseIngestionRepository(createServerSupabaseClient(env))
  const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(env)
  const plannedTrendRequests = trendsMode === 'single' ? safety.candidateLimit : Math.ceil(safety.candidateLimit / 5)
  console.log('NowRanks live ingestion')
  console.log(safety.dryRun ? 'LIVE EXTERNAL DATA — DRY RUN — NOT PERSISTED' : 'LIVE EXTERNAL DATA — DATABASE WRITE EXPLICITLY ENABLED')
  console.log(`Planned maximum: ${safety.candidateLimit} candidates; SerpApi 1 request; DataForSEO Search Volume 1 request; DataForSEO Trends up to ${plannedTrendRequests} requests.`)

  const cycle = await collectLiveIngestionCycle({
    candidateLimit: safety.candidateLimit,
    discoveryRequest,
    volumeRequest: volumeRequest(env),
    historyRequest: { ...locationRequest(env), ...shadowHistoryRequestForWindow(historyWindow) },
    historyWindow,
    trendsMode,
    discoveryClient: dependencies.discoveryClient ?? createSerpApiTrendingNowClient({ env }),
    volumeClient: dependencies.volumeClient ?? createDataForSeoSearchVolumeClient({ env }),
    trendsClient: dependencies.trendsClient ?? createDataForSeoTrendsClient({ env }),
    scoreCycle: dependencies.scoreCycle ?? ((args) => withExistingScoringEngine(({ signalEngine, scoreWeights }) => scoreElapsedTimeShadowLiveCohort({ ...args, signalEngine, scoreWeights }))),
    baselineCacheRepository: repository,
    baselineCacheTtlHours: Number(env.LIVE_BASELINE_TTL_HOURS || 24),
    writeBaselineCache: !safety.dryRun,
    sharedInputs: dependencies.sharedInputs,
    onProgress: (stage) => console.log(`NowRanks live ingestion stage: ${stage}`),
  })
  const plan = buildLivePersistencePlan({ cycleId: safety.cycleId, historyWindow, ...cycle })
  const summary = summarizeLiveDryRun(plan, cycle.requestMetrics)
  const displayedSummary = dependencies.sharedInputs ? { ...summary, providerRequests: { ...summary.providerRequests, serpApi: 0, dataForSeoSearchVolume: 0 }, providerCosts: { ...summary.providerCosts, searchVolume: 0, total: summary.providerCosts.trends }, baselineCache: null } : summary
  printSummary(displayedSummary)
  if (safety.dryRun) {
    await executeLivePersistence({ dryRun: true, plan, requestMetrics: cycle.requestMetrics })
    console.log('Dry run complete: zero database writes performed.')
    return summary
  }
  const result = await executeLivePersistence({
    dryRun: false, plan, repository, env,
    staleAfterMinutes: getIngestionStaleAfterMinutes(env),
    recoverStaleRun: safety.recoverStaleRun,
    onProgress: (progress) => console.log(typeof progress === 'string'
      ? `NowRanks live ingestion stage: ${progress}`
      : `NowRanks live ingestion Observations: ${progress.completed} / ${progress.total}`),
  })
  console.log(`Live ingestion ${result.status}: ${result.candidates} candidates; ${result.observations} observations; ${result.snapshotEntries} ranked snapshot entries.`)
  return { ...result, requestMetrics: cycle.requestMetrics }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runLiveIngestion().catch((error) => {
    console.error(`NowRanks live ingestion did not run: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  })
}
