import { createHash } from 'node:crypto'
import { stableUuid } from '../ingestion/persistence.mjs'
import { alignCanonicalAttention, CANONICAL_ATTENTION_ALGORITHM_VERSION, CANONICAL_ATTENTION_METRIC } from './canonicalAttentionAlignment.mjs'
import { canonicalQueryFingerprint, comparabilityFingerprint, utcSchedulerSlot } from './historicalVault.mjs'

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value ?? null
}

function segmentId(identity) {
  return `segment-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
}

function timestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function latestPointAt(points) {
  return points.reduce((latest, point) => Math.max(latest, timestamp(point.observed_at ?? point.observedAt) ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY)
}

function hasUsableProviderPoint(points) {
  return points.some((point) => point.availability !== 'missing' && Number.isFinite(point.value) && point.value > 0)
}

function compareSegmentAttempts(left, right) {
  // An accepted direct alignment is always safer than a rejected one. Otherwise use
  // the most evidence, then the most recent segment, for deterministic diagnostics.
  if (left.result.accepted !== right.result.accepted) return left.result.accepted ? -1 : 1
  if ((left.result.strongUsableOverlap ?? 0) !== (right.result.strongUsableOverlap ?? 0)) return (right.result.strongUsableOverlap ?? 0) - (left.result.strongUsableOverlap ?? 0)
  if ((left.result.totalTimestampOverlap ?? 0) !== (right.result.totalTimestampOverlap ?? 0)) return (right.result.totalTimestampOverlap ?? 0) - (left.result.totalTimestampOverlap ?? 0)
  return right.latestAt - left.latestAt
}

function rawCurve(history) {
  return (history.observations ?? []).map((point) => ({
    observedAt: point.observedAt,
    value: point.availability === 'available' && Number.isFinite(point.interest) ? point.interest : null,
    availability: point.availability,
    missingReason: point.missingReason ?? null,
    providerBucketStart: point.providerBucketStart ?? null,
    providerBucketEnd: point.providerBucketEnd ?? null,
  }))
}

function seriesIdentity(history, canonicalTargeting = {}) {
  const providerQuery = history.topic ?? history.query
  const queryFingerprint = canonicalQueryFingerprint({ providerQuery, normalizedProviderQuery: history.normalizedQuery })
  const targeting = {
    geographicScope: history.provenance?.geographicScope ?? null,
    historyRequest: history.historyRequest ?? null,
    locationCode: canonicalTargeting.locationCode ?? null,
    locationName: canonicalTargeting.locationName ?? null,
    locationCoordinate: canonicalTargeting.locationCoordinate ?? null,
    languageCode: canonicalTargeting.languageCode ?? null,
    languageName: canonicalTargeting.languageName ?? null,
    queryMode: history.provenance?.collectionMethod ?? 'dataforseo-trends-explore-live',
    sourceVersion: history.provenance?.sourceVersion ?? null,
  }
  const seriesKey = comparabilityFingerprint({
    providerId: history.provenance?.providerId ?? 'dataforseo-trends', metricKey: CANONICAL_ATTENTION_METRIC,
    metricVersion: 1, unit: 'provider-relative-trends-interest', geographicScope: targeting.geographicScope,
    language: targeting.languageCode ?? targeting.languageName ?? null,
    targeting, queryMode: targeting.queryMode, measurementHorizon: 'past_day',
    normalizationScope: 'independently-normalized-dataforseo-trends-curve', queryFingerprint,
  })
  return { providerQuery, queryFingerprint, targeting: stable(targeting), seriesKey }
}

/**
 * Builds additive canonical-attention writes from the raw parsed 24H DataForSEO curve.
 * Existing rows are passed in by normalized query so this remains a pure, batch-friendly plan.
 */
export function buildCanonicalAttentionPersistencePlan({ histories, candidateIdByQuery, existingByQuery = new Map(), runId, scoredAt, slotMinutes = 240, canonicalTargeting = {} }) {
  const empty = { artifacts: [], alignments: [], points: [], diagnostics: { eligibleCandidates: 0, bootstrapped: 0, aligned: 0, rejected: 0, rejectionReasons: {}, rawArtifacts: 0, newPoints: 0, failures: 0 } }
  if (!Array.isArray(histories)) throw new Error('Canonical histories must be an array')
  const slotAt = utcSchedulerSlot(scoredAt, slotMinutes)
  for (const history of histories) {
    if (history?.historyRequest?.timeRange !== 'past_day' || history?.provenance?.providerId !== 'dataforseo-trends') continue
    const candidateId = candidateIdByQuery.get(history.normalizedQuery)
    if (!candidateId) continue
    empty.diagnostics.eligibleCandidates += 1
    try {
      const identity = seriesIdentity(history, canonicalTargeting)
      const artifactId = stableUuid(`canonical-curve:${runId}:${candidateId}:dataforseo-trends:past_day`)
      const artifact = {
        artifact_id: artifactId, ingestion_run_id: runId, candidate_id: candidateId,
        provider_id: 'dataforseo-trends', provider_query: identity.providerQuery, query_fingerprint: identity.queryFingerprint,
        slot_at: slotAt, retrieved_at: history.retrievedAt ?? scoredAt, targeting: identity.targeting,
        request_window: 'past_day', normalization_scope: 'independently-normalized-dataforseo-trends-curve',
        algorithm_version: CANONICAL_ATTENTION_ALGORITHM_VERSION, raw_curve: rawCurve(history),
      }
      empty.artifacts.push(artifact); empty.diagnostics.rawArtifacts += 1
      const candidates = (existingByQuery.get(history.normalizedQuery) ?? []).filter((point) => point.series_key === identity.seriesKey)
      const curve = rawCurve(history)
      const bySegment = new Map()
      for (const point of candidates) {
        if (!bySegment.has(point.segment_id)) bySegment.set(point.segment_id, [])
        bySegment.get(point.segment_id).push(point)
      }
      const attempts = [...bySegment.entries()].map(([existingSegmentId, points]) => ({
        segmentId: existingSegmentId,
        points,
        latestAt: latestPointAt(points),
        result: alignCanonicalAttention({ canonicalPoints: points.map((point) => ({ observedAt: point.observed_at, value: point.canonical_attention })), providerPoints: curve, segmentId: existingSegmentId }),
      })).filter((attempt) => (attempt.result.totalTimestampOverlap ?? attempt.result.overlapCount ?? 0) > 0)
      const latestExistingAt = latestPointAt(candidates)
      const gapSinceLastCanonicalPoint = Number.isFinite(latestExistingAt) && Number.isFinite(timestamp(scoredAt))
        ? Math.max(0, timestamp(scoredAt) - latestExistingAt) : null
      const selectedAttempt = attempts.sort(compareSegmentAttempts)[0] ?? null
      const initialSegment = segmentId(`${candidateId}:${identity.seriesKey}`)
      let result
      let canResumeExistingSegment = false
      let resumeReason
      let newSegmentRequired = false
      if (selectedAttempt) {
        result = selectedAttempt.result
        canResumeExistingSegment = result.accepted
        resumeReason = result.accepted ? 'accepted-trustworthy-timestamp-overlap' : 'timestamp-overlap-not-yet-trustworthy'
      } else if (!candidates.length) {
        result = alignCanonicalAttention({ canonicalPoints: [], providerPoints: curve, segmentId: initialSegment })
        resumeReason = result.accepted ? 'initial-bootstrap' : 'awaiting-first-usable-curve'
      } else if (hasUsableProviderPoint(curve)) {
        // No direct canonical timestamp survives in this provider curve. A fresh ruler
        // is allowed only as a distinct regime; no factor is inferred across the gap.
        newSegmentRequired = true
        const newSegment = segmentId(`${candidateId}:${identity.seriesKey}:${artifactId}`)
        result = alignCanonicalAttention({ canonicalPoints: [], providerPoints: curve, segmentId: newSegment })
        resumeReason = 'no-timestamp-overlap-new-segment'
      } else {
        // A missing/zero-only curve cannot establish a new regime, even after a long gap.
        const latest = [...bySegment.entries()].sort(([, left], [, right]) => latestPointAt(right) - latestPointAt(left))[0]
        result = alignCanonicalAttention({ canonicalPoints: latest?.[1] ?? [], providerPoints: curve, segmentId: latest?.[0] ?? initialSegment })
        resumeReason = 'awaiting-usable-provider-points'
      }
      // Schema requires a segment on every diagnostic. An initial all-missing curve
      // gets an unavailable placeholder, while a later failed attempt names the
      // existing regime it is still trying to resume.
      const latestSegmentId = [...bySegment.entries()].sort(([, left], [, right]) => latestPointAt(right) - latestPointAt(left))[0]?.[0] ?? null
      const alignmentSegment = result.segmentId ?? selectedAttempt?.segmentId ?? latestSegmentId ?? `unavailable-${artifactId.slice(0, 18)}`
      const alignmentId = stableUuid(`canonical-alignment:${artifactId}`)
      empty.alignments.push({
        alignment_id: alignmentId, candidate_id: candidateId, source_artifact_id: artifactId, series_key: identity.seriesKey,
        segment_id: alignmentSegment, scale_factor: result.scaleFactor ?? null, usable_overlap_count: result.usableOverlapCount ?? 0,
        rejected_overlap_count: result.rejectedOverlapCount ?? 0, dispersion: result.dispersion ?? null,
        total_timestamp_overlap: result.totalTimestampOverlap ?? result.overlapCount ?? 0,
        available_overlap_count: result.availableOverlap ?? 0,
        strong_usable_overlap_count: result.strongUsableOverlap ?? result.usableOverlapCount ?? 0,
        weak_overlap_rejected: result.weakOverlapRejected ?? 0,
        zero_overlap_rejected: result.zeroOverlapRejected ?? 0,
        missing_overlap_rejected: result.missingOverlapRejected ?? 0,
        outlier_overlap_rejected: result.outlierOverlapRejected ?? 0,
        confidence: result.confidence ?? 'rejected', accepted: result.accepted, reason: result.reason ?? null,
        gap_since_last_canonical_point_ms: gapSinceLastCanonicalPoint,
        can_resume_existing_segment: canResumeExistingSegment,
        resume_reason: resumeReason,
        new_segment_required: newSegmentRequired,
        algorithm_version: CANONICAL_ATTENTION_ALGORITHM_VERSION,
      })
      if (!result.accepted) {
        empty.diagnostics.rejected += 1
        empty.diagnostics.rejectionReasons[result.reason ?? 'unknown'] = (empty.diagnostics.rejectionReasons[result.reason ?? 'unknown'] ?? 0) + 1
        continue
      }
      if (result.reason === 'bootstrap') empty.diagnostics.bootstrapped += 1
      else empty.diagnostics.aligned += 1
      for (const point of result.alignedNewPoints) {
        empty.points.push({
          point_id: stableUuid(`canonical-point:${candidateId}:${identity.seriesKey}:${point.segmentId}:${point.observedAt}`),
          candidate_id: candidateId, series_key: identity.seriesKey, segment_id: point.segmentId, observed_at: point.observedAt,
          canonical_attention: point.canonicalAttention, source_artifact_id: artifactId, alignment_confidence: result.confidence,
          algorithm_version: CANONICAL_ATTENTION_ALGORITHM_VERSION,
        })
      }
    } catch {
      // A malformed candidate must retain the ingestion and every other candidate's evidence.
      empty.diagnostics.failures += 1
    }
  }
  empty.diagnostics.newPoints = empty.points.length
  return empty
}
