export const WINDOW_DAYS = Object.freeze({ '24H': 1, '7D': 7, '30D': 30, '1Y': 365 })

function assertRow(condition, message) {
  if (!condition) throw new Error(`Malformed persisted data: ${message}`)
}

function mapProvenance(row) {
  assertRow(row?.provenance_id && row.provider_id && row.data_mode, 'source provenance identity is incomplete')
  assertRow(row.geographic_scope && typeof row.geographic_scope === 'object', `provenance ${row.provenance_id} has no geographic scope`)
  assertRow(['live', 'replay', 'test'].includes(row.data_mode), `provenance ${row.provenance_id} has an invalid data mode`)
  assertRow(['comparable', 'not-comparable', 'unknown'].includes(row.cross_query_comparability_status), `provenance ${row.provenance_id} has an invalid comparability status`)
  return {
    providerId: row.provider_id,
    dataMode: row.data_mode,
    sourceObservedAt: row.source_observed_at,
    ingestedAt: row.ingested_at,
    geographicScope: row.geographic_scope,
    ...(row.source_version ? { sourceVersion: row.source_version } : {}),
    ...(row.collection_method ? { collectionMethod: row.collection_method } : {}),
    crossQueryComparability: {
      status: row.cross_query_comparability_status,
      ...(row.cross_query_comparability_basis ? { basis: row.cross_query_comparability_basis } : {}),
    },
  }
}

function mapObservation(row, candidateId) {
  assertRow(row?.candidate_id === candidateId && row.observation_date && row.observed_at, `observation identity is incomplete for ${candidateId}`)
  if (row.availability === 'available') {
    assertRow(typeof row.interest_value === 'number' && Number.isFinite(row.interest_value) && row.interest_value >= 0, `available observation for ${candidateId} has invalid interest`)
    return { candidateId, date: row.observation_date, observedAt: row.observed_at, availability: 'available', interest: row.interest_value }
  }
  assertRow(row.availability === 'missing' && row.interest_value === null && row.missing_reason, `missing observation for ${candidateId} is not NULL with a reason`)
  return { candidateId, date: row.observation_date, observedAt: row.observed_at, availability: 'missing', interest: null, missingReason: row.missing_reason }
}

/** Reconstructs canonical SearchTopicData without changing replay/live provenance. */
export function reconstructPersistedTopicData({ candidates, provenances, observations }) {
  const candidateById = new Map(candidates.map((row) => [row.candidate_id, row]))
  const provenanceById = new Map(provenances.map((row) => [row.provenance_id, row]))
  const grouped = new Map()

  for (const observation of observations) {
    const candidate = candidateById.get(observation.candidate_id)
    const provenance = provenanceById.get(observation.provenance_id)
    assertRow(candidate, `observation references missing candidate ${observation.candidate_id}`)
    assertRow(provenance, `observation references missing provenance ${observation.provenance_id}`)
    const prior = grouped.get(observation.candidate_id)
    if (prior && prior.provenance_id !== observation.provenance_id) {
      throw new Error(`Malformed persisted data: candidate ${observation.candidate_id} has multiple provenance records in one read range`)
    }
    grouped.set(observation.candidate_id, { candidate, provenance_id: observation.provenance_id, observations: [...(prior?.observations ?? []), observation] })
  }

  return [...grouped.values()].map(({ candidate, provenance_id, observations: rows }) => {
    assertRow(candidate.query_text && candidate.normalized_query && candidate.category, `candidate ${candidate.candidate_id} identity is incomplete`)
    return {
      id: candidate.candidate_id,
      topic: candidate.query_text,
      normalizedQuery: candidate.normalized_query,
      category: candidate.category,
      provenance: mapProvenance(provenanceById.get(provenance_id)),
      observations: rows.map((row) => mapObservation(row, candidate.candidate_id)),
    }
  })
}

function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

function startDateForWindow(endDate, window) {
  const days = WINDOW_DAYS[window]
  if (!days) throw new Error(`Unsupported ranking window: ${window}`)
  const end = new Date(`${endDate}T00:00:00.000Z`)
  if (Number.isNaN(end.getTime())) throw new Error(`Invalid read end date: ${endDate}`)
  end.setUTCDate(end.getUTCDate() - (days - 1))
  return formatDate(end)
}

function previousDate(date) {
  const result = new Date(`${date}T00:00:00.000Z`)
  result.setUTCDate(result.getUTCDate() - 1)
  return formatDate(result)
}

/** Reads only the selected ranking window and returns canonical SearchTopicData. */
export async function readPersistedTopicData({ repository, providerId, dataMode, window = '1Y', endDate, includePrevious = false }) {
  if (!repository || !providerId || !dataMode) throw new Error('Repository, providerId, and dataMode are required')
  const provenances = await repository.listProvenance({ providerId, dataMode })
  if (provenances.length === 0) return { data: [], startDate: null, endDate: null, provenanceCount: 0, observationCount: 0 }
  const provenanceIds = provenances.map((row) => row.provenance_id)
  const effectiveEndDate = endDate ?? await repository.getLatestObservationDate({ provenanceIds })
  if (!effectiveEndDate) return { data: [], startDate: null, endDate: null, provenanceCount: provenances.length, observationCount: 0 }
  const startDate = startDateForWindow(effectiveEndDate, window)
  const comparisonEndDate = includePrevious ? previousDate(effectiveEndDate) : null
  // Current and previous windows overlap by all but one daily observation. Read their
  // combined bounded range once, then let the application service derive each cohort.
  const readStartDate = comparisonEndDate ? startDateForWindow(comparisonEndDate, window) : startDate
  const observations = await repository.listObservations({ provenanceIds, startDate: readStartDate, endDate: effectiveEndDate })
  const candidates = await repository.listCandidates({ candidateIds: [...new Set(observations.map((row) => row.candidate_id))] })
  return {
    data: reconstructPersistedTopicData({ candidates, provenances, observations }),
    startDate,
    endDate: effectiveEndDate,
    ...(comparisonEndDate ? { comparisonEndDate, readStartDate } : {}),
    provenanceCount: provenances.length,
    observationCount: observations.length,
  }
}
