import { createHash } from 'node:crypto'

// v2 adds explicit gap/resume decisions while retaining the v1 overlap thresholds.
export const CANONICAL_ATTENTION_ALGORITHM_VERSION = 'overlap-align-v2'
export const CANONICAL_ATTENTION_METRIC = 'dataforseo-trends-canonical-attention-v1'
export const ALIGNMENT_MIN_PROVIDER_VALUE = 10
export const ALIGNMENT_MIN_OVERLAPS = 3

function median(values) { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
function stableId(value) { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function normalizedTimestamp(value) {
  const timestamp = Date.parse(value)
  if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  // Keep the pure aligner usable with opaque deterministic test identifiers; production
  // provider/database timestamps are ISO instants and always take the canonical branch above.
  return typeof value === 'string' && value ? value : null
}
function confidence(overlaps, relativeMad) {
  if (overlaps >= 4 && relativeMad <= 0.08) return 'high'
  if (overlaps >= ALIGNMENT_MIN_OVERLAPS && relativeMad <= 0.15) return 'medium'
  return 'rejected'
}

/**
 * Aligns a new independently-normalized curve directly against immutable canonical
 * overlap points. It never chains scale factors and never overwrites old points.
 */
export function alignCanonicalAttention({ canonicalPoints, providerPoints, segmentId = null }) {
  const canonical = new Map((canonicalPoints ?? [])
    .filter((point) => Number.isFinite(point.value) && point.value > 0 && normalizedTimestamp(point.observedAt))
    .map((point) => [normalizedTimestamp(point.observedAt), point.value]))
  const provider = (providerPoints ?? []).map((point) => ({ ...point, observedAt: normalizedTimestamp(point.observedAt) })).filter((point) => point.observedAt)
  const raw = provider.filter((point) => point.availability !== 'missing' && Number.isFinite(point.value) && point.value > 0)
  if (!canonical.size) {
    if (!raw.length) return { accepted: false, reason: 'no-valid-provider-points', confidence: 'rejected', alignedNewPoints: [], totalTimestampOverlap: 0, availableOverlap: 0, strongUsableOverlap: 0, weakOverlapRejected: 0, zeroOverlapRejected: 0, missingOverlapRejected: 0, outlierOverlapRejected: 0 }
    const bootstrapSegment = segmentId ?? `bootstrap-${stableId(raw[0].observedAt)}`
    return { accepted: true, reason: 'bootstrap', confidence: 'high', scaleFactor: 1, usableOverlapCount: 0, rejectedOverlapCount: 0, dispersion: 0, segmentId: bootstrapSegment, alignedNewPoints: raw.map((point) => ({ observedAt: point.observedAt, canonicalAttention: point.value, sourceValue: point.value, segmentId: bootstrapSegment })) }
  }
  const ratios = []; let totalTimestampOverlap = 0; let availableOverlap = 0; let weakOverlapRejected = 0; let zeroOverlapRejected = 0; let missingOverlapRejected = 0
  for (const point of provider) {
    const existing = canonical.get(point.observedAt)
    if (existing === undefined) continue
    totalTimestampOverlap += 1
    if (point.availability === 'missing' || !Number.isFinite(point.value)) { missingOverlapRejected += 1; continue }
    if (point.value === 0) { zeroOverlapRejected += 1; continue }
    if (point.value < 0) { missingOverlapRejected += 1; continue }
    availableOverlap += 1
    if (point.value < ALIGNMENT_MIN_PROVIDER_VALUE) { weakOverlapRejected += 1; continue }
    ratios.push(existing / point.value)
  }
  const rejectedOverlapCount = weakOverlapRejected + zeroOverlapRejected + missingOverlapRejected
  const baseDiagnostics = { totalTimestampOverlap, availableOverlap, strongUsableOverlap: ratios.length, weakOverlapRejected, zeroOverlapRejected, missingOverlapRejected }
  // Preserve direct-overlap diagnostics even when every provider value is missing or
  // zero. This is essential evidence that a later retry may still resume the regime.
  if (!raw.length) return { accepted: false, reason: 'no-valid-provider-points', confidence: 'rejected', usableOverlapCount: 0, rejectedOverlapCount, overlapCount: totalTimestampOverlap, outlierOverlapRejected: 0, ...baseDiagnostics, alignedNewPoints: [] }
  if (ratios.length < ALIGNMENT_MIN_OVERLAPS) return { accepted: false, reason: rejectedOverlapCount > 0 ? 'weak-signal' : 'insufficient-overlap', confidence: 'rejected', usableOverlapCount: ratios.length, rejectedOverlapCount, overlapCount: totalTimestampOverlap, outlierOverlapRejected: 0, ...baseDiagnostics, alignedNewPoints: [] }
  const scaleFactor = median(ratios)
  const mad = median(ratios.map((ratio) => Math.abs(ratio - scaleFactor)))
  const dispersion = mad / scaleFactor
  const alignmentConfidence = confidence(ratios.length, dispersion)
  const outlierOverlapRejected = ratios.filter((ratio) => Math.abs(ratio - scaleFactor) / scaleFactor > 0.15).length
  if (alignmentConfidence === 'rejected') return { accepted: false, reason: 'high-dispersion', confidence: alignmentConfidence, scaleFactor, usableOverlapCount: ratios.length, rejectedOverlapCount, overlapCount: totalTimestampOverlap, dispersion, outlierOverlapRejected, ...baseDiagnostics, alignedNewPoints: [] }
  const alignedSegment = segmentId ?? `aligned-${stableId(`${raw[0].observedAt}:${scaleFactor}`)}`
  return { accepted: true, reason: null, confidence: alignmentConfidence, scaleFactor, usableOverlapCount: ratios.length, rejectedOverlapCount, overlapCount: totalTimestampOverlap, dispersion, outlierOverlapRejected, ...baseDiagnostics, segmentId: alignedSegment, alignedNewPoints: raw.filter((point) => !canonical.has(point.observedAt)).map((point) => ({ observedAt: point.observedAt, canonicalAttention: point.value * scaleFactor, sourceValue: point.value, segmentId: alignedSegment })) }
}
