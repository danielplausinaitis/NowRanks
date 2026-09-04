import { CATEGORIES } from '../../shared/categories.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { createDataForSeoTrendsClient, normalizeDataForSeoMeasurement } from '../live/dataForSeoTrends.mjs'
import { createLiveTrendProviderAdapter } from '../live/providerAdapter.mjs'

function normalizedQuery(query) { return query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') }

async function main() {
  try {
    const keywords = process.argv.slice(2)
    const category = process.env.LIVE_MEASUREMENT_CATEGORY
    const locationCode = process.env.DATAFORSEO_LOCATION_CODE ? Number(process.env.DATAFORSEO_LOCATION_CODE) : undefined
    const locationName = process.env.DATAFORSEO_LOCATION_NAME || undefined
    if (!CATEGORIES.includes(category)) throw new Error(`LIVE_MEASUREMENT_CATEGORY must be one of: ${CATEGORIES.join(', ')}`)
    if (keywords.length === 0) throw new Error('Supply one to five measurement keywords after --')
    const measured = await createDataForSeoTrendsClient().measure({ keywords, locationCode, locationName, dateFrom: process.env.DATAFORSEO_DATE_FROM || undefined, dateTo: process.env.DATAFORSEO_DATE_TO || undefined })
    const data = normalizeDataForSeoMeasurement({ response: measured.response, candidates: keywords.map((query) => ({ query, normalizedQuery: normalizedQuery(query), category })), geographicScope: { kind: 'country', ...(locationName ? { label: locationName } : {}) }, retrievedAt: measured.retrievedAt, adapter: createLiveTrendProviderAdapter({ providerId: 'dataforseo-trends' }) })
    console.log('NowRanks live measurement check')
    console.log('LIVE EXTERNAL DATA — NOT PERSISTED; no Supabase writes or ingestion occurred.')
    console.log(`Canonical candidates: ${data.length}; observations: ${data.reduce((count, topic) => count + topic.observations.length, 0)}; comparability: single request only`)
  } catch (error) {
    console.error(`NowRanks live measurement check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}
void main()
