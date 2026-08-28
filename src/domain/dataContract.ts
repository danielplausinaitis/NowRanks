import type { SearchTopic, SearchTopicData, TopicObservation } from './types'

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
const isTimestamp = (value: string) => !Number.isNaN(Date.parse(value))

/** Reject malformed canonical observations before they can reach the scoring engine. */
export function assertValidObservation(observation: TopicObservation): void {
  if (!observation.candidateId.trim()) throw new Error('Observation candidateId is required')
  if (!isIsoDate(observation.date)) throw new Error(`Observation has an invalid date: ${observation.date}`)
  if (!isTimestamp(observation.observedAt)) throw new Error(`Observation has an invalid timestamp: ${observation.observedAt}`)

  if (observation.availability === 'available') {
    if (!Number.isFinite(observation.interest) || observation.interest < 0) throw new Error('Available interest must be a finite non-negative number')
    return
  }

  if (observation.interest !== null) throw new Error('Missing interest must be represented as null, not zero')
}

function assertValidCandidate(candidate: SearchTopic): void {
  if (!candidate.id.trim() || !candidate.topic.trim() || !candidate.normalizedQuery.trim()) throw new Error('Candidate identity is incomplete')
  const provenance = candidate.provenance
  if (!provenance.providerId.trim()) throw new Error('Candidate provenance requires a providerId')
  if (!isTimestamp(provenance.sourceObservedAt) || !isTimestamp(provenance.ingestedAt)) throw new Error('Candidate provenance timestamps must be valid')
}

/**
 * Ranking requires complete, comparable canonical data. Missing values are never converted to zero,
 * and sources that cannot compare values across queries are rejected before normalization.
 */
export function assertScorableTopicData(data: SearchTopicData[]): void {
  for (const candidate of data) {
    assertValidCandidate(candidate)
    if (candidate.provenance.crossQueryComparability.status !== 'comparable') {
      throw new Error(`Candidate ${candidate.id} cannot be scored because ${candidate.provenance.providerId} is not cross-query comparable`)
    }
    for (const observation of candidate.observations) {
      assertValidObservation(observation)
      if (observation.candidateId !== candidate.id) throw new Error(`Observation candidateId does not match ${candidate.id}`)
      if (observation.availability === 'missing') throw new Error(`Candidate ${candidate.id} has missing interest data and cannot be scored`)
    }
  }
}
