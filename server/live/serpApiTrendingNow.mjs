import { LiveProviderError } from './providerAdapter.mjs'

export const SERPAPI_TRENDING_NOW_ENDPOINT = 'https://serpapi.com/search.json'
const HOURS = new Set([4, 24, 48, 168])
const CATEGORY_MAP = Object.freeze({
  technology: 'Technology', games: 'Gaming', gaming: 'Gaming', sports: 'Sports', travel: 'Travel', finance: 'Finance',
  entertainment: 'Entertainment', 'arts & entertainment': 'Entertainment', autos: 'Cars', 'autos & vehicles': 'Cars', cars: 'Cars', business: 'Business', health: 'Health',
})

function safeFetchFailure(error) {
  const cause = error && typeof error === 'object' ? error.cause : undefined
  const causeCode = cause && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : undefined
  const causeMessage = cause && typeof cause === 'object' && typeof cause.message === 'string' ? cause.message : undefined
  const safeCauseMessage = causeMessage && !/https?:|api[_-]?key|authorization|credential|password|secret/i.test(causeMessage)
  return {
    message: error instanceof Error ? error.message : 'fetch failed',
    ...(causeCode ? { code: causeCode } : {}),
    ...(safeCauseMessage ? { details: causeMessage } : {}),
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

function responseError(response, provider) {
  return new LiveProviderError(provider, { message: response?.error ?? response?.search_metadata?.status ?? 'Provider returned an invalid response' })
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

/** Maps SerpApi Trending Now data to an internal discovery record; unknown categories remain explicit nulls. */
export function normalizeSerpApiTrendingNow(response, { retrievedAt, geographicScope }) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.trending_searches)) throw new Error('SerpApi Trending Now response must include trending_searches')
  if (!geographicScope || typeof geographicScope !== 'object') throw new Error('SerpApi discovery geographicScope is required')
  const seen = new Set()
  return response.trending_searches.flatMap((item) => {
    const query = text(item?.query, 'SerpApi trending query')
    const normalizedQuery = normalizedDiscoveryQuery(query)
    if (seen.has(normalizedQuery)) return []
    seen.add(normalizedQuery)
    const rawCategories = Array.isArray(item.categories) ? item.categories.map((category) => category?.name).filter((name) => typeof name === 'string') : []
    const categories = rawCategories.map(mapSerpApiCategory).filter(Boolean)
    return [{
      providerId: 'serpapi-google-trends-trending-now',
      sourceId: response.search_metadata?.id ? `${response.search_metadata.id}:${normalizedQuery}` : normalizedQuery,
      query,
      normalizedQuery,
      category: categories[0] ?? null,
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
export function createSerpApiTrendingNowClient({ env = process.env, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  return {
    async discover({ geo, hours, language, onlyActive, categoryId, geographicScope }) {
      const url = buildSerpApiTrendingNowUrl({ apiKey: requireSerpApiApiKey(env), geo, hours, language, onlyActive, categoryId })
      let response
      try {
        response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
        const body = await response.json()
        if (!response.ok || body.search_metadata?.status === 'Error' || body.error) throw responseError(body, 'serpapi-google-trends-trending-now')
        return normalizeSerpApiTrendingNow(body, { retrievedAt: now(), geographicScope })
      } catch (error) {
        if (error instanceof LiveProviderError) throw error
        throw new LiveProviderError('serpapi-google-trends-trending-now', safeFetchFailure(error))
      }
    },
  }
}
