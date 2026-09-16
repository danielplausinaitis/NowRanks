import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { buildDataForSeoAuthorization, requireDataForSeoCredentials } from './dataForSeoAuth.mjs'
import { LiveProviderError } from './providerAdapter.mjs'
import { createDataForSeoGraphDiagnostics, mergeDataForSeoGraphDiagnostics } from './dataForSeoTrends.mjs'
import { CROSS_QUERY_COMPARABILITY_STATUS } from './provenanceComparability.mjs'
import { mapDataForSeoGraphKeywordColumns, normalizeDataForSeoProviderEchoKeyword, normalizeDataForSeoProviderKeyword } from './providerKeywordIdentity.mjs'

export const DATAFORSEO_GOOGLE_TRENDS_EXPLORE_LIVE_ENDPOINT = 'https://api.dataforseo.com/v3/keywords_data/google_trends/explore/live'
export const DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASK_POST_ENDPOINT = 'https://api.dataforseo.com/v3/keywords_data/google_trends/explore/task_post'
export const DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASKS_READY_ENDPOINT = 'https://api.dataforseo.com/v3/keywords_data/google_trends/explore/tasks_ready'
export const DATAFORSEO_GOOGLE_TRENDS_TIME_RANGES = Object.freeze([
  'past_hour', 'past_4_hours', 'past_day', 'past_7_days', 'past_30_days', 'past_90_days', 'past_12_months', 'past_5_years',
])

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function timestamp(value) {
  if (!Number.isFinite(value)) throw new Error('Google Trends graph timestamp must be a finite Unix timestamp')
  return new Date(value * 1000).toISOString()
}

/**
 * Builds an intentionally scoped Google Trends Explore request. Global is named at the
 * call site and represented on the wire by deliberately omitting location fields.
 */
export function buildDataForSeoGoogleTrendsExploreTask({ keywords, timeRange, measurementTarget, locationName, locationCode, type, itemTypes = ['google_trends_graph'] }) {
  if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 5) throw new Error('Google Trends requires one to five keywords per request')
  const normalizedKeywords = keywords.map((keyword) => {
    const value = text(keyword, 'Google Trends keyword')
    if (value.length < 2 || value.length > 100) throw new Error('Google Trends keyword must contain two to 100 characters')
    return value
  })
  if (!['global', 'country'].includes(measurementTarget)) throw new Error('Google Trends measurementTarget must be global or country')
  if (measurementTarget === 'global') {
    if (locationName !== undefined || locationCode !== undefined) throw new Error('Global Google Trends request must omit location fields')
  } else if ((locationName === undefined) === (locationCode === undefined)) {
    throw new Error('Country Google Trends request requires exactly one location field')
  }
  if (!DATAFORSEO_GOOGLE_TRENDS_TIME_RANGES.includes(text(timeRange, 'Google Trends timeRange'))) throw new Error('Google Trends timeRange is unsupported')
  if (!Array.isArray(itemTypes) || itemTypes.length !== 1 || itemTypes[0] !== 'google_trends_graph') throw new Error('This Google Trends experiment requests only google_trends_graph')
  const task = { keywords: normalizedKeywords, time_range: timeRange.trim(), item_types: ['google_trends_graph'] }
  if (locationName !== undefined) task.location_name = text(locationName, 'Google Trends locationName')
  if (locationCode !== undefined) {
    if (!Number.isInteger(locationCode) || locationCode < 1) throw new Error('Google Trends locationCode must be a positive integer')
    task.location_code = locationCode
  }
  if (type !== undefined) task.type = text(type, 'Google Trends type')
  return task
}

function successfulTask(response) {
  if (!response || !Array.isArray(response.tasks) || response.tasks.length !== 1) throw new Error('Google Trends response must contain exactly one task')
  const task = response.tasks[0]
  if (task?.status_code !== 20000) throw new Error(`Google Trends task failed: ${task?.status_code ?? 'missing'} ${task?.status_message ?? 'missing'}`)
  if (!Array.isArray(task.result) || task.result.length !== 1) throw new Error('Google Trends task must contain exactly one result')
  return task
}

function graphFromResponse(response) {
  const task = successfulTask(response)
  const result = task.result[0]
  if (!Array.isArray(result?.items)) throw new Error('Google Trends result must contain an items array')
  const graph = result.items.find((item) => item?.type === 'google_trends_graph')
  if (!graph) throw new Error('Google Trends response contains no google_trends_graph item')
  if (!Array.isArray(graph.keywords) || !Array.isArray(graph.data)) throw new Error('Google Trends graph must contain keywords and data arrays')
  return { task, result, graph }
}

/** Conservative text normalization for submitted provider labels and batch identity; never semantic/fuzzy. */
export function normalizeGoogleTrendsProviderKeyword(value) {
  try {
    return normalizeDataForSeoProviderKeyword(value)
  } catch (error) {
    // Preserve the public Google Trends error contract while sharing the exact
    // conservative text identity implementation with the longer-window path.
    throw new Error(error.message.replace('DataForSEO provider keyword', 'Google Trends provider keyword'))
  }
}

/**
 * Matches DataForSEO's graph-keyword echo back to a submitted lookup label.
 * The provider is observed to vary only the optional dollar marker and comma
 * grouping of a standalone integer (for example, `$5,000` -> `$5000`).
 * This deliberately does not touch words, decimals, or other punctuation.
 */
export function normalizeGoogleTrendsProviderEchoKeyword(value) {
  return normalizeDataForSeoProviderEchoKeyword(value)
}

/**
 * Resolves the graph's returned keyword columns back to the exact submitted lookup strings.
 * `values[n]` is interpreted only through `returnedKeywords[n]`, never request position.
 */
export function mapGoogleTrendsGraphKeywordColumns({ requestedKeywords, returnedKeywords }) {
  return mapDataForSeoGraphKeywordColumns({
    requestedKeywords,
    returnedKeywords,
    normalizeKeyword: normalizeGoogleTrendsProviderEchoKeyword,
    providerLabel: 'Google Trends',
  })
}

function canonicalCandidateIdentity(candidate) {
  if (typeof candidate?.normalizedQuery !== 'string' || !candidate.normalizedQuery) throw new Error('Google Trends canonical candidate identity is required')
  return candidate.normalizedQuery
}

/**
 * Validates the request map emitted by the batch planner. The map has one row
 * per unique provider keyword and one-or-more canonical candidates per row.
 * A fallback one-to-one map keeps direct/single-candidate callers compatible.
 */
function resolvedRequestMap(candidates, batch) {
  const candidateByIdentity = new Map()
  for (const candidate of candidates) {
    const identity = canonicalCandidateIdentity(candidate)
    if (candidateByIdentity.has(identity)) throw new Error(`Google Trends candidate identity collision: ${identity}`)
    candidateByIdentity.set(identity, candidate)
  }
  const map = Array.isArray(batch?.requestMap)
    ? batch.requestMap
    : candidates.map((candidate, requestIndex) => ({
      requestIndex,
      providerKeyword: candidate.query,
      providerKeywordNormalized: normalizeGoogleTrendsProviderKeyword(candidate.query),
      canonicalCandidates: [{ canonicalCandidateIdentity: canonicalCandidateIdentity(candidate), canonicalQuery: candidate.query }],
    }))
  if (map.length < 1 || map.length > 5) throw new Error('Google Trends request map must contain one to five provider keywords')
  const seenRequestIndexes = new Set(); const seenProviderKeywords = new Set(); const seenCandidates = new Set()
  const resolved = map.map((entry, position) => {
    if (!Number.isInteger(entry?.requestIndex) || entry.requestIndex !== position || seenRequestIndexes.has(entry.requestIndex)) throw new Error('Google Trends request map has invalid request indexes')
    seenRequestIndexes.add(entry.requestIndex)
    const providerKeyword = text(entry?.providerKeyword, 'Google Trends provider keyword')
    const providerKeywordNormalized = normalizeGoogleTrendsProviderKeyword(providerKeyword)
    if (entry.providerKeywordNormalized !== undefined && entry.providerKeywordNormalized !== providerKeywordNormalized) throw new Error('Google Trends request map provider keyword normalization mismatch')
    if (seenProviderKeywords.has(providerKeywordNormalized)) throw new Error('Google Trends request map contains duplicate provider keywords')
    seenProviderKeywords.add(providerKeywordNormalized)
    if (!Array.isArray(entry?.canonicalCandidates) || entry.canonicalCandidates.length < 1) throw new Error('Google Trends request map requires canonical candidates')
    const canonicalCandidates = entry.canonicalCandidates.map((member) => {
      const identity = member?.canonicalCandidateIdentity
      const candidate = candidateByIdentity.get(identity)
      if (!candidate || member?.canonicalQuery !== candidate.query || seenCandidates.has(identity)) throw new Error('Google Trends request map cannot prove canonical candidate ownership')
      seenCandidates.add(identity)
      return { candidate, canonicalCandidateIdentity: identity, canonicalQuery: candidate.query }
    })
    return { requestIndex: entry.requestIndex, providerKeyword, providerKeywordNormalized, canonicalCandidates }
  })
  if (seenCandidates.size !== candidates.length) throw new Error('Google Trends request map does not cover every canonical candidate')
  return resolved
}

function classify(value) {
  if (Number.isFinite(value) && value > 0) return 'positive'
  if (value === 0) return 'zero'
  if (value === null) return 'null'
  if (value === undefined) return 'missing'
  return 'invalid'
}

export const GOOGLE_TRENDS_HOURLY_RESAMPLING = Object.freeze({
  sourceResolution: 'approximately-8-minutes',
  aggregation: 'hourly-mean',
  expectedObservationsPerHour: 8,
  minimumValidObservations: 4,
})

function missingReasonForBucket(points) {
  return points.length > 0 && points.every((point) => point.missingReason === 'out-of-range')
    ? 'out-of-range'
    : 'source-unavailable'
}

/**
 * Deterministically converts one Google Trends high-resolution graph to UTC-hour buckets.
 * Only positive finite provider values participate; documented provider zero remains unavailable.
 */
export function resampleGoogleTrendsHourly(observations, rules = GOOGLE_TRENDS_HOURLY_RESAMPLING) {
  if (!Array.isArray(observations)) throw new Error('Google Trends hourly resampling requires observations')
  const buckets = new Map()
  for (const observation of observations) {
    const at = Date.parse(observation?.observedAt)
    if (!Number.isFinite(at)) throw new Error('Google Trends hourly resampling requires valid timestamps')
    const bucketAt = new Date(Math.floor(at / 3_600_000) * 3_600_000).toISOString()
    if (!buckets.has(bucketAt)) buckets.set(bucketAt, [])
    buckets.get(bucketAt).push(observation)
  }
  const metadata = []
  const hourly = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([bucketStart, points]) => {
    const valid = points.filter((point) => point?.availability === 'available' && Number.isFinite(point.interest) && point.interest > 0)
    const coverage = valid.length / rules.expectedObservationsPerHour
    const available = valid.length >= rules.minimumValidObservations
    const value = available ? valid.reduce((sum, point) => sum + point.interest, 0) / valid.length : null
    const bucket = {
      bucketStart,
      sourceResolution: rules.sourceResolution,
      aggregation: rules.aggregation,
      expectedObservations: rules.expectedObservationsPerHour,
      rawObservationCount: points.length,
      validObservationCount: valid.length,
      coverage,
      coverageStatus: available ? (valid.length >= rules.expectedObservationsPerHour ? 'complete' : 'partial-sufficient') : 'insufficient',
      aggregatedValue: value,
    }
    metadata.push(bucket)
    return available
      ? { observedAt: bucketStart, date: bucketStart.slice(0, 10), availability: 'available', interest: value, resampling: bucket }
      : { observedAt: bucketStart, date: bucketStart.slice(0, 10), availability: 'missing', interest: null, missingReason: missingReasonForBucket(points), resampling: bucket }
  })
  return { observations: hourly, buckets: metadata, rules: { ...rules } }
}

function rawObservation(value, point) {
  const kind = point?.missing_data === true ? 'missing' : classify(value)
  if (kind === 'positive') return { measurement: value, rawProviderValue: value }
  if (kind === 'zero') return { measurement: null, missingReason: 'out-of-range', rawProviderValue: value }
  return { measurement: null, missingReason: 'invalid-provider-measurement', rawProviderValue: value ?? null }
}

/**
 * Adapts Google Trends Explore responses to the existing history contract while retaining the
 * source-resolution curve for artifacts and separately exposing canonical hourly buckets.
 */
export function normalizeDataForSeoGoogleTrendsMeasurement({ response, candidates, geographicScope, retrievedAt, adapter, requestMetadata, batch = null }) {
  if (!adapter?.normalize) throw new Error('A live provider adapter is required')
  if (!Array.isArray(candidates) || candidates.length < 1) throw new Error('Google Trends normalization requires at least one canonical candidate')
  const requestMap = resolvedRequestMap(candidates, batch)
  // DataForSEO returns one shared graph whose values columns are labeled by
  // graph.keywords. Split only after proving provider-label ownership; request
  // order is intentionally never treated as candidate identity.
  const requestKeywords = requestMap.map((entry) => entry.providerKeyword)
  const { graph } = graphFromResponse(response)
  const keywordMapping = mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: requestKeywords, returnedKeywords: graph.keywords })
  if (graph.data.some((point) => !Array.isArray(point?.values) || point.values.length !== graph.keywords.length)) throw new Error('Google Trends graph values do not match returned keywords')
  if (candidates.length > 1 || requestMap.length > 1) {
    const histories = []; const diagnostics = createDataForSeoGraphDiagnostics()
    for (const requestEntry of requestMap) {
      const returnedKeywordIndex = keywordMapping.returnedIndexByRequestIndex[requestEntry.requestIndex]
      for (const member of requestEntry.canonicalCandidates) {
        const candidate = member.candidate
        const oneKeywordResponse = structuredClone(response)
        const oneGraph = oneKeywordResponse.tasks[0].result[0].items.find((item) => item?.type === 'google_trends_graph')
        oneGraph.keywords = [candidate.query]
        oneGraph.data = oneGraph.data.map((point) => ({ ...point, values: [point.values[returnedKeywordIndex]] }))
        const childBatch = { ...(batch ?? {}) }
        delete childBatch.requestMap
        const normalized = normalizeDataForSeoGoogleTrendsMeasurement({ response: oneKeywordResponse, candidates: [candidate], geographicScope, retrievedAt, adapter, requestMetadata, batch: childBatch })
        const history = normalized.histories[0]
        history.provenance = { ...history.provenance, collectionMethod: 'dataforseo-google-trends-explore-live-batched', crossQueryComparability: { status: CROSS_QUERY_COMPARABILITY_STATUS.NOT_COMPARABLE, basis: 'Google Trends values share a relative scale only within this request batch; independent batches are not directly cross-query comparable. Candidate-local temporal change remains usable; the batch fingerprint protects canonical compatibility.' } }
        history.batch = { ...(batch ?? {}), requestIndex: requestEntry.requestIndex, keywordIndex: requestEntry.requestIndex, returnedKeywordIndex, providerKeyword: requestEntry.providerKeyword, returnedProviderKeyword: graph.keywords[returnedKeywordIndex], canonicalCandidateIdentity: member.canonicalCandidateIdentity, canonicalQuery: member.canonicalQuery }
        histories.push(history); mergeDataForSeoGraphDiagnostics(diagnostics, normalized.diagnostics)
      }
    }
    return { histories, diagnostics }
  }
  const candidate = candidates[0]
  const { task, result } = graphFromResponse(response)
  const diagnostics = createDataForSeoGraphDiagnostics()
  const candidateDiagnostics = {
    canonicalQuery: candidate.query,
    normalizedQuery: candidate.normalizedQuery,
    measurementMode: requestMetadata?.measurementMode ?? 'global',
    measurementTarget: requestMetadata?.measurementTarget ?? null,
    requestTimeRange: requestMetadata?.time_range ?? null,
    providerTaskStatusCode: task.status_code ?? null,
    providerTaskStatusMessage: task.status_message ?? null,
    providerReturnedLocation: result.location_code ?? null,
    providerReturnedLanguage: result.language_code ?? null,
    graphPresent: true,
    graphValuesAlignedToRequestedKeywords: true,
    graphPointCount: graph.data.length,
    firstObservedAt: graph.data.length ? timestamp(graph.data[0].timestamp) : null,
    lastObservedAt: graph.data.length ? timestamp(graph.data.at(-1).timestamp) : null,
    positiveMeasurements: 0,
    zeroMeasurements: 0,
    nullMeasurements: 0,
    missingValueMeasurements: 0,
    negativeMeasurements: 0,
    invalidNonNumericMeasurements: 0,
    usableCanonicalPoints: 0,
  }
  const sourceObservations = graph.data.map((point) => {
    if (!Array.isArray(point?.values) || point.values.length !== 1) throw new Error('Google Trends graph values do not match the requested keyword')
    const value = point.values[0]
    const kind = point?.missing_data === true ? 'missing' : classify(value)
    diagnostics.totalGraphPoints += 1
    if (kind === 'positive') {
      diagnostics.positiveMeasurements += 1; candidateDiagnostics.positiveMeasurements += 1
    } else if (kind === 'zero') {
      diagnostics.zeroMeasurements += 1; candidateDiagnostics.zeroMeasurements += 1
    } else {
      const counter = kind === 'null'
        ? 'nullMeasurements'
        : kind === 'missing'
          ? 'missingValueMeasurements'
          : typeof value === 'number' && value < 0
            ? 'negativeMeasurements'
            : 'invalidNonNumericMeasurements'
      diagnostics[counter] += 1; candidateDiagnostics[counter] += 1
      diagnostics.invalidOrMissingMeasurements += 1
    }
    return {
      observedAt: timestamp(point.timestamp),
      ...rawObservation(value, point),
      providerBucketStart: typeof point.date_from === 'string' ? point.date_from : null,
      providerBucketEnd: typeof point.date_to === 'string' ? point.date_to : null,
    }
  })
  if (diagnostics.invalidOrMissingMeasurements > 0) diagnostics.affectedCandidates = 1
  const normalized = adapter.normalize({
    sourceObservedAt: retrievedAt,
    geographicScope,
    sourceVersion: 'dataforseo-google-trends-v3',
    collectionMethod: 'dataforseo-google-trends-explore-live',
    crossQueryComparability: { status: CROSS_QUERY_COMPARABILITY_STATUS.COMPARABLE, basis: 'DataForSEO Google Trends relative scale within one single-keyword request' },
    topics: [{ sourceId: candidate.sourceId ?? candidate.normalizedQuery, query: candidate.query, normalizedQuery: candidate.normalizedQuery, category: candidate.category, observations: sourceObservations }],
  }, { retrievedAt })
  const raw = normalized[0].observations.map((observation, index) => ({
    ...observation,
    rawProviderValue: sourceObservations[index].rawProviderValue,
    providerBucketStart: sourceObservations[index].providerBucketStart,
    providerBucketEnd: sourceObservations[index].providerBucketEnd,
  }))
  const resampled = resampleGoogleTrendsHourly(raw)
  candidateDiagnostics.usableCanonicalPoints = resampled.observations.filter((point) => point.availability === 'available').length
  diagnostics.candidatesWithoutUsablePoints = candidateDiagnostics.usableCanonicalPoints === 0 ? 1 : 0
  diagnostics.candidateDiagnostics = [candidateDiagnostics]
  return {
    histories: [{
      ...normalized[0],
      provenance: { ...normalized[0].provenance, sourceVersion: 'dataforseo-google-trends-v3', collectionMethod: 'dataforseo-google-trends-explore-live' },
      // Downstream scoring retains its established hourly historical contract. The original
      // high-resolution observations remain attached solely for the auditable curve artifact.
      observations: resampled.observations,
      rawProviderObservations: raw,
      canonicalObservations: resampled.observations,
      canonicalAggregation: resampled.rules,
      canonicalHourlyBuckets: resampled.buckets,
      measurementProvenance: {
        measurementMode: requestMetadata?.measurementMode ?? 'global', measurementTarget: requestMetadata?.measurementTarget ?? null,
        measurementLocation: geographicScope, measurementLanguage: result.language_code ?? null,
        providerReturnedLocation: result.location_code ?? null, providerReturnedLanguage: result.language_code ?? null,
      },
      historyRequest: {
        timeRange: requestMetadata?.time_range ?? null,
        dateFrom: requestMetadata?.date_from ?? null,
        dateTo: requestMetadata?.date_to ?? null,
        measurementMode: requestMetadata?.measurementMode ?? 'global',
        measurementTarget: requestMetadata?.measurementTarget ?? null,
      },
      retrievedAt,
    }],
    diagnostics,
  }
}

/**
 * Parses the Google-specific graph independently of the existing DataForSEO Trends parser.
 * Raw zero is retained in the report; it is not called a usable hourly point because Google's
 * documented semantics define zero as insufficient data.
 */
export function inspectDataForSeoGoogleTrendsResponse({ response, task, query }) {
  const { task: providerTask, result, graph } = graphFromResponse(response)
  if (task.keywords.length !== 1 || task.keywords[0] !== query) throw new Error('Google Trends experiment report requires one matching query')
  mapGoogleTrendsGraphKeywordColumns({ requestedKeywords: task.keywords, returnedKeywords: graph.keywords })
  const report = {
    query,
    taskStatusCode: providerTask.status_code ?? null,
    taskStatusMessage: providerTask.status_message ?? null,
    graphPresent: true,
    graphPointCount: graph.data.length,
    firstTimestamp: null,
    lastTimestamp: null,
    positive: 0,
    zero: 0,
    null: 0,
    missing: 0,
    invalid: 0,
    usableHourlyPoints: 0,
    minimumPositiveValue: null,
    maximumValue: null,
    returnedLocation: result.location_code ?? null,
    returnedLanguage: result.language_code ?? null,
  }
  for (const point of graph.data) {
    if (!Array.isArray(point?.values) || point.values.length !== 1) throw new Error('Google Trends graph values do not match the requested keyword')
    const observedAt = timestamp(point.timestamp)
    report.firstTimestamp ??= observedAt
    report.lastTimestamp = observedAt
    const value = point.values[0]
    const kind = classify(value)
    report[kind] += 1
    if (kind === 'positive') {
      report.usableHourlyPoints += 1
      report.minimumPositiveValue = report.minimumPositiveValue === null ? value : Math.min(report.minimumPositiveValue, value)
      report.maximumValue = report.maximumValue === null ? value : Math.max(report.maximumValue, value)
    } else if (kind === 'zero') {
      report.maximumValue = report.maximumValue === null ? 0 : Math.max(report.maximumValue, 0)
    }
  }
  return report
}

export function googleTrendsProviderReportedCost(response) {
  if (Number.isFinite(response?.cost)) return response.cost
  return (response?.tasks ?? []).reduce((total, task) => total + (Number.isFinite(task?.cost) ? task.cost : 0), 0)
}

/** Experimental-only HTTP transport. It performs no persistence and no production wiring. */
export function createDataForSeoGoogleTrendsClient({ env = process.env, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  return {
    async explore(request) {
      const { login, password } = requireDataForSeoCredentials(env)
      const task = buildDataForSeoGoogleTrendsExploreTask(request)
      try {
        const response = await fetchImpl(DATAFORSEO_GOOGLE_TRENDS_EXPLORE_LIVE_ENDPOINT, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: buildDataForSeoAuthorization({ login, password }) },
          body: JSON.stringify([task]),
        })
        return { response: await response.json(), httpStatus: response.status, task, retrievedAt: now() }
      } catch (error) {
        throw new LiveProviderError('dataforseo-google-trends-experiment', { message: formatErrorDiagnostics(error) })
      }
    },
  }
}

/**
 * Standard/queue transport. Posting is billable; ready-list and task-get reads are free for
 * 30 days according to the provider contract. The caller owns persisted task IDs and decides
 * when to poll, so this module never creates background work by itself.
 */
export function createDataForSeoGoogleTrendsStandardClient({ env = process.env, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const headers = () => {
    const { login, password } = requireDataForSeoCredentials(env)
    return { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: buildDataForSeoAuthorization({ login, password }) }
  }
  const request = async (url, options = {}) => {
    try { const response = await fetchImpl(url, { ...options, headers: { ...headers(), ...(options.headers ?? {}) } }); return { response: await response.json(), httpStatus: response.status, retrievedAt: now() } }
    catch (error) { throw new LiveProviderError('dataforseo-google-trends-standard', { message: formatErrorDiagnostics(error) }) }
  }
  return {
    mode: 'standard',
    async postTasks(requests) {
      if (!Array.isArray(requests) || requests.length < 1 || requests.length > 100) throw new Error('Google Trends Standard accepts one to 100 tasks per POST')
      const tasks = requests.map((entry) => buildDataForSeoGoogleTrendsExploreTask(entry))
      const result = await request(DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASK_POST_ENDPOINT, { method: 'POST', body: JSON.stringify(tasks) })
      return { ...result, tasks }
    },
    async listReady() { return request(DATAFORSEO_GOOGLE_TRENDS_EXPLORE_TASKS_READY_ENDPOINT, { method: 'GET' }) },
    async getTask(taskId) {
      if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Google Trends Standard task ID is required')
      return request(`https://api.dataforseo.com/v3/keywords_data/google_trends/explore/task_get/${encodeURIComponent(taskId)}`, { method: 'GET' })
    },
  }
}
