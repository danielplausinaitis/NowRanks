import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { buildDataForSeoAuthorization, requireDataForSeoCredentials } from './dataForSeoAuth.mjs'
import { LiveProviderError } from './providerAdapter.mjs'

export const DATAFORSEO_SEARCH_VOLUME_LIVE_ENDPOINT = 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live'
export const DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORDS = 1000
export const DATAFORSEO_SEARCH_VOLUME_PROVIDER_ID = 'dataforseo-google-ads-search-volume'

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function isoDate(value, label) {
  const date = text(value, label)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) throw new Error(`${label} must be YYYY-MM-DD`)
  return date
}

export function normalizeSearchVolumeQuery(query) {
  return text(query, 'DataForSEO Search Volume keyword').replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function validateKeyword(keyword) {
  const value = text(keyword, 'DataForSEO Search Volume keyword')
  if (value.length > 80) throw new Error('DataForSEO Search Volume keywords must not exceed 80 characters')
  if (value.split(/\s+/).length > 10) throw new Error('DataForSEO Search Volume keywords must not exceed 10 words')
  return value
}

function locationFields({ locationName, locationCode, locationCoordinate }) {
  const selected = [locationName, locationCode, locationCoordinate].filter((value) => value !== undefined)
  if (selected.length !== 1) throw new Error('DataForSEO Search Volume requires exactly one explicit locationName, locationCode, or locationCoordinate')
  if (locationName !== undefined) return { location_name: text(locationName, 'DataForSEO Search Volume locationName') }
  if (locationCode !== undefined) {
    if (!Number.isInteger(locationCode) || locationCode < 1) throw new Error('DataForSEO Search Volume locationCode must be a positive integer')
    return { location_code: locationCode }
  }
  return { location_coordinate: text(locationCoordinate, 'DataForSEO Search Volume locationCoordinate') }
}

function languageFields({ languageName, languageCode }) {
  if (languageName !== undefined && languageCode !== undefined) throw new Error('DataForSEO Search Volume accepts languageName or languageCode, not both')
  if (languageName !== undefined) return { language_name: text(languageName, 'DataForSEO Search Volume languageName') }
  if (languageCode !== undefined) return { language_code: text(languageCode, 'DataForSEO Search Volume languageCode') }
  return {}
}

export function buildDataForSeoSearchVolumeTask({ keywords, locationName, locationCode, locationCoordinate, languageName, languageCode, dateFrom, dateTo, searchPartners }) {
  if (!Array.isArray(keywords) || keywords.length === 0 || keywords.length > DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORDS) {
    throw new Error(`DataForSEO Search Volume requires one to ${DATAFORSEO_SEARCH_VOLUME_MAX_KEYWORDS} keywords per request`)
  }
  const task = {
    keywords: keywords.map(validateKeyword),
    ...locationFields({ locationName, locationCode, locationCoordinate }),
    ...languageFields({ languageName, languageCode }),
  }
  if (dateFrom !== undefined) task.date_from = isoDate(dateFrom, 'DataForSEO Search Volume dateFrom')
  if (dateTo !== undefined) task.date_to = isoDate(dateTo, 'DataForSEO Search Volume dateTo')
  if (searchPartners !== undefined) {
    if (typeof searchPartners !== 'boolean') throw new Error('DataForSEO Search Volume searchPartners must be boolean')
    task.search_partners = searchPartners
  }
  return task
}

function successfulResults(response) {
  if (!response || response.status_code !== 20000 || !Array.isArray(response.tasks) || response.tasks.length !== 1) throw new Error('DataForSEO Search Volume response must contain one successful task')
  const task = response.tasks[0]
  if (task.status_code !== 20000 || !Array.isArray(task.result)) throw new Error('DataForSEO Search Volume task failed or has no result array')
  return task.result
}

function responseFailure({ httpStatus, body }) {
  const task = Array.isArray(body?.tasks) ? body.tasks[0] : null
  const error = new Error('DataForSEO Search Volume returned an unsuccessful or malformed response')
  error.status = httpStatus
  error.code = body?.status_code ?? 'missing'
  error.details = `top-level status_code=${body?.status_code ?? 'missing'} status_message=${body?.status_message ?? 'missing'}; task status_code=${task?.status_code ?? 'missing'} status_message=${task?.status_message ?? 'missing'}; result=${Array.isArray(task?.result) ? 'array' : 'missing-or-malformed'}`
  return error
}

function isSuccessfulEnvelope(body) {
  return body?.status_code === 20000 && Array.isArray(body.tasks) && body.tasks.length === 1 && body.tasks[0]?.status_code === 20000 && Array.isArray(body.tasks[0]?.result)
}

function nullableNonNegative(value, label) {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number or null`)
  return value
}

function monthlyHistory(value, keyword) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) throw new Error(`DataForSEO monthly_searches for ${keyword} must be an array or null`)
  const seen = new Set()
  return value.map((month) => {
    if (!Number.isInteger(month?.year) || !Number.isInteger(month?.month) || month.month < 1 || month.month > 12) throw new Error(`DataForSEO monthly history for ${keyword} has an invalid year or month`)
    const period = `${month.year}-${String(month.month).padStart(2, '0')}`
    if (seen.has(period)) throw new Error(`DataForSEO monthly history for ${keyword} contains duplicate period ${period}`)
    seen.add(period)
    const searchVolume = nullableNonNegative(month.search_volume, `DataForSEO monthly search volume for ${keyword}`)
    return { period, year: month.year, month: month.month, availability: searchVolume === null ? 'missing' : 'available', searchVolume }
  })
}

/** Produces baseline-demand records; it does not feed or modify the scoring engine. */
export function normalizeDataForSeoSearchVolume({ response, retrievedAt, geographicScope }) {
  if (typeof retrievedAt !== 'string' || Number.isNaN(Date.parse(retrievedAt))) throw new Error('DataForSEO Search Volume retrievedAt must be a valid timestamp')
  if (!geographicScope || typeof geographicScope !== 'object') throw new Error('DataForSEO Search Volume geographicScope is required')
  return successfulResults(response).map((result) => {
    const query = text(result?.keyword, 'DataForSEO Search Volume result keyword')
    const normalizedQuery = normalizeSearchVolumeQuery(query)
    const searchVolume = nullableNonNegative(result.search_volume, `DataForSEO search volume for ${query}`)
    const cpc = nullableNonNegative(result.cpc, `DataForSEO CPC for ${query}`)
    const competitionIndex = nullableNonNegative(result.competition_index, `DataForSEO competition index for ${query}`)
    return {
      providerId: DATAFORSEO_SEARCH_VOLUME_PROVIDER_ID,
      sourceId: `${DATAFORSEO_SEARCH_VOLUME_PROVIDER_ID}:${normalizedQuery}`,
      query,
      normalizedQuery,
      availability: searchVolume === null ? 'missing' : 'available',
      searchVolume,
      competition: result.competition ?? null,
      competitionIndex,
      cpc,
      monthlyHistory: monthlyHistory(result.monthly_searches, query),
      retrievedAt,
      geographicScope,
      providerLocationCode: result.location_code ?? null,
      providerLanguageCode: result.language_code ?? null,
      provenance: {
        providerId: DATAFORSEO_SEARCH_VOLUME_PROVIDER_ID,
        dataMode: 'live',
        retrievedAt,
        geographicScope,
        collectionMethod: 'google-ads-search-volume-live',
        comparability: { status: 'comparable', basis: 'Approximate absolute monthly search counts under one explicit targeting configuration' },
      },
    }
  })
}

function targetingFingerprint(task) {
  return JSON.stringify({
    location_name: task.location_name ?? null,
    location_code: task.location_code ?? null,
    location_coordinate: task.location_coordinate ?? null,
    language_name: task.language_name ?? null,
    language_code: task.language_code ?? null,
    date_from: task.date_from ?? null,
    date_to: task.date_to ?? null,
    search_partners: task.search_partners ?? false,
  })
}

/** Absolute volume estimates remain comparable across requests only with identical targeting. */
export function assessSearchVolumeComparability(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('At least one DataForSEO Search Volume task is required')
  const fingerprint = targetingFingerprint(tasks[0])
  const sameTargeting = tasks.every((task) => targetingFingerprint(task) === fingerprint)
  return sameTargeting
    ? { status: 'comparable', scope: tasks.length === 1 ? 'single-request-cohort' : 'matched-targeting-requests', basis: 'Absolute approximate monthly search volume under identical targeting' }
    : { status: 'not-comparable', scope: 'mixed-targeting-requests', basis: 'Location, language, date range, or search-partner targeting differs' }
}

export function createDataForSeoSearchVolumeClient({ env = process.env, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  return {
    async lookup(request) {
      const credentials = requireDataForSeoCredentials(env)
      const task = buildDataForSeoSearchVolumeTask(request)
      try {
        const response = await fetchImpl(DATAFORSEO_SEARCH_VOLUME_LIVE_ENDPOINT, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: buildDataForSeoAuthorization(credentials) },
          body: JSON.stringify([task]),
        })
        const body = await response.json()
        if (!response.ok || !isSuccessfulEnvelope(body)) throw responseFailure({ httpStatus: response.status, body })
        return { response: body, retrievedAt: now(), task }
      } catch (error) {
        throw new LiveProviderError(DATAFORSEO_SEARCH_VOLUME_PROVIDER_ID, { message: formatErrorDiagnostics(error) })
      }
    },
  }
}
