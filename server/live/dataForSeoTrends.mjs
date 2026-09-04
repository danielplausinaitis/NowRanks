import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { buildDataForSeoAuthorization, requireDataForSeoCredentials } from './dataForSeoAuth.mjs'
import { LiveProviderError } from './providerAdapter.mjs'

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

export function buildDataForSeoExploreTask({ keywords, locationName, locationCode, dateFrom, dateTo, timeRange, type }) {
  if (!Array.isArray(keywords) || keywords.length === 0 || keywords.length > DATAFORSEO_MAX_KEYWORDS) throw new Error(`DataForSEO requires one to ${DATAFORSEO_MAX_KEYWORDS} keywords per request`)
  const normalizedKeywords = keywords.map((keyword) => text(keyword, 'DataForSEO keyword'))
  if ((locationName === undefined) === (locationCode === undefined)) throw new Error('DataForSEO requires exactly one explicit locationName or locationCode')
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

/**
 * Converts one DataForSEO batch through the existing live adapter. Documented zero values mean
 * insufficient data, so they are represented as explicit missing observations, never invented zero interest.
 */
export function normalizeDataForSeoMeasurement({ response, candidates, geographicScope, retrievedAt, adapter, requestMetadata }) {
  if (!adapter?.normalize) throw new Error('A live provider adapter is required')
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > DATAFORSEO_MAX_KEYWORDS) throw new Error(`DataForSEO normalization requires one to ${DATAFORSEO_MAX_KEYWORDS} candidates`)
  const graph = graphFromResponse(response)
  if (graph.keywords.length !== candidates.length || graph.keywords.some((keyword, index) => keyword !== candidates[index].query)) throw new Error('DataForSEO graph keywords do not match the requested candidate order')
  const topics = candidates.map((candidate, index) => ({
    sourceId: candidate.sourceId ?? candidate.normalizedQuery,
    query: candidate.query,
    normalizedQuery: candidate.normalizedQuery,
    category: candidate.category,
    observations: graph.data.map((point) => {
      if (!Array.isArray(point.values) || point.values.length !== candidates.length) throw new Error('DataForSEO graph values do not match requested keywords')
      const measurement = point.values[index]
      const observedAt = unixTimestamp(point.timestamp, 'graph timestamp')
      if (!Number.isFinite(measurement) || measurement < 0) throw new Error('DataForSEO graph measurement must be a finite non-negative number')
      return measurement === 0
        ? { observedAt, measurement: null, missingReason: 'out-of-range' }
        : { observedAt, measurement }
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
  return normalized.map((topic) => ({
    ...topic,
    historyRequest: requestMetadata ? {
      timeRange: requestMetadata.time_range ?? null,
      dateFrom: requestMetadata.date_from ?? null,
      dateTo: requestMetadata.date_to ?? null,
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
