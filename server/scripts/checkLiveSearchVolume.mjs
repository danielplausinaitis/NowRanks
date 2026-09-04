import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'
import { assessSearchVolumeComparability, createDataForSeoSearchVolumeClient, normalizeDataForSeoSearchVolume } from '../live/dataForSeoSearchVolume.mjs'

function optionalInteger(value, name) {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`)
  return number
}

function optionalBoolean(value, name) {
  if (value === undefined || value === '') return undefined
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`)
  return value === 'true'
}

async function main() {
  try {
    const keywords = process.argv.slice(2)
    if (keywords.length === 0) throw new Error('Supply one to 1000 Search Volume keywords after --')
    const locationCode = optionalInteger(process.env.DATAFORSEO_LOCATION_CODE, 'DATAFORSEO_LOCATION_CODE')
    const locationName = process.env.DATAFORSEO_LOCATION_NAME || undefined
    const locationCoordinate = process.env.DATAFORSEO_LOCATION_COORDINATE || undefined
    const request = {
      keywords,
      locationCode,
      locationName,
      locationCoordinate,
      languageCode: process.env.DATAFORSEO_LANGUAGE_CODE || undefined,
      languageName: process.env.DATAFORSEO_LANGUAGE_NAME || undefined,
      dateFrom: process.env.DATAFORSEO_VOLUME_DATE_FROM || undefined,
      dateTo: process.env.DATAFORSEO_VOLUME_DATE_TO || undefined,
      searchPartners: optionalBoolean(process.env.DATAFORSEO_SEARCH_PARTNERS, 'DATAFORSEO_SEARCH_PARTNERS'),
    }
    const result = await createDataForSeoSearchVolumeClient().lookup(request)
    const geographicScope = locationName
      ? { kind: 'country', label: locationName }
      : { kind: 'custom', label: locationCoordinate ?? `DataForSEO location code ${locationCode}` }
    const records = normalizeDataForSeoSearchVolume({ response: result.response, retrievedAt: result.retrievedAt, geographicScope })
    const comparability = assessSearchVolumeComparability([result.task])
    console.log('NowRanks live Search Volume check')
    console.log('LIVE EXTERNAL DATA — NOT PERSISTED; no Supabase writes or ingestion occurred.')
    console.table(records.map((record) => ({
      keyword: record.query,
      searchVolume: record.searchVolume,
      monthlyHistory: record.monthlyHistory?.length ?? 0,
      geography: geographicScope.label,
      comparability: comparability.status,
    })))
  } catch (error) {
    console.error(`NowRanks live Search Volume check failed: ${formatErrorDiagnostics(error)}`)
    process.exitCode = 1
  }
}
void main()
