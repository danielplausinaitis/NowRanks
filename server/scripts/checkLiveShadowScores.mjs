import { withExistingScoringEngine } from '../application/viteLeaderboardEngine.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { createDataForSeoSearchVolumeClient, normalizeDataForSeoSearchVolume } from '../live/dataForSeoSearchVolume.mjs'
import { createDataForSeoTrendsClient } from '../live/dataForSeoTrends.mjs'
import { createLiveTrendProviderAdapter } from '../live/providerAdapter.mjs'
import { resolveShadowHistoryWindow, shadowHistoryRequestForWindow } from '../live/elapsedShadowHistory.mjs'
import { providerReportedCost, resolveShadowTrendsMode, retrieveShadowTrendHistories } from '../live/shadowHistoryRetrieval.mjs'
import { scoreElapsedTimeShadowLiveCohort } from '../live/shadowScoring.mjs'
import { buildSerpApiDiscoveryRequestFromEnv } from '../live/serpApiDiscoveryConfig.mjs'
import { createSerpApiTrendingNowClient } from '../live/serpApiTrendingNow.mjs'

function optionalInteger(value, name) {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`)
  return number
}

function locationRequest() {
  return {
    locationCode: optionalInteger(process.env.DATAFORSEO_LOCATION_CODE, 'DATAFORSEO_LOCATION_CODE'),
    locationName: process.env.DATAFORSEO_LOCATION_NAME || undefined,
  }
}

function display(value) {
  return value === null || value === undefined ? 'N/A' : Number.isFinite(value) ? Number(value.toFixed(2)) : value
}

function componentFailureSummary(entry) {
  return Object.entries(entry.componentDiagnostics)
    .filter(([, diagnostic]) => diagnostic.status === 'unavailable')
    .map(([component, diagnostic]) => `${component}: ${diagnostic.reason}`)
    .join('; ') || 'none'
}

async function main() {
  try {
    const limit = optionalInteger(process.env.LIVE_SHADOW_CANDIDATE_LIMIT, 'LIVE_SHADOW_CANDIDATE_LIMIT') ?? 10
    if (limit < 2 || limit > 20) throw new Error('LIVE_SHADOW_CANDIDATE_LIMIT must be between 2 and 20')
    const trendsMode = resolveShadowTrendsMode(process.env)
    const historyWindow = resolveShadowHistoryWindow(process.env)
    const discoveryRequest = buildSerpApiDiscoveryRequestFromEnv(process.env)
    const geographicScope = discoveryRequest.geographicScope
    const discovery = await createSerpApiTrendingNowClient().discover(discoveryRequest)
    const candidates = discovery.filter((candidate) => candidate.category && Number.isFinite(candidate.searchVolume)).slice(0, limit)
    if (candidates.length < 2) throw new Error('SerpApi discovery returned fewer than two candidates with mapped categories and current search volume')
    const keywords = candidates.map((candidate) => candidate.query)

    const volumeResult = await createDataForSeoSearchVolumeClient().lookup({
      keywords,
      ...locationRequest(),
      languageCode: process.env.DATAFORSEO_LANGUAGE_CODE || undefined,
      languageName: process.env.DATAFORSEO_LANGUAGE_NAME || undefined,
      dateFrom: process.env.DATAFORSEO_VOLUME_DATE_FROM || undefined,
      dateTo: process.env.DATAFORSEO_VOLUME_DATE_TO || undefined,
    })
    const volumes = normalizeDataForSeoSearchVolume({ response: volumeResult.response, retrievedAt: volumeResult.retrievedAt, geographicScope })
    const volumeByQuery = new Map(volumes.map((record) => [record.normalizedQuery, record]))

    const trendResult = await retrieveShadowTrendHistories({
      candidates,
      mode: trendsMode,
      client: createDataForSeoTrendsClient(),
      request: {
        ...locationRequest(),
        ...shadowHistoryRequestForWindow(historyWindow),
      },
      geographicScope,
      adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' }),
    })
    const historyByQuery = new Map(trendResult.histories.map((record) => [record.normalizedQuery, record]))
    const inputs = candidates.map((candidate) => ({
      topic: candidate.query,
      normalizedQuery: candidate.normalizedQuery,
      category: candidate.category,
      currentTrendIntensity: candidate,
      baselineDemand: volumeByQuery.get(candidate.normalizedQuery) ?? null,
      historicalTrendShape: historyByQuery.get(candidate.normalizedQuery) ?? null,
    }))
    const scores = await withExistingScoringEngine(({ signalEngine, scoreWeights }) => scoreElapsedTimeShadowLiveCohort({
      candidates: inputs, signalEngine, scoreWeights, historyWindow,
      coldStartMaxAgeHours: discoveryRequest.hours ?? 24,
    }))
    const volumeCost = providerReportedCost(volumeResult.response)
    const trendsCost = trendResult.providerCost
    const totalCost = volumeCost + trendsCost
    const fullConfidence = scores.filter((entry) => entry.confidence === 'full').length
    const partialHigh = scores.filter((entry) => entry.confidence === 'partial-high').length
    const partialLow = scores.filter((entry) => entry.confidence === 'partial-low').length
    const emerging = scores.filter((entry) => entry.confidence === 'emerging').length
    const insufficient = scores.filter((entry) => entry.confidence === 'insufficient').length
    const scored = fullConfidence + partialHigh + partialLow
    const completionPercentage = scores.length === 0 ? 0 : scored / scores.length * 100
    console.log('NowRanks live shadow scoring check')
    console.log('LIVE EXTERNAL DATA — SHADOW SCORE — NOT PERSISTED')
    console.log(`History mode: ${trendsMode}; requested window: ${historyWindow}; candidates attempted: ${scores.length}; established scored: ${scored}; full: ${fullConfidence}; partial-high: ${partialHigh}; partial-low: ${partialLow}; emerging: ${emerging}; insufficient: ${insufficient}; established completion: ${completionPercentage.toFixed(1)}%.`)
    console.log(`Requests: SerpApi 1; DataForSEO Search Volume 1; DataForSEO Trends ${trendResult.requestCount}; SerpApi cost: plan-dependent.`)
    console.log(`DataForSEO provider-reported cost: Search Volume $${volumeCost.toFixed(4)}; Trends $${trendsCost.toFixed(4)}; total $${totalCost.toFixed(4)}.`)
    console.table(scores.map((entry) => ({
      rank: entry.shadowRank,
      emergingRank: entry.shadowEmergingRank,
      topic: entry.topic,
      category: entry.category,
      serpVolume: entry.raw.currentTrendIntensity?.searchVolume ?? null,
      serpIncreasePct: entry.raw.currentTrendIntensity?.increasePercentage ?? null,
      baselineVolume: entry.raw.baselineDemand?.searchVolume ?? null,
      currentIntensity: display(entry.normalized.currentTrendIntensity),
      baselineDemand: display(entry.normalized.baselineDemand),
      historyObservations: entry.history.observationCount,
      historyAvailable: entry.history.availableCount,
      historyMissing: entry.history.missingCount,
      historyCoveragePct: display(entry.history.coveragePercentage),
      historyFirst: entry.history.firstTimestamp,
      historyLast: entry.history.lastTimestamp,
      medianIntervalHours: display(entry.history.medianIntervalHours),
      detectedResolution: entry.history.detectedResolution,
      historyLargeGaps: entry.history.largeGapCount,
      unavailableReasons: componentFailureSummary(entry),
      confidence: entry.confidence,
      confidenceReason: entry.confidenceReason,
      overallAvailableWeightPct: display(entry.availableComponentWeight.overall === null ? null : entry.availableComponentWeight.overall * 100),
      trendingAvailableWeightPct: display(entry.availableComponentWeight.trending === null ? null : entry.availableComponentWeight.trending * 100),
      missingComponents: entry.missingComponents.join(', ') || 'none',
      scoreCompleteness: entry.scoreCompleteness,
      coldStartStatus: entry.coldStart?.classification ?? 'none',
      topicClassification: entry.topicClassification,
      searchInterest: display(entry.components.searchInterest),
      growth: display(entry.components.growth),
      momentum: display(entry.components.momentum),
      consistency: display(entry.components.consistency),
      breakout: display(entry.components.breakout),
      overall: display(entry.shadowOverallScore),
      trending: display(entry.shadowTrendingScore),
      emergingTrending: display(entry.shadowEmergingTrendingScore),
      status: entry.status,
    })))
  } catch (error) {
    console.error(`NowRanks live shadow scoring check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}
void main()
