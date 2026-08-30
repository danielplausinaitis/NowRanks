import { SupabaseOperationError } from '../ingestion/errorDiagnostics.mjs'

export const DEFAULT_DATA_API_PAGE_SIZE = 1000
export const DEFAULT_IN_FILTER_CHUNK_SIZE = 100

async function requireRows(request, operation, table) {
  const result = await request
  if (result.error) throw new SupabaseOperationError({ operation, table, error: result.error })
  return result.data ?? []
}

/** Fetches every Data API page without assuming a single response contains the dataset. */
export async function fetchAllPages(loadPage, { pageSize = DEFAULT_DATA_API_PAGE_SIZE, maxPages = 10_000 } = {}) {
  const rows = []
  for (let page = 0; page < maxPages; page += 1) {
    const result = await loadPage(page * pageSize, (page + 1) * pageSize - 1)
    rows.push(...result)
    if (result.length < pageSize) return rows
  }
  throw new Error(`Data API pagination exceeded ${maxPages} pages`)
}

function chunks(values, size = DEFAULT_IN_FILTER_CHUNK_SIZE) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size))
}

export function createSupabaseReadRepository(supabase, { pageSize = DEFAULT_DATA_API_PAGE_SIZE, inFilterChunkSize = DEFAULT_IN_FILTER_CHUNK_SIZE } = {}) {
  return {
    async listProvenance({ providerId, dataMode }) {
      return fetchAllPages((from, to) => requireRows(
        supabase.from('source_provenance').select('*').eq('provider_id', providerId).eq('data_mode', dataMode).range(from, to),
        'select page', 'source_provenance',
      ), { pageSize })
    },
    async getLatestObservationDate({ provenanceIds }) {
      const latest = await Promise.all(chunks(provenanceIds, inFilterChunkSize).map(async (ids) => {
        const rows = await requireRows(
          supabase.from('observations').select('observation_date').in('provenance_id', ids).order('observation_date', { ascending: false }).limit(1),
          'select latest date', 'observations',
        )
        return rows[0]?.observation_date
      }))
      return latest.filter(Boolean).sort().at(-1) ?? null
    },
    async listObservations({ provenanceIds, startDate, endDate }) {
      const result = await Promise.all(chunks(provenanceIds, inFilterChunkSize).map((ids) => fetchAllPages((from, to) => requireRows(
        supabase.from('observations').select('*').in('provenance_id', ids).gte('observation_date', startDate).lte('observation_date', endDate).order('observed_at', { ascending: true }).range(from, to),
        'select page', 'observations',
      ), { pageSize })))
      return result.flat()
    },
    async listCandidates({ candidateIds }) {
      if (candidateIds.length === 0) return []
      const result = await Promise.all(chunks(candidateIds, inFilterChunkSize).map((ids) => fetchAllPages((from, to) => requireRows(
        supabase.from('candidates').select('*').in('candidate_id', ids).range(from, to),
        'select page', 'candidates',
      ), { pageSize })))
      return result.flat()
    },
  }
}
