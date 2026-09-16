import { LiveProviderError } from './providerAdapter.mjs'

export const SERPAPI_TRENDING_NOW_ENDPOINT = 'https://serpapi.com/search.json'
export const SERPAPI_TRENDING_NOW_PROVIDER_ID = 'serpapi-google-trends-trending-now'
export const SERPAPI_DISCOVERY_MAX_RETRIES = 2
export const SERPAPI_DISCOVERY_RETRY_BASE_DELAY_MS = 250
const HOURS = new Set([4, 24, 48, 168])
const CATEGORY_MAP = Object.freeze({
  technology: 'Technology', games: 'Gaming', gaming: 'Gaming', sports: 'Sports', travel: 'Travel', finance: 'Finance',
  entertainment: 'Entertainment', 'arts & entertainment': 'Entertainment', autos: 'Cars', 'autos & vehicles': 'Cars', 'autos and vehicles': 'Cars', cars: 'Cars', business: 'Business', 'business and finance': 'Business', health: 'Health', 'travel and transportation': 'Travel',
  climate: 'Science', science: 'Science', 'food and drink': 'Lifestyle', 'jobs and education': 'Business', 'law and government': 'News & Politics', politics: 'News & Politics',
})
const FINANCE_QUERY = /\b(stock|stocks|share price|shares|earnings|market|markets|bitcoin|crypto|cryptocurrency|bond|bonds|forex|currency|currencies|nasdaq|dow|s&p)\b/i
const HIGH_CONFIDENCE_QUERY_CATEGORY = Object.freeze([
  ['Cars', /\b(tesla|jeep|roadster|wrangler)\b/i],
  ['Technology', /\b(openai|anthropic|dario amodei|artificial intelligence|\bai\b)\b/i],
  ['News & Politics', /\b(trump|administration|president|congress|senate|federal judge|bbc|reuters|cnn)\b/i],
  ['Science', /\b(weather|climate)\b/i],
  ['Travel', /\b(airport|flight)\b/i],
])

function safeDiagnosticText(value) {
  return String(value ?? '')
    .replace(/\b(sb_secret_[A-Za-z0-9._-]+|service_role_[A-Za-z0-9._-]+)\b/gi, '[REDACTED]')
    .replace(/\b(authorization|api[ _-]?key|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[REDACTED_URL]')
}

function safeFetchFailure(error) {
  const cause = error && typeof error === 'object' ? error.cause : undefined
  const causeCode = cause && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : undefined
  const causeMessage = cause && typeof cause === 'object' && typeof cause.message === 'string' ? cause.message : undefined
  const safeCauseMessage = causeMessage && !/https?:|api[_-]?key|authorization|credential|password|secret/i.test(causeMessage)
  return {
    message: safeDiagnosticText(error instanceof Error ? error.message : 'fetch failed'),
    ...(causeCode ? { code: causeCode } : {}),
    ...(safeCauseMessage ? { details: safeDiagnosticText(causeMessage) } : {}),
  }
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function timestampFromUnix(value) {
  if (!Number.isFinite(value)) return null
  return new Date(value * 1000).toISOString()
}

function responseKeys(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body).filter((key) => !/authorization|api.?key|password|secret|credential/i.test(key)).sort()
    : []
}

function providerMessage(body) {
  const value = body?.error ?? body?.search_metadata?.status ?? null
  return typeof value === 'string' && value.trim() ? safeDiagnosticText(value.trim()) : null
}

function rateLimited({ status, body }) {
  return status === 429 || /rate.?limit|too many requests|quota exceeded/i.test(`${body?.error ?? ''} ${body?.search_metadata?.status ?? ''}`)
}

function responseDiagnostic({ geo, status = null, body = null, classification, network = null }) {
  const hasTrendingSearches = Boolean(body && typeof body === 'object' && Object.hasOwn(body, 'trending_searches'))
  const trendingSearches = body?.trending_searches
  const hasTrendingData = hasTrendingSearches || Boolean(body && typeof body === 'object' && Object.hasOwn(body, 'trending'))
  const providerStatus = typeof body?.search_metadata?.status === 'string' ? safeDiagnosticText(body.search_metadata.status) : null
  const error = providerMessage(body)
  return {
    geo,
    requestStatus: Number.isFinite(status) ? status : null,
    classification,
    providerError: error,
    providerStatus,
    topLevelResponseKeys: responseKeys(body),
    trendingSearches: { present: hasTrendingSearches, isArray: Array.isArray(trendingSearches), count: Array.isArray(trendingSearches) ? trendingSearches.length : null },
    trendingDataPresent: hasTrendingData,
    responseEmpty: Boolean(body && typeof body === 'object' && !Array.isArray(body) && responseKeys(body).length === 0),
    rateLimited: rateLimited({ status, body }),
    ...(network ? { network } : {}),
  }
}

function retryableDiagnostic(diagnostic) {
  const status = diagnostic.requestStatus
  return diagnostic.classification === 'network-failure'
    || diagnostic.rateLimited === true
    || status === 408 || status === 425 || (Number.isFinite(status) && status >= 500)
}

function discoveryError(diagnostic) {
  const summary = diagnostic.providerError ?? diagnostic.providerStatus ?? diagnostic.network?.details ?? diagnostic.network?.message ?? diagnostic.classification
  const error = new LiveProviderError(SERPAPI_TRENDING_NOW_PROVIDER_ID, {
    message: `SerpApi discovery for geo ${diagnostic.geo} failed: ${summary}`,
    ...(diagnostic.requestStatus === null ? {} : { status: diagnostic.requestStatus }),
    ...(diagnostic.network?.code ? { code: diagnostic.network.code } : {}),
  })
  error.status = diagnostic.requestStatus
  error.code = diagnostic.network?.code ?? null
  error.retryable = retryableDiagnostic(diagnostic)
  error.discoveryDiagnostic = diagnostic
  error.details = JSON.stringify(diagnostic)
  return error
}

function malformedResponseError({ geo, status, body, classification }) {
  return discoveryError(responseDiagnostic({ geo, status, body, classification }))
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function requireSerpApiApiKey(env = process.env) {
  const key = env.SERPAPI_API_KEY
  if (typeof key !== 'string' || !key.trim()) throw new Error('SERPAPI_API_KEY is required for live candidate discovery')
  return key.trim()
}

export function mapSerpApiCategory(name) {
  if (typeof name !== 'string') return null
  return CATEGORY_MAP[name.trim().toLocaleLowerCase('en-US')] ?? null
}

export function normalizedDiscoveryQuery(query) {
  return text(query, 'SerpApi trending query').replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function queryCategory(query) {
  if (typeof query !== 'string') return null
  const match = HIGH_CONFIDENCE_QUERY_CATEGORY.find(([, pattern]) => pattern.test(query))
  return match ? match[0] : null
}

/** Classifies provider metadata first; query signals only resolve explicit Other/unknown metadata. */
export function classifySerpApiDiscoveryCategoryDetails({ query, categories, rawCategories = [] }) {
  const inferred = queryCategory(query)
  // Google may list the broad entertainment parent before a specific Games
  // label. Prefer the specific existing taxonomy member without guessing.
  if (categories.includes('Gaming')) return { category: 'Gaming', source: 'provider-metadata' }
  // Law/government/politics should not be hidden behind a broad secondary
  // provider tag such as Travel when the same record carries both.
  if (categories.includes('News & Politics')) return { category: 'News & Politics', source: 'provider-metadata' }
  // "Business and Finance" is a broad provider vertical. Retain Business for
  // ordinary topics, but use an explicit finance query signal when present.
  if (categories.includes('Business') && FINANCE_QUERY.test(query)) return { category: 'Finance', source: 'query-signal' }
  // A named AI-company signal is more specific than the provider's very broad
  // Science label, while ordinary science discoveries keep that provider label.
  if (categories.includes('Science') && inferred === 'Technology') return { category: 'Technology', source: 'query-signal' }
  if (categories.length) return { category: categories[0], source: 'provider-metadata' }
  // Only resolve a provider "Other" (or absent category) when the query itself
  // carries a deliberately narrow, high-confidence signal.
  return inferred ? { category: inferred, source: 'query-signal' } : { category: null, source: 'unclassified' }
}

/** Resolves provider categories without defaulting unknown topics to Entertainment. */
export function classifySerpApiDiscoveryCategory({ query, categories, rawCategories = [] }) {
  return classifySerpApiDiscoveryCategoryDetails({ query, categories: Array.isArray(categories) ? categories : [], rawCategories }).category
}

/** Reclassifies persisted normalized discovery evidence using its provider tags. */
export function classifyPersistedSerpApiDiscoveryCategory({ query, categories = [], unmappedCategories = [] }) {
  const mapped = [...categories, ...unmappedCategories.map(mapSerpApiCategory).filter(Boolean)]
  return classifySerpApiDiscoveryCategoryDetails({ query, categories: [...new Set(mapped)], rawCategories: unmappedCategories })
}

/** Maps SerpApi Trending Now data to an internal discovery record; unknown categories remain explicit nulls. */
export function normalizeSerpApiTrendingNow(response, { retrievedAt, geographicScope }) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.trending_searches)) throw new Error('SerpApi Trending Now response must include trending_searches')
  if (!geographicScope || typeof geographicScope !== 'object') throw new Error('SerpApi discovery geographicScope is required')
  const seen = new Set()
  const rawProviderResultCount = response.trending_searches.length
  return response.trending_searches.flatMap((item, index) => {
    const query = text(item?.query, 'SerpApi trending query')
    const normalizedQuery = normalizedDiscoveryQuery(query)
    if (seen.has(normalizedQuery)) return []
    seen.add(normalizedQuery)
    const rawCategories = Array.isArray(item.categories) ? item.categories.map((category) => category?.name).filter((name) => typeof name === 'string') : []
    const categories = rawCategories.map(mapSerpApiCategory).filter(Boolean)
    return [{
      providerId: SERPAPI_TRENDING_NOW_PROVIDER_ID,
      sourceId: response.search_metadata?.id ? `${response.search_metadata.id}:${normalizedQuery}` : normalizedQuery,
      // The source response has no separate ranking field. Its ordered result
      // position is retained for discovery diagnostics and coverage selection.
      providerDiscoveryRank: index + 1,
      normalizedDiscoveryPosition: index + 1,
      rawProviderResultCount,
      query,
      normalizedQuery,
      category: classifySerpApiDiscoveryCategory({ query, categories, rawCategories }),
      categories: [...new Set(categories)],
      unmappedCategories: rawCategories.filter((category) => !mapSerpApiCategory(category)),
      ...(Number.isFinite(item.search_volume) ? { searchVolume: item.search_volume } : {}),
      ...(Number.isFinite(item.increase_percentage) ? { increasePercentage: item.increase_percentage } : {}),
      ...(typeof item.active === 'boolean' ? { active: item.active } : {}),
      ...(timestampFromUnix(item.start_timestamp) ? { startedAt: timestampFromUnix(item.start_timestamp) } : {}),
      ...(timestampFromUnix(item.end_timestamp) ? { endedAt: timestampFromUnix(item.end_timestamp) } : {}),
      ...(Array.isArray(item.trend_breakdown) ? { relatedQueries: item.trend_breakdown.filter((value) => typeof value === 'string') } : {}),
      retrievedAt,
      geographicScope,
    }]
  })
}

export function buildSerpApiTrendingNowUrl({ apiKey, geo, hours, language, onlyActive, categoryId }) {
  const params = new URLSearchParams({ engine: 'google_trends_trending_now', geo: text(geo, 'SerpApi geo'), api_key: text(apiKey, 'SERPAPI_API_KEY') })
  if (hours !== undefined) {
    if (!HOURS.has(hours)) throw new Error('SerpApi hours must be one of 4, 24, 48, or 168')
    params.set('hours', String(hours))
  }
  if (language !== undefined) params.set('hl', text(language, 'SerpApi language'))
  if (onlyActive !== undefined) params.set('only_active', onlyActive ? 'true' : 'false')
  if (categoryId !== undefined) {
    if (!Number.isInteger(categoryId) || categoryId < 0) throw new Error('SerpApi categoryId must be a non-negative integer')
    params.set('category_id', String(categoryId))
  }
  return `${SERPAPI_TRENDING_NOW_ENDPOINT}?${params}`
}

/** Server-only transport. The API key remains in the request URL and is never returned or logged. */
export function createSerpApiTrendingNowClient({ env = process.env, fetchImpl = fetch, now = () => new Date().toISOString(), maxRetries = SERPAPI_DISCOVERY_MAX_RETRIES, retryBaseDelayMs = SERPAPI_DISCOVERY_RETRY_BASE_DELAY_MS, sleep = defaultSleep } = {}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > SERPAPI_DISCOVERY_MAX_RETRIES) throw new Error(`SerpApi discovery maxRetries must be an integer between 0 and ${SERPAPI_DISCOVERY_MAX_RETRIES}`)
  if (!Number.isInteger(retryBaseDelayMs) || retryBaseDelayMs < 1) throw new Error('SerpApi discovery retryBaseDelayMs must be a positive integer')
  if (typeof sleep !== 'function') throw new Error('SerpApi discovery sleep must be a function')
  return {
    async discover({ geo, hours, language, onlyActive, categoryId, geographicScope }) {
      const url = buildSerpApiTrendingNowUrl({ apiKey: requireSerpApiApiKey(env), geo, hours, language, onlyActive, categoryId })
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
          const status = Number.isFinite(response?.status) ? response.status : null
          let body
          try {
            body = await response.json()
          } catch {
            throw malformedResponseError({ geo, status, body: null, classification: 'malformed-json-response' })
          }
          if (!response?.ok) throw discoveryError(responseDiagnostic({ geo, status, body, classification: rateLimited({ status, body }) ? 'rate-limited-response' : 'http-error-response' }))
          if (body?.error || String(body?.search_metadata?.status ?? '').toLocaleLowerCase('en-US') === 'error') {
            throw discoveryError(responseDiagnostic({ geo, status, body, classification: rateLimited({ status, body }) ? 'rate-limited-provider-response' : 'provider-error-payload' }))
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw malformedResponseError({ geo, status, body, classification: 'malformed-response' })
          if (!Object.hasOwn(body, 'trending_searches')) throw malformedResponseError({ geo, status, body, classification: 'missing-trending-searches' })
          if (!Array.isArray(body.trending_searches)) throw malformedResponseError({ geo, status, body, classification: 'malformed-trending-searches' })
          try {
            return normalizeSerpApiTrendingNow(body, { retrievedAt: now(), geographicScope })
          } catch {
            throw malformedResponseError({ geo, status, body, classification: 'malformed-trending-search-item' })
          }
        } catch (caught) {
          const error = caught instanceof LiveProviderError
            ? caught
            : discoveryError(responseDiagnostic({ geo, classification: 'network-failure', network: safeFetchFailure(caught) }))
          const diagnostic = { ...(error.discoveryDiagnostic ?? { geo, classification: 'unknown-discovery-failure' }), attempts: attempt + 1, maxAttempts: maxRetries + 1 }
          error.discoveryDiagnostic = diagnostic
          error.details = JSON.stringify(diagnostic)
          if (!error.retryable || attempt === maxRetries) throw error
          await sleep(retryBaseDelayMs * (2 ** attempt))
        }
      }
    },
  }
}
