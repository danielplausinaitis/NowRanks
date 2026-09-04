import { CATEGORIES } from '../../shared/categories.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'

const CATEGORY_SET = new Set(CATEGORIES)
const MISSING_REASONS = new Set(['not-reported', 'source-unavailable', 'out-of-range', 'redacted'])
const COMPARABILITY_STATUSES = new Set(['comparable', 'not-comparable', 'unknown'])

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Live provider response ${label} is required`)
  return value.trim()
}

function requireTimestamp(value, label) {
  const timestamp = requireText(value, label)
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`Live provider response ${label} must be a valid timestamp`)
  return timestamp
}

function normalizeQuery(query) {
  return requireText(query, 'topic query').replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function normalizeObservation({ observation, candidateId, seen }) {
  const observedAt = requireTimestamp(observation?.observedAt, 'observation observedAt')
  const duplicateKey = `${candidateId}\u0000${observedAt}`
  if (seen.has(duplicateKey)) throw new Error(`Live provider response has a duplicate observation for ${candidateId} at ${observedAt}`)
  seen.add(duplicateKey)
  const date = new Date(observedAt).toISOString().slice(0, 10)
  if (observation.measurement === null) {
    if (!MISSING_REASONS.has(observation.missingReason)) throw new Error(`Live provider response missing measurement for ${candidateId} requires a supported missingReason`)
    return { candidateId, date, observedAt, availability: 'missing', interest: null, missingReason: observation.missingReason }
  }
  if (!Number.isFinite(observation.measurement) || observation.measurement < 0) {
    throw new Error(`Live provider response measurement for ${candidateId} must be a finite non-negative number or null`)
  }
  return { candidateId, date, observedAt, availability: 'available', interest: observation.measurement }
}

/**
 * Server-only boundary for a legitimate provider integration. It accepts a deliberately
 * small provider-shaped payload and emits the existing canonical SearchTopicData shape.
 * It performs no HTTP requests and never substitutes replay data for a live failure.
 */
export function createLiveTrendProviderAdapter({ providerId, mapCategory = (value) => value, now = () => new Date().toISOString() }) {
  const normalizedProviderId = requireText(providerId, 'providerId')
  if (normalizedProviderId.includes('replay')) throw new Error('A live provider adapter cannot use a replay providerId')

  return {
    providerId: normalizedProviderId,
    normalize(payload, { retrievedAt = now() } = {}) {
      if (!payload || typeof payload !== 'object') throw new Error('Live provider response must be an object')
      const sourceObservedAt = requireTimestamp(payload.sourceObservedAt, 'sourceObservedAt')
      const ingestedAt = requireTimestamp(retrievedAt, 'retrievedAt')
      if (!payload.geographicScope || typeof payload.geographicScope !== 'object') throw new Error('Live provider response geographicScope is required')
      if (!COMPARABILITY_STATUSES.has(payload.crossQueryComparability?.status)) throw new Error('Live provider response must explicitly declare cross-query comparability')
      if (!Array.isArray(payload.topics) || payload.topics.length === 0) throw new Error('Live provider response must include at least one topic')

      const seenCandidates = new Set()
      const seenObservations = new Set()
      return payload.topics.map((topic) => {
        const query = requireText(topic?.query, 'topic query')
        const normalizedQuery = topic.normalizedQuery ? normalizeQuery(topic.normalizedQuery) : normalizeQuery(query)
        const sourceId = topic.sourceId === undefined ? null : requireText(topic.sourceId, 'topic sourceId')
        // A provider source ID is durable through candidate_id; do not store a credential or invent one.
        const id = `${normalizedProviderId}:${sourceId ?? normalizedQuery}`
        if (seenCandidates.has(id)) throw new Error(`Live provider response has a duplicate topic identity: ${id}`)
        seenCandidates.add(id)
        const category = mapCategory(topic.category)
        if (!CATEGORY_SET.has(category)) throw new Error(`Live provider response category is missing or unknown for ${id}`)
        if (!Array.isArray(topic.observations) || topic.observations.length === 0) throw new Error(`Live provider response observations are required for ${id}`)
        return {
          id,
          topic: query,
          normalizedQuery,
          category,
          provenance: {
            providerId: normalizedProviderId,
            dataMode: 'live',
            sourceObservedAt,
            ingestedAt,
            geographicScope: payload.geographicScope,
            ...(payload.sourceVersion ? { sourceVersion: requireText(payload.sourceVersion, 'sourceVersion') } : {}),
            collectionMethod: 'legitimate-live-provider-adapter',
            crossQueryComparability: {
              status: payload.crossQueryComparability.status,
              ...(payload.crossQueryComparability.basis ? { basis: requireText(payload.crossQueryComparability.basis, 'cross-query comparability basis') } : {}),
            },
          },
          observations: topic.observations.map((observation) => normalizeObservation({ observation, candidateId: id, seen: seenObservations })),
        }
      })
    },
  }
}

export class LiveProviderError extends Error {
  constructor(providerId, cause) {
    super(`Live provider ${providerId} failed: ${formatErrorDiagnostics(cause)}`)
    this.name = 'LiveProviderError'
  }
}

/** Calls an injected real-provider transport in a future integration; it intentionally has no replay fallback. */
export async function loadLiveTopicData({ adapter, fetchLiveResponse, retrievedAt }) {
  if (!adapter?.providerId || typeof adapter.normalize !== 'function') throw new Error('A live provider adapter is required')
  if (typeof fetchLiveResponse !== 'function') throw new Error(`Live provider ${adapter.providerId} is not configured`)
  try {
    return adapter.normalize(await fetchLiveResponse(), { retrievedAt })
  } catch (error) {
    if (error instanceof LiveProviderError) throw error
    throw new LiveProviderError(adapter.providerId, error)
  }
}
