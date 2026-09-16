import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { buildDataForSeoAuthorization, requireDataForSeoCredentials } from './dataForSeoAuth.mjs'
import { LiveProviderError } from './providerAdapter.mjs'
import { mapDataForSeoGraphKeywordColumns, normalizeDataForSeoProviderEchoKeyword } from './providerKeywordIdentity.mjs'

export { requireDataForSeoCredentials } from './dataForSeoAuth.mjs'

export const DATAFORSEO_TRENDS_EXPLORE_LIVE_ENDPOINT = 'https://api.dataforseo.com/v3/keywords_data/dataforseo_trends/explore/live'
export const DATAFORSEO_MAX_KEYWORDS = 5
export const DATAFORSEO_TRENDS_TIME_RANGES = Object.freeze([
  'past_4_hours', 'past_day', 'past_7_days', 'past_30_days', 'past_90_days', 'past_12_months', 'past_5_years',
])

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function isoDate(value, label) {
  const date = text(value, label)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) throw new Error(`${label} must be YYYY-MM-DD`)
  return date
}

function unixTimestamp(value, label) {
  if (!Number.isFinite(value)) throw new Error(`DataForSEO ${label} must be a Unix timestamp`)
  return new Date(value * 1000).toISOString()
}

export function buildDataForSeoExploreTask({ keywords, locationName, locationCode, dateFrom, dateTo, timeRange, type, measurementMode }) {
  if (!Array.isArray(keywords) || keywords.length === 0 || keywords.length > DATAFORSEO_MAX_KEYWORDS) throw new Error(`DataForSEO requires one to ${DATAFORSEO_MAX_KEYWORDS} keywords per request`)
  const normalizedKeywords = keywords.map((keyword) => text(keyword, 'DataForSEO keyword'))
  const global = measurementMode === 'global'
  if (measurementMode !== undefined && !['global', 'us'].includes(measurementMode)) throw new Error('DataForSEO measurementMode must be global or us')
  if (global) {
    if (locationName !== undefined || locationCode !== undefined) throw new Error('Global DataForSEO Trends measurement must omit location fields')
  } else if ((locationName === undefined) === (locationCode === undefined)) throw new Error('DataForSEO requires exactly one explicit locationName or locationCode')
  const task = { keywords: normalizedKeywords }
  if (locationName !== undefined) task.location_name = text(locationName, 'DataForSEO locationName')
  if (locationCode !== undefined) {
    if (!Number.isInteger(locationCode) || locationCode < 1) throw new Error('DataForSEO locationCode must be a positive integer')
    task.location_code = locationCode
  }
  if (dateFrom !== undefined) task.date_from = isoDate(dateFrom, 'DataForSEO dateFrom')
  if (dateTo !== undefined) task.date_to = isoDate(dateTo, 'DataForSEO dateTo')
  if (timeRange !== undefined) {
    if (dateFrom !== undefined || dateTo !== undefined) throw new Error('DataForSEO timeRange cannot be combined with dateFrom or dateTo')
    const value = text(timeRange, 'DataForSEO timeRange')
    if (!DATAFORSEO_TRENDS_TIME_RANGES.includes(value)) throw new Error('DataForSEO timeRange is unsupported')
    task.time_range = value
  }
  if (type !== undefined) task.type = text(type, 'DataForSEO type')
  return task
}

function graphFromResponse(response) {
  if (!response || response.status_code !== 20000 || !Array.isArray(response.tasks) || response.tasks.length !== 1) throw new Error('DataForSEO response must contain one successful task')
  const task = response.tasks[0]
  if (task.status_code !== 20000) throw new Error('DataForSEO task failed')
  if (!Array.isArray(task.result) || task.result.length !== 1) throw new Error('DataForSEO task must contain exactly one result object')
  const result = task.result[0]
  if (!result || typeof result !== 'object') throw new Error('DataForSEO task result must be an object')
  if (!Array.isArray(result.items)) throw new Error('DataForSEO task result must contain an items array')
  const graph = result.items.find((item) => item?.type === 'dataforseo_trends_graph')
  if (!graph) throw new Error('DataForSEO response is structurally valid but contains no dataforseo_trends_graph item')
  if (!Array.isArray(graph.keywords) || !Array.isArray(graph.data)) throw new Error('DataForSEO trends graph must contain keywords and data arrays')
  return graph
}

function returnedTargeting(response) {
  const result = response?.tasks?.[0]?.result?.[0]
  return { providerReturnedLocation: result?.location_code ?? null, providerReturnedLanguage: result?.language_code ?? null }
}

function responseFailure({ httpStatus, body, graphIssue = null }) {
  const task = Array.isArray(body?.tasks) ? body.tasks[0] : null
  const error = new Error('DataForSEO Trends returned an unsuccessful or malformed response')
  error.status = httpStatus
  error.code = body?.status_code ?? 'missing'
  error.details = `top-level status_code=${body?.status_code ?? 'missing'} status_message=${body?.status_message ?? 'missing'}; task status_code=${task?.status_code ?? 'missing'} status_message=${task?.status_message ?? 'missing'}; result=${Array.isArray(task?.result) ? 'array' : 'missing-or-malformed'}; trends_graph=${graphIssue ?? 'present'}`
  return error
}

function hasSuccessfulTask(body) {
  return body?.status_code === 20000 && Array.isArray(body.tasks) && body.tasks.length === 1 && body.tasks[0]?.status_code === 20000 && Array.isArray(body.tasks[0]?.result)
}

const GRAPH_DIAGNOSTIC_COUNTERS = Object.freeze([
  'totalGraphPoints',
  'positiveMeasurements',
  'zeroMeasurements',
  'nullMeasurements',
  'missingValueMeasurements',
  'negativeMeasurements',
  'invalidNonNumericMeasurements',
  'invalidOrMissingMeasurements',
  'affectedCandidates',
  'candidatesWithoutUsablePoints',
])

/** Safe, response-derived diagnostics only. These records never alter provider measurements. */
export function createDataForSeoGraphDiagnostics() {
  return {
    totalGraphPoints: 0,
    positiveMeasurements: 0,
    zeroMeasurements: 0,
    nullMeasurements: 0,
    missingValueMeasurements: 0,
    negativeMeasurements: 0,
    invalidNonNumericMeasurements: 0,
    invalidOrMissingMeasurements: 0,
    affectedCandidates: 0,
    candidatesWithoutUsablePoints: 0,
    candidateDiagnostics: [],
  }
}

/** Combines distinct request-group diagnostics without changing the source observations. */
export function mergeDataForSeoGraphDiagnostics(target, source) {
  for (const counter of GRAPH_DIAGNOSTIC_COUNTERS) target[counter] += source[counter] ?? 0
  target.candidateDiagnostics.push(...(source.candidateDiagnostics ?? []))
  return target
}

function candidateGraphDiagnostics({ candidate, graph, requestMetadata, response }) {
  const firstPoint = graph.data[0]
  const lastPoint = graph.data.at(-1)
  const task = response?.tasks?.[0]
  const returned = returnedTargeting(response)
  return {
    canonicalQuery: candidate.query,
    normalizedQuery: candidate.normalizedQuery,
    measurementMode: requestMetadata?.measurementMode ?? 'us',
    measurementTarget: requestMetadata?.measurementTarget ?? null,
    requestTimeRange: requestMetadata?.time_range ?? null,
    providerTaskStatusCode: task?.status_code ?? null,
    providerTaskStatusMessage: task?.status_message ?? null,
    providerReturnedLocation: returned.providerReturnedLocation,
    providerReturnedLanguage: returned.providerReturnedLanguage,
    graphPresent: true,
    graphValuesAlignedToRequestedKeywords: true,
    graphPointCount: graph.data.length,
    firstObservedAt: firstPoint ? unixTimestamp(firstPoint.timestamp, 'graph timestamp') : null,
    lastObservedAt: lastPoint ? unixTimestamp(lastPoint.timestamp, 'graph timestamp') : null,
    positiveMeasurements: 0,
    zeroMeasurements: 0,
    nullMeasurements: 0,
    missingValueMeasurements: 0,
    negativeMeasurements: 0,
    invalidNonNumericMeasurements: 0,
    usableCanonicalPoints: 0,
  }
}

/**
 * Converts one DataForSEO batch through the existing live adapter. Documented zero values mean
 * insufficient data, so they are represented as explicit missing observations, never invented zero interest.
 */
function normalizedGraphMeasurement(measurement, diagnostics, candidateDiagnostics) {
  // DataForSEO graph values are numeric in the transport contract. Do not coerce numeric-looking
  // strings: doing so would silently broaden that contract and could hide provider corruption.
  diagnostics.totalGraphPoints += 1
  if (Number.isFinite(measurement) && measurement > 0) {
    diagnostics.positiveMeasurements += 1
    candidateDiagnostics.positiveMeasurements += 1
    candidateDiagnostics.usableCanonicalPoints += 1
    return { measurement }
  }
  if (measurement === 0) {
    diagnostics.zeroMeasurements += 1
    candidateDiagnostics.zeroMeasurements += 1
    return { measurement: null, missingReason: 'out-of-range' }
  }
  const counter = measurement === null
    ? 'nullMeasurements'
    : measurement === undefined
      ? 'missingValueMeasurements'
      : typeof measurement === 'number' && measurement < 0
        ? 'negativeMeasurements'
        : 'invalidNonNumericMeasurements'
  diagnostics[counter] += 1
  candidateDiagnostics[counter] += 1
  diagnostics.invalidOrMissingMeasurements += 1
  diagnostics.affectedCandidateQueries.add(candidateDiagnostics.normalizedQuery)
  return { measurement: null, missingReason: 'invalid-provider-measurement' }
}

/**
 * Normalizes an otherwise valid provider graph while degrading invalid individual cells to
 * explicit missing observations. Structural graph faults still throw; a bad cell never becomes 0.
 */
export function normalizeDataForSeoMeasurementWithDiagnostics({ response, candidates, geographicScope, retrievedAt, adapter, requestMetadata }) {
  if (!adapter?.normalize) throw new Error('A live provider adapter is required')
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > DATAFORSEO_MAX_KEYWORDS) throw new Error(`DataForSEO normalization requires one to ${DATAFORSEO_MAX_KEYWORDS} candidates`)
  const graph = graphFromResponse(response)
  const keywordMapping = mapDataForSeoGraphKeywordColumns({
    requestedKeywords: candidates.map((candidate) => candidate.query),
    returnedKeywords: graph.keywords,
    normalizeKeyword: normalizeDataForSeoProviderEchoKeyword,
    providerLabel: 'DataForSEO Trends',
  })
  const diagnostics = createDataForSeoGraphDiagnostics()
  const internalDiagnostics = { ...diagnostics, affectedCandidateQueries: new Set() }
  const candidateDiagnosticsByIndex = candidates.map((candidate) => candidateGraphDiagnostics({ candidate, graph, requestMetadata, response }))
  const topics = candidates.map((candidate, index) => ({
    sourceId: candidate.sourceId ?? candidate.normalizedQuery,
    query: candidate.query,
    normalizedQuery: candidate.normalizedQuery,
    category: candidate.category,
    observations: graph.data.map((point) => {
      if (!Array.isArray(point?.values) || point.values.length !== graph.keywords.length) throw new Error('DataForSEO Trends graph values do not match returned keywords')
      const returnedKeywordIndex = keywordMapping.returnedIndexByRequestIndex[index]
      const measurement = point.values[returnedKeywordIndex]
      const observedAt = unixTimestamp(point?.timestamp, 'graph timestamp')
      return { observedAt, ...normalizedGraphMeasurement(measurement, internalDiagnostics, candidateDiagnosticsByIndex[index]) }
    }),
  }))
  const normalized = adapter.normalize({
    sourceObservedAt: retrievedAt,
    geographicScope,
    sourceVersion: 'dataforseo-trends-v3',
    collectionMethod: 'dataforseo-trends-explore-live',
    // Shadow scoring consumes only each topic's temporal shape; raw levels never establish global scale.
    crossQueryComparability: {
      status: 'comparable',
      basis: candidates.length === 1
        ? 'DataForSEO relative scale within one single-keyword request'
        : `DataForSEO relative scale within one ${candidates.length}-keyword request only`,
    },
    topics,
  }, { retrievedAt })
  const providerTargeting = returnedTargeting(response)
  const histories = normalized.map((topic) => ({
    ...topic,
    measurementProvenance: {
      measurementMode: requestMetadata?.measurementMode ?? 'us', measurementTarget: requestMetadata?.measurementTarget ?? null,
      measurementLocation: geographicScope, measurementLanguage: providerTargeting.providerReturnedLanguage,
      ...providerTargeting,
    },
    historyRequest: requestMetadata ? {
      timeRange: requestMetadata.time_range ?? null,
      dateFrom: requestMetadata.date_from ?? null,
      dateTo: requestMetadata.date_to ?? null,
      measurementMode: requestMetadata.measurementMode ?? 'us',
      measurementTarget: requestMetadata.measurementTarget ?? null,
    } : null,
    retrievedAt,
    observations: topic.observations.map((observation, pointIndex) => {
      const providerPoint = graph.data[pointIndex]
      return {
        ...observation,
        ...(typeof providerPoint?.date_from === 'string' ? { providerBucketStart: providerPoint.date_from } : {}),
        ...(typeof providerPoint?.date_to === 'string' ? { providerBucketEnd: providerPoint.date_to } : {}),
      }
    }),
  }))
  internalDiagnostics.affectedCandidates = internalDiagnostics.affectedCandidateQueries.size
  internalDiagnostics.candidatesWithoutUsablePoints = candidateDiagnosticsByIndex.filter((candidate) => candidate.usableCanonicalPoints === 0).length
  internalDiagnostics.candidateDiagnostics = candidateDiagnosticsByIndex
  const { affectedCandidateQueries: _affectedCandidateQueries, ...publicDiagnostics } = internalDiagnostics
  return { histories, diagnostics: publicDiagnostics }
}

/** Backwards-compatible history-only normalizer for standalone callers. */
export function normalizeDataForSeoMeasurement(args) {
  return normalizeDataForSeoMeasurementWithDiagnostics(args).histories
}

export function createDataForSeoTrendsClient({ env = process.env, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  return {
    async measure(request) {
      const { login, password } = requireDataForSeoCredentials(env)
      const task = buildDataForSeoExploreTask(request)
      const authorization = buildDataForSeoAuthorization({ login, password })
      try {
        const response = await fetchImpl(DATAFORSEO_TRENDS_EXPLORE_LIVE_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify([task]) })
        const body = await response.json()
        if (!response.ok || !hasSuccessfulTask(body)) throw responseFailure({ httpStatus: response.status, body })
        try { graphFromResponse(body) } catch (error) { throw responseFailure({ httpStatus: response.status, body, graphIssue: formatErrorDiagnostics(error) }) }
        return { response: body, retrievedAt: now(), task }
      } catch (error) {
        throw new LiveProviderError('dataforseo-trends', { message: formatErrorDiagnostics(error) })
      }
    },
  }
}
