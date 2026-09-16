import { pathToFileURL } from 'node:url'
import { withExistingScoringEngine } from '../application/viteLeaderboardEngine.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { getIngestionStaleAfterMinutes } from '../ingestion/persistence.mjs'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { createDataForSeoGlobalSearchVolumeClient, createDataForSeoSearchVolumeClient } from '../live/dataForSeoSearchVolume.mjs'
import { createDataForSeoTrendsClient } from '../live/dataForSeoTrends.mjs'
import { createDataForSeoGoogleTrendsClient } from '../live/dataForSeoGoogleTrends.mjs'
import { retrieveGoogleTrendsHistories } from '../live/googleTrendsHistoryRetrieval.mjs'
import { resolveLiveTrendsProvider } from '../live/liveTrendsProvider.mjs'
import { resolveShadowHistoryWindow, shadowHistoryRequestForWindow } from '../live/elapsedShadowHistory.mjs'
import { collectLiveBaselineInputs, collectLiveIngestionCycle, collectLiveSharedInputs } from '../live/liveIngestionPipeline.mjs'
import {
  assertLiveDatabaseWriteAllowed,
  buildLivePersistencePlan,
  executeLivePersistence,
  resolveLiveIngestionSafetyConfig,
  summarizeLiveDryRun,
} from '../live/livePersistence.mjs'
import { buildSerpApiDiscoveryRequestFromEnv, buildSerpApiDiscoveryRequestsFromEnv } from '../live/serpApiDiscoveryConfig.mjs'
import { createSerpApiTrendingNowClient } from '../live/serpApiTrendingNow.mjs'
import { resolveShadowTrendsMode } from '../live/shadowHistoryRetrieval.mjs'
import { scoreElapsedTimeShadowLiveCohort } from '../live/shadowScoring.mjs'
import { resolveHistoricalVaultConfig } from '../live/historicalVault.mjs'
import { readHistoricalVaultCoverage } from '../live/historicalVaultReadService.mjs'
import { evaluateCanonicalGrowthPromotion } from '../live/historicalVaultPromotion.mjs'
import { resolveGrowthPresentation } from '../live/trendPresentation.mjs'
import { buildActiveTrackingCohort, DEFAULT_CANONICAL_CONTINUITY_RETENTION_HOURS, DEFAULT_TRACKING_RETENTION_HOURS } from '../live/activeTrackingCohort.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'
import { assessMeasurementTargetCompatibility, resolveLiveMeasurementConfig } from '../live/measurementGeography.mjs'
import { discoveryCachePayload, hydrateLiveDiscoveryCache, isFreshLiveDiscoveryCache, liveDiscoveryCacheKey } from '../live/liveDiscoveryCache.mjs'

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
  if (summary.publication?.publishable === false) {
    const publication = summary.publication
    console.log(`Public snapshot rejected: ${publication.reason}; required ${publication.requiredCount}; available ${publication.availableCount}; horizon ${publication.historyWindow}; cycle ${publication.cycleId}.`)
  }
  if (summary.historyWindow === '24H' && summary.publicFunnel) {
    const funnel = summary.publicFunnel
    console.log(`24H public funnel: discovered ${funnel.discovered}; current discovery eligible ${funnel.currentDiscoveryEligible}; protected fresh discovery ${funnel.protectedFreshDiscovery}; selected paid tracking ${funnel.selectedPaidTracking}; actually measured ${funnel.actuallyMeasured}; measured current discovery ${funnel.measuredCurrentDiscovery}; scorable ${funnel.scorable}; unified ${funnel.unified}; public selected ${funnel.publicSelected}.`)
    if (funnel.currentDiscoveryExclusions.length) console.log(`24H current discovery exclusions: ${funnel.currentDiscoveryExclusions.map(({ query, reason }) => `${query}=${reason}`).join(', ')}.`)
  }
  if (summary.historyWindow !== '24H' && summary.publicFunnel) {
    const funnel = summary.publicFunnel
    console.log(`${summary.historyWindow} public funnel: selected ${funnel.selectedPaidTracking}; current discovery ${funnel.currentDiscoveryEligible}; measured ${funnel.actuallyMeasured}; valid global baseline ${funnel.validGlobalBaseline}; valid global history ${funnel.validGlobalHistory}; current intensity ${funnel.currentIntensityAvailable}; acceleration ${funnel.accelerationAvailable}; momentum ${funnel.momentumAvailable}; consistency ${funnel.consistencyAvailable}; breakout ${funnel.breakoutAvailable}; score calculable ${funnel.scoreCalculable}; unified ${funnel.unifiedEligible}; public selected ${funnel.publicSelected}.`)
    if (Object.keys(funnel.reasonCounts ?? {}).length) console.log(`${summary.historyWindow} public funnel exclusions: ${Object.entries(funnel.reasonCounts).map(([reason, count]) => `${reason}=${count}`).join(', ')}.`)
  }
  const overflow = evaluation.adaptiveOverflow
  if (overflow?.enabled) {
    console.log(`7D adaptive overflow: triggered ${overflow.triggered}; initial measured ${overflow.initialMeasured}; initial valid ${overflow.initialPublicValid}/${overflow.targetPublicValid}; final measured ${overflow.finalMeasured}; final valid ${overflow.finalPublicValid}/${overflow.targetPublicValid}; initial cohort ${evaluation.selectedPaidTrackingCount}; final cohort ${overflow.finalCandidateCount}; maximum ${overflow.maxTotalCandidates}; reserve ${overflow.reserveAvailable}; batches ${overflow.batches.length}; stop ${overflow.stopReason}; incremental requests Search Volume ${overflow.incrementalProviderRequests.dataForSeoSearchVolume}, Trends ${overflow.incrementalProviderRequests.dataForSeoTrends}; incremental cost $${Number(overflow.incrementalProviderCost.total).toFixed(4)}.`)
    for (const [index, batch] of overflow.batches.entries()) console.log(`7D adaptive overflow batch ${index + 1}: candidates ${batch.candidateCount}; measured ${batch.measured}; valid ${batch.publicValid}; baseline requests ${batch.baselineRequests}; Trends requests ${batch.trendsRequests}; incremental cost $${Number(batch.baselineCost + batch.trendsCost).toFixed(4)}; queries ${batch.candidates.join(', ')}.`)
  }
  console.log(`Would write: ${summary.observations} observations; ${summary.vaultMeasurements ?? 0} vault measurements; ${summary.provenances} provenance rows; ${summary.evidence} evidence rows; ${summary.snapshots} snapshot header; ${summary.snapshotEntries} ranked snapshot entries.`)
  if (summary.canonicalArtifacts) {
    console.log(`Canonical attention: eligible ${summary.canonicalAttention?.eligibleCandidates ?? 0}; bootstrapped ${summary.canonicalAttention?.bootstrapped ?? 0}; aligned ${summary.canonicalAttention?.aligned ?? 0}; rejected ${summary.canonicalAttention?.rejected ?? 0}; raw artifacts ${summary.canonicalArtifacts}; new points ${summary.canonicalPoints}.`)
    const reasons = summary.canonicalAttention?.rejectionReasons ?? {}
    if (Object.keys(reasons).length) console.log(`Canonical attention rejections: ${Object.entries(reasons).map(([reason, count]) => `${reason}=${count}`).join(', ')}.`)
  }
  const requests = summary.providerRequests
  const costs = summary.providerCosts
  console.log(`Provider requests: SerpApi ${requests.serpApi}; DataForSEO Search Volume ${requests.dataForSeoSearchVolume}; historical Trends provider ${summary.trendsProvider ?? 'dataforseo-trends'} (${requests.dataForSeoTrends}).`)
  console.log(`Provider-reported cost: Search Volume $${Number(costs.searchVolume).toFixed(4)}; Trends $${Number(costs.trends).toFixed(4)}; total $${Number(costs.total).toFixed(4)}; SerpApi ${costs.serpApi}.`)
  const cache = summary.baselineCache
  if (cache) console.log(`Baseline cache: fresh hits ${cache.freshHits}; stale/missing ${cache.staleOrMissing}; Search Volume keywords requested ${cache.requestedKeywords}; provider requests avoided ${cache.requestsAvoided}; cache rows refreshed ${cache.rowsRefreshed}; cache writes skipped ${cache.writesSkipped}.`)
  const graph = summary.graphMeasurements
  if (graph) {
    console.log(`Trends graph diagnostics: invalid/missing measurements skipped ${graph.invalidOrMissingMeasurements}; affected candidates ${graph.affectedCandidates}.`)
    console.log(`Trends graph value breakdown: total ${graph.totalGraphPoints ?? 0}; positive ${graph.positiveMeasurements ?? 0}; zero ${graph.zeroMeasurements ?? 0}; null ${graph.nullMeasurements ?? 0}; missing value ${graph.missingValueMeasurements ?? 0}; negative ${graph.negativeMeasurements ?? 0}; invalid non-numeric ${graph.invalidNonNumericMeasurements ?? 0}; candidates without usable points ${graph.candidatesWithoutUsablePoints ?? 0}.`)
    for (const candidate of graph.candidateDiagnostics ?? []) {
      console.log(`Trends graph candidate: query=${candidate.canonicalQuery}; target=${candidate.measurementTarget ?? 'none'}; mode=${candidate.measurementMode}; request=${candidate.requestTimeRange ?? 'none'}; task=${candidate.providerTaskStatusCode ?? 'missing'}; graph=${candidate.graphPresent ? 'present' : 'missing'}; values-aligned=${candidate.graphValuesAlignedToRequestedKeywords ? 'yes' : 'no'}; returned-location=${candidate.providerReturnedLocation ?? 'none'}; points=${candidate.graphPointCount}; usable=${candidate.usableCanonicalPoints}; zero=${candidate.zeroMeasurements}; null=${candidate.nullMeasurements}; missing-value=${candidate.missingValueMeasurements}; negative=${candidate.negativeMeasurements}; invalid=${candidate.invalidNonNumericMeasurements}; first=${candidate.firstObservedAt ?? 'none'}; last=${candidate.lastObservedAt ?? 'none'}.`)
    }
  }
  if (summary.tracking) {
    console.log(`Paid measurement cohort: previous Top20 retained ${summary.tracking.previousTop20}; canonical continuity ${summary.tracking.canonicalContinuity}; fresh discoveries ${summary.tracking.freshDiscoveries}; grace-retained ${summary.tracking.graceRetained}; missing-history retries ${summary.tracking.missingHistoryRetries}; deduplicated total ${summary.tracking.deduplicatedTotal} / ${summary.tracking.maxPaidCandidates}; actual Trends requests ${evaluation.actualTrendsRequestCount ?? requests.dataForSeoTrends ?? 0}; tracked absent from discovery ${evaluation.trackedCandidatesAbsentFromCurrentDiscovery ?? 0}; selected but not measured ${evaluation.selectedButNotMeasuredCount ?? 0}.`)
    console.log(`Paid measurement target compatibility: previous Top20 compatible ${summary.tracking.previousTop20Compatible ?? 0}; previous Top20 incompatible rejected ${summary.tracking.previousTop20IncompatibleRejected ?? 0}; canonical continuity compatible ${summary.tracking.canonicalContinuityCompatible ?? 0}; canonical continuity incompatible rejected ${summary.tracking.canonicalContinuityIncompatibleRejected ?? 0}; missing-history retries incompatible rejected ${summary.tracking.missingHistoryRetriesIncompatibleRejected ?? 0}; grace-retained incompatible rejected ${summary.tracking.graceRetainedIncompatibleRejected ?? 0}.`)
  }
  if (summary.vault) {
    console.log(`Vault Growth (${summary.historyWindow}): available ${summary.vault.available}; unavailable ${summary.vault.unavailable}; promotion eligible ${summary.vault.promotionEligible ?? 0}; shadow would-promote ${summary.vault.shadowWouldPromote ?? 0}; preferred promoted ${summary.vault.preferredPromoted ?? 0}; public Growth changed by vault: ${summary.vault.publicChangedByVault}.`)
    const rejections = summary.vault.promotionRejectionReasons ?? {}
    if (Object.keys(rejections).length) console.log(`Vault Growth promotion rejections: ${Object.entries(rejections).map(([reason, count]) => `${reason}=${count}`).join(', ')}.`)
  }
}

function volumeRequest(env, measurement) {
  return { ...measurement.baselineRequest, measurementTarget: measurement.target.targetKey, dateFrom: env.DATAFORSEO_VOLUME_DATE_FROM || undefined, dateTo: env.DATAFORSEO_VOLUME_DATE_TO || undefined }
}

function historyRequest(env, measurement, historyWindow) {
  return { ...measurement.trendsRequest, measurementTarget: measurement.target.targetKey, ...shadowHistoryRequestForWindow(historyWindow) }
}

function volumeClient(env, measurement) {
  return measurement.mode === 'global' ? createDataForSeoGlobalSearchVolumeClient({ env }) : createDataForSeoSearchVolumeClient({ env })
}

function trendsProviderSelection({ env, measurement, historyWindow, dependencies }) {
  const provider = resolveLiveTrendsProvider({ measurementMode: measurement.mode, historyWindow })
  return {
    provider,
    trendsMode: provider.forcedMode ?? liveTrendsMode(env),
    trendsClient: dependencies.trendsClient ?? (provider.transport === 'google-trends'
      ? createDataForSeoGoogleTrendsClient({ env })
      : createDataForSeoTrendsClient({ env })),
    historyRetriever: provider.transport === 'google-trends' ? retrieveGoogleTrendsHistories : null,
  }
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
    const promotion = evaluateCanonicalGrowthPromotion({ window: historyWindow, vaultGrowth, mode: vaultConfig.growthMode })
    if (promotion.eligible) promotionEligible += 1
    if (promotion.wouldPromoteInShadow) shadowWouldPromote += 1
    if (promotion.promotedInPreferred) preferredPromoted += 1
    if (!promotion.eligible) promotionRejectionReasons[promotion.reason] = (promotionRejectionReasons[promotion.reason] ?? 0) + 1
    const nowranksHistoricalGrowthPercent = promotion.promotedInPreferred ? vaultGrowth.growthPercent : null
    const providerHistoricalGrowthPercent = score.presentation?.growthSource === 'provider-history' ? score.presentation.growthPercent : null
    // The global scorer deliberately excludes country discovery magnitude.
    // Preserve that boundary when the vault presentation layer selects a Growth
    // fallback; otherwise an unavailable global Growth could be overwritten by
    // a country-scoped SerpApi percentage after scoring has completed.
    const discoveryIncreasePercentage = score.publicScoringDiagnostics?.discoveryMagnitudeUsedInPublicScore === false
      ? null
      : score.raw?.currentTrendIntensity?.increasePercentage ?? null
    const publicGrowth = resolveGrowthPresentation({ nowranksHistoricalGrowthPercent, providerHistoricalGrowthPercent, discoveryIncreasePercentage })
    if (publicGrowth.growthSource === 'nowranks-history' && score.presentation?.growthSource !== 'nowranks-history') publicChangedByVault += 1
    const absoluteDifference = Number.isFinite(vaultGrowth?.growthPercent) && Number.isFinite(providerHistoricalGrowthPercent)
      ? Math.abs(vaultGrowth.growthPercent - providerHistoricalGrowthPercent) : null
    const relativeDifference = absoluteDifference !== null && providerHistoricalGrowthPercent !== 0
      ? absoluteDifference / Math.abs(providerHistoricalGrowthPercent) : null
    const presentation = {
      ...score.presentation,
      ...publicGrowth,
      growthDiagnostics: {
        value: publicGrowth.growthPercent,
        availability: publicGrowth.growthPercent !== null,
        source: publicGrowth.growthSource,
        saturation: publicGrowth.growthSaturated,
        promotion,
        fallbackReason: publicGrowth.growthSource === 'nowranks-history' ? null : promotion.reason,
      },
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

function artifactMeasurement(artifact) {
  const targeting = artifact?.targeting ?? {}
  return {
    historicalMeasurementMode: targeting.measurementMode ?? 'us',
    historicalMeasurementTarget: targeting.measurementTarget ?? null,
    historicalMeasurementLocation: targeting.measurementLocation ?? null,
  }
}

function artifactCompatibility(artifact, currentMeasurement) {
  const historical = artifactMeasurement(artifact)
  return {
    ...historical,
    ...assessMeasurementTargetCompatibility({
      ...historical,
      currentMeasurementMode: currentMeasurement?.measurementMode ?? null,
      currentMeasurementTarget: currentMeasurement?.measurementTarget ?? null,
      currentMeasurementLocation: currentMeasurement?.measurementLocation ?? null,
    }),
  }
}

export async function loadActiveTrackingState({ repository, now, canonicalContinuityRetentionHours = DEFAULT_CANONICAL_CONTINUITY_RETENTION_HOURS, currentMeasurement = null }) {
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
  }
  const canonicalPoints = repository.listLiveCanonicalAttentionPoints
    ? await repository.listLiveCanonicalAttentionPoints({ candidateIds: [...byCandidate.values()].map((item) => item.candidateId) }) : []
  const canonicalByCandidate = new Map()
  for (const point of canonicalPoints) {
    if (!canonicalByCandidate.has(point.candidate_id)) canonicalByCandidate.set(point.candidate_id, [])
    canonicalByCandidate.get(point.candidate_id).push(point)
  }
  const tracking = [...byCandidate.values()].map((state) => {
    const annotatedArtifacts = state._artifacts.map((artifact) => ({ artifact, compatibility: artifactCompatibility(artifact, currentMeasurement) }))
    const compatibleArtifacts = annotatedArtifacts.filter(({ compatibility }) => compatibility.compatible)
    const relevantArtifacts = currentMeasurement ? compatibleArtifacts : annotatedArtifacts
    const diagnosticArtifact = relevantArtifacts[0] ?? annotatedArtifacts[0] ?? null
    const acceptedArtifact = relevantArtifacts.find(({ artifact }) => artifact.live_canonical_attention_alignments?.some((row) => row.accepted)) ?? null
    const compatibleSeriesKeys = new Set(relevantArtifacts.flatMap(({ artifact }) => (artifact.live_canonical_attention_alignments ?? []).filter((row) => row.accepted && row.series_key).map((row) => row.series_key)))
    let consecutiveMissingHistory = 0
    for (const { artifact } of relevantArtifacts) {
      const curve = artifact.raw_curve ?? []
      const allMissing = curve.length > 0 && curve.every((point) => point.availability === 'missing' || point.value === null)
      if (!allMissing) break
      consecutiveMissingHistory += 1
    }
    const allPoints = canonicalByCandidate.get(state.candidateId) ?? []
    const points = currentMeasurement
      ? allPoints.filter((point) => compatibleSeriesKeys.has(point.series_key))
      : allPoints
    const latestPoint = [...points].sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0] ?? null
    const { _artifacts, ...row } = state
    return {
      ...row,
      lastPaidAt: (relevantArtifacts[0] ?? annotatedArtifacts[0])?.artifact.slot_at ?? row.lastPaidAt,
      lastCanonicalSuccessAt: acceptedArtifact?.artifact.slot_at ?? null,
      recentAcceptedAlignmentConfidence: acceptedArtifact?.artifact.live_canonical_attention_alignments?.find((alignment) => alignment.accepted)?.confidence ?? null,
      historicalMeasurementMode: diagnosticArtifact?.compatibility.historicalMeasurementMode ?? 'us',
      historicalMeasurementTarget: diagnosticArtifact?.compatibility.historicalMeasurementTarget ?? null,
      historicalMeasurementLocation: diagnosticArtifact?.compatibility.historicalMeasurementLocation ?? null,
      measurementCompatible: diagnosticArtifact?.compatibility.compatible ?? false,
      consecutiveMissingHistory,
      canonicalPointCount: points.length,
      canonicalSegment: latestPoint?.segment_id ?? acceptedArtifact?.artifact.live_canonical_attention_alignments?.find((alignment) => alignment.accepted)?.segment_id ?? row.canonicalSegment ?? null,
      latestCanonicalPointAt: latestPoint?.observed_at ?? null,
    }
  })
  let latestPublic = []
  if (repository.getLatestUnifiedLiveSnapshot && repository.listLiveSnapshotEntries) {
    const snapshot = await repository.getLatestUnifiedLiveSnapshot({ selectedWindow: '24H' })
    if (snapshot) {
      const trackingByQuery = new Map(tracking.map((item) => [item.normalizedQuery, item]))
      latestPublic = (await repository.listLiveSnapshotEntries({ snapshotId: snapshot.snapshot_id })).map((entry) => {
        const normalizedQuery = entry.candidates?.normalized_query
        const tracked = trackingByQuery.get(normalizedQuery)
        return {
          candidateId: entry.candidate_id, query: entry.candidates?.query_text, normalizedQuery, category: entry.candidates?.category, publicRank: entry.public_rank,
          // Snapshot headers have no measurement-target column. Use the matching
          // canonical artifact when available; older unannotated rows are safely
          // identified as the explicit legacy-US system, never as global.
          historicalMeasurementMode: tracked?.historicalMeasurementMode ?? 'us',
          historicalMeasurementTarget: tracked?.historicalMeasurementTarget ?? null,
          historicalMeasurementLocation: tracked?.historicalMeasurementLocation ?? null,
        }
      })
    }
  }
  return { latestPublic, tracking }
}

export async function prepareLiveSchedulerShared({ env = process.env, dependencies = {}, forceFreshDiscovery = false, discoveryFreshnessHours = 24, baselineRefreshHours = 24 } = {}) {
  const safety = resolveLiveIngestionSafetyConfig(env)
  if (!safety.dryRun) assertLiveDatabaseWriteAllowed(env)
  const repository = dependencies.repository ?? createSupabaseIngestionRepository(createServerSupabaseClient(env))
  const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(env)
  const measurement = resolveLiveMeasurementConfig(env)
  const discoveryRequests = buildSerpApiDiscoveryRequestsFromEnv(env)
  const baselineRequest = volumeRequest(env, measurement)
  const cacheKey = liveDiscoveryCacheKey({ discoveryRequests, measurementTarget: measurement.target.targetKey })
  const stored = repository.getLiveDailyDiscoveryCache ? await repository.getLiveDailyDiscoveryCache({ cacheKey }) : null
  const freshStored = stored && isFreshLiveDiscoveryCache(stored, { freshnessHours: discoveryFreshnessHours }) ? stored : null
  const collect = async (cachedDiscovery = null) => collectLiveSharedInputs({
    discoveryLimit: safety.discoveryLimit, maxPaidCandidates: safety.maxPaidCandidates, adaptiveOverflowMaxCandidates: safety.adaptive7dMaxCandidates,
    // A scheduler daily refresh warms the whole bounded 7D universe in one
    // baseline bulk request, so later overflow batches never multiply it.
    baselineCandidateLimit: safety.adaptive7dMaxCandidates,
    discoveryRequest, discoveryRequests, cachedDiscovery, volumeRequest: baselineRequest,
    discoveryClient: dependencies.discoveryClient ?? createSerpApiTrendingNowClient({ env }), volumeClient: dependencies.volumeClient ?? volumeClient(env, measurement),
    baselineCacheRepository: repository, baselineCacheTtlHours: baselineRefreshHours, writeBaselineCache: !safety.dryRun,
    onProgress: (stage) => console.log(`NowRanks live scheduler shared stage: ${stage}`),
  })
  let sharedInputs; let cacheStatus
  if (freshStored && !forceFreshDiscovery) {
    sharedInputs = await collect(hydrateLiveDiscoveryCache(freshStored)); cacheStatus = 'reused-fresh'
  } else {
    try {
      sharedInputs = await collect()
      cacheStatus = 'refreshed'
      if (!safety.dryRun && repository.upsertLiveDailyDiscoveryCache) await repository.upsertLiveDailyDiscoveryCache({ cache_key: cacheKey, ...discoveryCachePayload(sharedInputs), discovered_at: new Date().toISOString() })
    } catch (error) {
      if (!freshStored) throw error
      sharedInputs = await collect(hydrateLiveDiscoveryCache(freshStored)); cacheStatus = 'reused-after-refresh-failure'
    }
  }
  sharedInputs.sharedMetrics.discoveryCache = { status: cacheStatus, cacheKey, freshnessHours: discoveryFreshnessHours, discoveredAt: freshStored?.discovered_at ?? new Date().toISOString() }
  return { sharedInputs, repository }
}

export async function runLiveIngestion({ env = process.env, dependencies = {} } = {}) {
  const safety = resolveLiveIngestionSafetyConfig(env)
  if (!safety.dryRun) assertLiveDatabaseWriteAllowed(env)
  const historyWindow = liveHistoryWindow(env)
  const repository = dependencies.repository ?? createSupabaseIngestionRepository(createServerSupabaseClient(env))
  const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(env)
  const discoveryRequests = buildSerpApiDiscoveryRequestsFromEnv(env)
  const measurement = resolveLiveMeasurementConfig(env)
  const trends = trendsProviderSelection({ env, measurement, historyWindow, dependencies })
  const trendsMode = trends.trendsMode
  const baselineRequest = volumeRequest(env, measurement)
  const baselineClient = dependencies.volumeClient ?? volumeClient(env, measurement)
  const maximumTrendCandidates = historyWindow === '7D' ? safety.adaptive7dMaxCandidates : safety.maxPaidCandidates
  // Google Trends Explore accepts five keywords per task even though its internal
  // curve semantics require candidate-local scoring after response mapping.
  const plannedTrendRequests = trends.provider.transport === 'google-trends'
    ? Math.ceil(maximumTrendCandidates / 5)
    : trendsMode === 'single' ? maximumTrendCandidates : Math.ceil(maximumTrendCandidates / 5)
  console.log('NowRanks live ingestion')
  console.log(safety.dryRun ? 'LIVE EXTERNAL DATA — DRY RUN — NOT PERSISTED' : 'LIVE EXTERNAL DATA — DATABASE WRITE EXPLICITLY ENABLED')
  console.log(`Planned maximum: discovery pool ${safety.discoveryLimit}; baseline cohort ${safety.maxPaidCandidates}; initial Trends cohort ${safety.initialPaidCandidates}; 7D adaptive maximum ${safety.adaptive7dMaxCandidates}; display up to ${safety.displayLimit} ranked topics; SerpApi ${discoveryRequests.length} request(s); ${trends.provider.id} up to ${plannedTrendRequests} requests.`)

  const sharedInputs = dependencies.sharedInputs ?? await collectLiveSharedInputs({
    discoveryLimit: safety.discoveryLimit, maxPaidCandidates: safety.maxPaidCandidates, adaptiveOverflowMaxCandidates: safety.adaptive7dMaxCandidates, discoveryRequest, discoveryRequests, volumeRequest: baselineRequest,
    discoveryClient: dependencies.discoveryClient ?? createSerpApiTrendingNowClient({ env }), volumeClient: baselineClient,
    baselineCacheRepository: repository, baselineCacheTtlHours: Number(env.LIVE_BASELINE_TTL_HOURS || 24), writeBaselineCache: !safety.dryRun,
    onProgress: (stage) => console.log(`NowRanks live ingestion stage: ${stage}`),
  })
  const vaultConfig = resolveHistoricalVaultConfig(env)
  const trackingState = vaultConfig.enabled && vaultConfig.growthMode !== 'off'
    ? await loadActiveTrackingState({ repository, now: new Date().toISOString(), currentMeasurement: measurement.canonicalTargeting }) : { latestPublic: [], tracking: [] }
  const trackingCohort = buildActiveTrackingCohort({ discoveries: sharedInputs.candidates, ...trackingState, maxPaidCandidates: safety.maxPaidCandidates, currentMeasurement: measurement.canonicalTargeting })
  const cycle = await collectLiveIngestionCycle({
    discoveryLimit: safety.discoveryLimit,
    maxPaidCandidates: safety.maxPaidCandidates,
    initialPaidCandidates: safety.initialPaidCandidates,
    displayLimit: safety.displayLimit,
    discoveryRequest,
    volumeRequest: baselineRequest,
    historyRequest: historyRequest(env, measurement, historyWindow),
    historyWindow,
    trendsMode,
    discoveryClient: dependencies.discoveryClient ?? createSerpApiTrendingNowClient({ env }),
    volumeClient: baselineClient,
    trendsClient: trends.trendsClient,
    historyRetriever: trends.historyRetriever,
    trendProviderId: trends.provider.id,
    // A dry run must remain usable before the cache migration exists: it neither
    // reads nor writes the persistent Trends cache.
    trendsCacheRepository: safety.dryRun ? null : repository,
    trendsRefreshMinutes: Number(env.LIVE_GOOGLE_TRENDS_REFRESH_MINUTES || 480),
    writeTrendsCache: !safety.dryRun,
    scoreCycle: dependencies.scoreCycle ?? ((args) => withExistingScoringEngine(({ signalEngine, scoreWeights }) => scoreElapsedTimeShadowLiveCohort({ ...args, signalEngine, scoreWeights }))),
    baselineCacheRepository: repository,
    baselineCacheTtlHours: Number(env.LIVE_BASELINE_TTL_HOURS || 24),
    writeBaselineCache: !safety.dryRun,
    adaptiveOverflowMaxCandidates: safety.adaptive7dMaxCandidates,
    overflowBaselineResolver: (candidates) => {
      const available = new Map(sharedInputs.volumes.map((record) => [record.normalizedQuery, record]))
      const unresolved = candidates.filter((candidate) => !available.has(candidate.normalizedQuery))
      if (!unresolved.length) return Promise.resolve({ volumes: candidates.map((candidate) => available.get(candidate.normalizedQuery)), metrics: { providerRequests: 0, providerCost: 0, cache: { freshHits: candidates.length, writesSkipped: safety.dryRun } } })
      return collectLiveBaselineInputs({ candidates: unresolved, volumeRequest: baselineRequest, volumeClient: baselineClient, baselineCacheRepository: repository, baselineCacheTtlHours: Number(env.LIVE_BASELINE_TTL_HOURS || 24), writeBaselineCache: !safety.dryRun })
    },
    sharedInputs,
    paidTrackingCandidates: trackingCohort.candidates,
    trackingDiagnostics: trackingCohort.diagnostics,
    onProgress: (stage) => console.log(`NowRanks live ingestion stage: ${stage}`),
  })
  cycle.requestMetrics.tracking = { ...trackingCohort.diagnostics, ...cycle.requestMetrics.evaluation }
  const canonicalExistingByQuery = await loadCanonicalExisting({ cycle, repository, enabled: vaultConfig.enabled && vaultConfig.growthMode !== 'off' && historyWindow === '24H' })
  const vaultAwareCycle = await attachVaultGrowth({ cycle, repository, historyWindow, vaultConfig })
  const plan = buildLivePersistencePlan({ cycleId: safety.cycleId, historyWindow, displayLimit: safety.displayLimit, vaultConfig, vaultDiscoveryRequest: sharedInputs.discoveryRequest, canonicalExistingByQuery, canonicalTargeting: measurement.canonicalTargeting, discoveryCandidates: sharedInputs.discoveryCandidates ?? sharedInputs.candidates, paidTrackingDiagnostics: vaultAwareCycle.requestMetrics.tracking, ...vaultAwareCycle })
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
