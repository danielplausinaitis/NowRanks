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
import { resolveHistoricalVaultConfig } from '../live/historicalVault.mjs'
import { readHistoricalVaultCoverage } from '../live/historicalVaultReadService.mjs'
import { evaluate24hGrowthPromotion } from '../live/historicalVaultPromotion.mjs'
import { resolveGrowthPresentation } from '../live/trendPresentation.mjs'
import { buildActiveTrackingCohort, DEFAULT_CANONICAL_CONTINUITY_RETENTION_HOURS, DEFAULT_TRACKING_RETENTION_HOURS } from '../live/activeTrackingCohort.mjs'
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
  const evaluation = summary.evaluation ?? {}
  console.log(`Candidates: discovery ${evaluation.discoveryCandidateCount ?? summary.candidates}; scored discovery ${evaluation.scoringDiscoveryCandidateCount ?? summary.candidates}; selected paid tracking ${evaluation.selectedPaidTrackingCount ?? summary.candidates}; unified: ${summary.unified}; insufficient: ${summary.insufficient}.`)
  console.log(`Would write: ${summary.observations} observations; ${summary.vaultMeasurements ?? 0} vault measurements; ${summary.provenances} provenance rows; ${summary.evidence} evidence rows; ${summary.snapshots} snapshot header; ${summary.snapshotEntries} ranked snapshot entries.`)
  if (summary.canonicalArtifacts) {
    console.log(`Canonical attention: eligible ${summary.canonicalAttention?.eligibleCandidates ?? 0}; bootstrapped ${summary.canonicalAttention?.bootstrapped ?? 0}; aligned ${summary.canonicalAttention?.aligned ?? 0}; rejected ${summary.canonicalAttention?.rejected ?? 0}; raw artifacts ${summary.canonicalArtifacts}; new points ${summary.canonicalPoints}.`)
    const reasons = summary.canonicalAttention?.rejectionReasons ?? {}
    if (Object.keys(reasons).length) console.log(`Canonical attention rejections: ${Object.entries(reasons).map(([reason, count]) => `${reason}=${count}`).join(', ')}.`)
  }
  const requests = summary.providerRequests
  const costs = summary.providerCosts
  console.log(`Provider requests: SerpApi ${requests.serpApi}; DataForSEO Search Volume ${requests.dataForSeoSearchVolume}; DataForSEO Trends ${requests.dataForSeoTrends}.`)
  console.log(`Provider-reported cost: Search Volume $${Number(costs.searchVolume).toFixed(4)}; Trends $${Number(costs.trends).toFixed(4)}; total $${Number(costs.total).toFixed(4)}; SerpApi ${costs.serpApi}.`)
  const cache = summary.baselineCache
  if (cache) console.log(`Baseline cache: fresh hits ${cache.freshHits}; stale/missing ${cache.staleOrMissing}; Search Volume keywords requested ${cache.requestedKeywords}; provider requests avoided ${cache.requestsAvoided}; cache rows refreshed ${cache.rowsRefreshed}; cache writes skipped ${cache.writesSkipped}.`)
  const graph = summary.graphMeasurements
  if (graph) console.log(`Trends graph diagnostics: invalid/missing measurements skipped ${graph.invalidOrMissingMeasurements}; affected candidates ${graph.affectedCandidates}.`)
  if (summary.tracking) console.log(`Paid measurement cohort: previous Top20 retained ${summary.tracking.previousTop20}; canonical continuity ${summary.tracking.canonicalContinuity}; fresh discoveries ${summary.tracking.freshDiscoveries}; grace-retained ${summary.tracking.graceRetained}; missing-history retries ${summary.tracking.missingHistoryRetries}; deduplicated total ${summary.tracking.deduplicatedTotal} / ${summary.tracking.maxPaidCandidates}; actual Trends requests ${evaluation.actualTrendsRequestCount ?? requests.dataForSeoTrends ?? 0}; tracked absent from discovery ${evaluation.trackedCandidatesAbsentFromCurrentDiscovery ?? 0}; selected but not measured ${evaluation.selectedButNotMeasuredCount ?? 0}.`)
  if (summary.vault) {
    console.log(`Vault Growth (${summary.historyWindow}): available ${summary.vault.available}; unavailable ${summary.vault.unavailable}; promotion eligible ${summary.vault.promotionEligible ?? 0}; shadow would-promote ${summary.vault.shadowWouldPromote ?? 0}; preferred promoted ${summary.vault.preferredPromoted ?? 0}; public Growth changed by vault: ${summary.vault.publicChangedByVault}.`)
    const rejections = summary.vault.promotionRejectionReasons ?? {}
    if (Object.keys(rejections).length) console.log(`Vault Growth promotion rejections: ${Object.entries(rejections).map(([reason, count]) => `${reason}=${count}`).join(', ')}.`)
  }
}

function volumeRequest(env) {
  return { ...locationRequest(env), languageCode: env.DATAFORSEO_LANGUAGE_CODE || undefined, languageName: env.DATAFORSEO_LANGUAGE_NAME || undefined, dateFrom: env.DATAFORSEO_VOLUME_DATE_FROM || undefined, dateTo: env.DATAFORSEO_VOLUME_DATE_TO || undefined }
}

export async function attachVaultGrowth({ cycle, repository, historyWindow, vaultConfig }) {
  if (!vaultConfig.enabled || vaultConfig.growthMode === 'off' || !repository.listCandidatesByNormalizedQueries) return cycle
  const candidates = await repository.listCandidatesByNormalizedQueries({ normalizedQueries: cycle.candidates.map((candidate) => candidate.normalizedQuery) })
  if (!candidates.length) return cycle
  const byQuery = new Map(candidates.map((candidate) => [candidate.normalized_query, candidate.candidate_id]))
  const coverage = await readHistoricalVaultCoverage({ repository, candidateIds: candidates.map((candidate) => candidate.candidate_id), window: historyWindow, asOf: new Date(Math.floor(Date.parse(cycle.scoredAt) / (vaultConfig.slotMinutes * 60_000)) * vaultConfig.slotMinutes * 60_000).toISOString(), slotMinutes: vaultConfig.slotMinutes })
  let publicChangedByVault = 0
  const promotionRejectionReasons = {}
  let promotionEligible = 0; let shadowWouldPromote = 0; let preferredPromoted = 0
  const scores = cycle.scores.map((score) => {
    const vaultGrowth = coverage.get(byQuery.get(score.normalizedQuery)) ?? null
    const promotion = evaluate24hGrowthPromotion({ window: historyWindow, vaultGrowth, mode: vaultConfig.growthMode })
    if (promotion.eligible) promotionEligible += 1
    if (promotion.wouldPromoteInShadow) shadowWouldPromote += 1
    if (promotion.promotedInPreferred) preferredPromoted += 1
    if (!promotion.eligible) promotionRejectionReasons[promotion.reason] = (promotionRejectionReasons[promotion.reason] ?? 0) + 1
    const nowranksHistoricalGrowthPercent = promotion.promotedInPreferred ? vaultGrowth.growthPercent : null
    const providerHistoricalGrowthPercent = score.presentation?.growthSource === 'provider-history' ? score.presentation.growthPercent : null
    const discoveryIncreasePercentage = score.raw?.currentTrendIntensity?.increasePercentage ?? null
    const publicGrowth = resolveGrowthPresentation({ nowranksHistoricalGrowthPercent, providerHistoricalGrowthPercent, discoveryIncreasePercentage })
    if (publicGrowth.growthSource === 'nowranks-history' && score.presentation?.growthSource !== 'nowranks-history') publicChangedByVault += 1
    const absoluteDifference = Number.isFinite(vaultGrowth?.growthPercent) && Number.isFinite(providerHistoricalGrowthPercent)
      ? Math.abs(vaultGrowth.growthPercent - providerHistoricalGrowthPercent) : null
    const relativeDifference = absoluteDifference !== null && providerHistoricalGrowthPercent !== 0
      ? absoluteDifference / Math.abs(providerHistoricalGrowthPercent) : null
    const presentation = {
      ...score.presentation,
      ...publicGrowth,
      vaultGrowth: vaultGrowth ? { status: vaultGrowth.status, reason: vaultGrowth.reason, growthPercent: vaultGrowth.growthPercent, confidence: vaultGrowth.confidence, comparabilityKey: vaultGrowth.comparabilityKey ?? null, promotion, providerHistoricalGrowthPercent, discoveryIncreasePercentage, publicGrowthPercent: publicGrowth.growthPercent, publicGrowthSource: publicGrowth.growthSource, absoluteDifference, relativeDifference } : { promotion },
    }
    return { ...score, presentation }
  })
  return { ...cycle, scores, requestMetrics: { ...cycle.requestMetrics, vault: { mode: vaultConfig.growthMode, candidatesRead: candidates.length, available: [...coverage.values()].filter((item) => item.status === 'available').length, unavailable: [...coverage.values()].filter((item) => item.status !== 'available').length, promotionEligible, shadowWouldPromote, preferredPromoted, promotionRejectionReasons, publicChangedByVault } } }
}

export async function loadCanonicalExisting({ cycle, repository, enabled }) {
  if (!enabled || !repository.listCandidatesByNormalizedQueries || !repository.listLiveCanonicalAttentionPoints) return new Map()
  const candidates = await repository.listCandidatesByNormalizedQueries({ normalizedQueries: cycle.candidates.map((candidate) => candidate.normalizedQuery) })
  if (!candidates.length) return new Map()
  // The planner needs every retained regime, not only points in the newest provider
  // curve. That makes "no timestamp overlap" an explicit new-regime decision rather
  // than an accidental re-bootstrap of an unseen old segment.
  const points = await repository.listLiveCanonicalAttentionPoints({ candidateIds: candidates.map((candidate) => candidate.candidate_id) })
  const queryById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate.normalized_query]))
  const byQuery = new Map()
  for (const point of points) {
    const query = queryById.get(point.candidate_id)
    if (!query) continue
    if (!byQuery.has(query)) byQuery.set(query, [])
    byQuery.get(query).push(point)
  }
  return byQuery
}

export async function loadActiveTrackingState({ repository, now, canonicalContinuityRetentionHours = DEFAULT_CANONICAL_CONTINUITY_RETENTION_HOURS }) {
  if (!repository.listRecentCanonicalTrackingArtifacts) return { latestPublic: [], tracking: [] }
  const since = new Date(Date.parse(now) - Math.max(DEFAULT_TRACKING_RETENTION_HOURS, canonicalContinuityRetentionHours) * 3_600_000).toISOString()
  const artifacts = await repository.listRecentCanonicalTrackingArtifacts({ since })
  const byCandidate = new Map()
  for (const artifact of artifacts) {
    const candidate = artifact.candidates
    if (!candidate?.normalized_query) continue
    const key = candidate.normalized_query
    if (!byCandidate.has(key)) byCandidate.set(key, { candidateId: artifact.candidate_id, query: candidate.query_text, normalizedQuery: key, category: candidate.category, lastPaidAt: artifact.slot_at, lastCanonicalSuccessAt: null, consecutiveMissingHistory: 0, _artifacts: [] })
    const state = byCandidate.get(key); state._artifacts.push(artifact)
    const accepted = artifact.live_canonical_attention_alignments?.find((row) => row.accepted)
    if (!state.lastCanonicalSuccessAt && accepted) {
      state.lastCanonicalSuccessAt = artifact.slot_at
      state.recentAcceptedAlignmentConfidence = accepted.confidence ?? null
      state.canonicalSegment = accepted.segment_id ?? null
    }
  }
  const canonicalPoints = repository.listLiveCanonicalAttentionPoints
    ? await repository.listLiveCanonicalAttentionPoints({ candidateIds: [...byCandidate.values()].map((item) => item.candidateId) }) : []
  const canonicalByCandidate = new Map()
  for (const point of canonicalPoints) {
    if (!canonicalByCandidate.has(point.candidate_id)) canonicalByCandidate.set(point.candidate_id, [])
    canonicalByCandidate.get(point.candidate_id).push(point)
  }
  const tracking = [...byCandidate.values()].map((state) => {
    let consecutiveMissingHistory = 0
    for (const artifact of state._artifacts) {
      const curve = artifact.raw_curve ?? []
      const allMissing = curve.length > 0 && curve.every((point) => point.availability === 'missing' || point.value === null)
      if (!allMissing) break
      consecutiveMissingHistory += 1
    }
    const points = canonicalByCandidate.get(state.candidateId) ?? []
    const latestPoint = [...points].sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0] ?? null
    const { _artifacts, ...row } = state
    return {
      ...row,
      consecutiveMissingHistory,
      canonicalPointCount: points.length,
      canonicalSegment: latestPoint?.segment_id ?? row.canonicalSegment ?? null,
      latestCanonicalPointAt: latestPoint?.observed_at ?? null,
    }
  })
  let latestPublic = []
  if (repository.getLatestUnifiedLiveSnapshot && repository.listLiveSnapshotEntries) {
    const snapshot = await repository.getLatestUnifiedLiveSnapshot({ selectedWindow: '24H' })
    if (snapshot) latestPublic = (await repository.listLiveSnapshotEntries({ snapshotId: snapshot.snapshot_id })).map((entry) => ({ candidateId: entry.candidate_id, query: entry.candidates?.query_text, normalizedQuery: entry.candidates?.normalized_query, category: entry.candidates?.category, publicRank: entry.public_rank }))
  }
  return { latestPublic, tracking }
}

export async function prepareLiveSchedulerShared({ env = process.env, dependencies = {} } = {}) {
  const safety = resolveLiveIngestionSafetyConfig(env)
  if (!safety.dryRun) assertLiveDatabaseWriteAllowed(env)
  const repository = dependencies.repository ?? createSupabaseIngestionRepository(createServerSupabaseClient(env))
  const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(env)
  const sharedInputs = await collectLiveSharedInputs({ discoveryLimit: safety.discoveryLimit, maxPaidCandidates: safety.maxPaidCandidates, discoveryRequest, volumeRequest: volumeRequest(env), discoveryClient: dependencies.discoveryClient ?? createSerpApiTrendingNowClient({ env }), volumeClient: dependencies.volumeClient ?? createDataForSeoSearchVolumeClient({ env }), baselineCacheRepository: repository, baselineCacheTtlHours: Number(env.LIVE_BASELINE_TTL_HOURS || 24), writeBaselineCache: !safety.dryRun, onProgress: (stage) => console.log(`NowRanks live scheduler shared stage: ${stage}`) })
  return { sharedInputs, repository }
}

export async function runLiveIngestion({ env = process.env, dependencies = {} } = {}) {
  const safety = resolveLiveIngestionSafetyConfig(env)
  if (!safety.dryRun) assertLiveDatabaseWriteAllowed(env)
  const historyWindow = liveHistoryWindow(env)
  const trendsMode = liveTrendsMode(env)
  const repository = dependencies.repository ?? createSupabaseIngestionRepository(createServerSupabaseClient(env))
  const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(env)
  const plannedTrendRequests = trendsMode === 'single' ? safety.maxPaidCandidates : Math.ceil(safety.maxPaidCandidates / 5)
  console.log('NowRanks live ingestion')
  console.log(safety.dryRun ? 'LIVE EXTERNAL DATA — DRY RUN — NOT PERSISTED' : 'LIVE EXTERNAL DATA — DATABASE WRITE EXPLICITLY ENABLED')
  console.log(`Planned maximum: discovery pool ${safety.discoveryLimit}; baseline cohort ${safety.maxPaidCandidates}; initial Trends cohort ${safety.initialPaidCandidates}; display up to ${safety.displayLimit} ranked topics; SerpApi 1 request; DataForSEO Search Volume 1 request; DataForSEO Trends up to ${plannedTrendRequests} requests.`)

  const sharedInputs = dependencies.sharedInputs ?? await collectLiveSharedInputs({
    discoveryLimit: safety.discoveryLimit, maxPaidCandidates: safety.maxPaidCandidates, discoveryRequest, volumeRequest: volumeRequest(env),
    discoveryClient: dependencies.discoveryClient ?? createSerpApiTrendingNowClient({ env }), volumeClient: dependencies.volumeClient ?? createDataForSeoSearchVolumeClient({ env }),
    baselineCacheRepository: repository, baselineCacheTtlHours: Number(env.LIVE_BASELINE_TTL_HOURS || 24), writeBaselineCache: !safety.dryRun,
    onProgress: (stage) => console.log(`NowRanks live ingestion stage: ${stage}`),
  })
  const vaultConfig = resolveHistoricalVaultConfig(env)
  const trackingState = vaultConfig.enabled && vaultConfig.growthMode !== 'off'
    ? await loadActiveTrackingState({ repository, now: new Date().toISOString() }) : { latestPublic: [], tracking: [] }
  const trackingCohort = buildActiveTrackingCohort({ discoveries: sharedInputs.candidates, ...trackingState, maxPaidCandidates: safety.maxPaidCandidates })
  const cycle = await collectLiveIngestionCycle({
    discoveryLimit: safety.discoveryLimit,
    maxPaidCandidates: safety.maxPaidCandidates,
    initialPaidCandidates: safety.initialPaidCandidates,
    displayLimit: safety.displayLimit,
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
    sharedInputs,
    paidTrackingCandidates: trackingCohort.candidates,
    onProgress: (stage) => console.log(`NowRanks live ingestion stage: ${stage}`),
  })
  cycle.requestMetrics.tracking = { ...trackingCohort.diagnostics, ...cycle.requestMetrics.evaluation }
  const canonicalExistingByQuery = await loadCanonicalExisting({ cycle, repository, enabled: vaultConfig.enabled && vaultConfig.growthMode !== 'off' && historyWindow === '24H' })
  const vaultAwareCycle = await attachVaultGrowth({ cycle, repository, historyWindow, vaultConfig })
  const plan = buildLivePersistencePlan({ cycleId: safety.cycleId, historyWindow, displayLimit: safety.displayLimit, vaultConfig, vaultDiscoveryRequest: discoveryRequest, canonicalExistingByQuery, canonicalTargeting: { ...locationRequest(env), languageCode: env.DATAFORSEO_LANGUAGE_CODE || null, languageName: env.DATAFORSEO_LANGUAGE_NAME || null }, ...vaultAwareCycle })
  const summary = summarizeLiveDryRun(plan, vaultAwareCycle.requestMetrics)
  const displayedSummary = dependencies.sharedInputs ? { ...summary, providerRequests: { ...summary.providerRequests, serpApi: 0, dataForSeoSearchVolume: 0 }, providerCosts: { ...summary.providerCosts, searchVolume: 0, total: summary.providerCosts.trends }, baselineCache: null } : summary
  printSummary(displayedSummary)
  if (safety.dryRun) {
    await executeLivePersistence({ dryRun: true, plan, requestMetrics: vaultAwareCycle.requestMetrics })
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
  return { ...result, requestMetrics: vaultAwareCycle.requestMetrics }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runLiveIngestion().catch((error) => {
    console.error(`NowRanks live ingestion did not run: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  })
}
