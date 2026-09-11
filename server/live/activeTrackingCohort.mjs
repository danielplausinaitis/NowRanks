export const DEFAULT_TRACKING_RETENTION_HOURS = 48
export const DEFAULT_CANONICAL_CONTINUITY_RETENTION_HOURS = 168
export const TRACKING_PUBLIC_TOP_LIMIT = 20
export const TRACKING_FRESH_DISCOVERY_RESERVE = 10
export const TRACKING_CANONICAL_CONTINUITY_RESERVE = 15
export const TRACKING_MISSING_RETRY_RESERVE = 5
export const TRACKING_HARD_MAX_PAID_CANDIDATES = 50

function normalized(item) { return item?.normalizedQuery ?? item?.normalized_query ?? null }
function value(item, camel, snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)) { return item?.[camel] ?? item?.[snake] ?? null }
function date(item) { const parsed = Date.parse(item); return Number.isFinite(parsed) ? parsed : null }
function ageHours(item, now) { const then = date(item); const current = date(now); return then === null || current === null ? Infinity : Math.max(0, (current - then) / 3_600_000) }
function candidateFromState(item) {
  return {
    providerId: 'nowranks-active-tracking', sourceId: item.candidateId ?? item.candidate_id,
    query: item.query ?? item.query_text, normalizedQuery: normalized(item), category: item.category ?? 'Uncategorized',
    searchVolume: Number.NaN, increasePercentage: null, active: true, retrievedAt: item.lastPaidAt ?? item.last_paid_at ?? null,
    geographicScope: item.geographicScope ?? null, trackingOnly: true,
  }
}

export function missingRetryDue(item, now, important = false) {
  const streak = Number(value(item, 'consecutiveMissingHistory') ?? 0)
  const last = date(value(item, 'lastPaidAt'))
  if (!Number.isFinite(last)) return true
  const hours = important || streak <= 1 ? 4 : streak === 2 ? 8 : 24
  return date(now) - last >= hours * 3_600_000
}

function hasCanonicalSuccess(item) { return date(value(item, 'lastCanonicalSuccessAt')) !== null }
function continuityEligible(item, now, retentionHours) {
  if (!hasCanonicalSuccess(item) || ageHours(value(item, 'lastCanonicalSuccessAt'), now) > retentionHours) return false
  const streak = Number(value(item, 'consecutiveMissingHistory') ?? 0)
  return streak === 0 || missingRetryDue(item, now)
}
function graceEligible(item, now) { return ageHours(value(item, 'lastPaidAt'), now) <= DEFAULT_TRACKING_RETENTION_HOURS }
function confidenceRank(item) { const confidence = value(item, 'recentAcceptedAlignmentConfidence'); return confidence === 'high' ? 0 : confidence === 'medium' ? 1 : 2 }
function maturity(item) { return Number(value(item, 'canonicalPointCount') ?? 0) }
function publicRank(item) { const rank = Number(value(item, 'publicRank')); return Number.isFinite(rank) ? rank : Infinity }

/** Objective canonical-continuity ordering: mature, high-confidence histories first;
 * among equals, refresh the least-recently-paid one before it drifts stale. */
export function compareCanonicalContinuity(left, right) {
  const leftMature = maturity(left) >= 24 ? 0 : 1; const rightMature = maturity(right) >= 24 ? 0 : 1
  if (leftMature !== rightMature) return leftMature - rightMature
  if (confidenceRank(left) !== confidenceRank(right)) return confidenceRank(left) - confidenceRank(right)
  if (publicRank(left) !== publicRank(right)) return publicRank(left) - publicRank(right)
  const leftPaid = date(value(left, 'lastPaidAt')) ?? Number.NEGATIVE_INFINITY; const rightPaid = date(value(right, 'lastPaidAt')) ?? Number.NEGATIVE_INFINITY
  if (leftPaid !== rightPaid) return leftPaid - rightPaid
  if (maturity(left) !== maturity(right)) return maturity(right) - maturity(left)
  const leftSuccess = date(value(left, 'lastCanonicalSuccessAt')) ?? Number.NEGATIVE_INFINITY; const rightSuccess = date(value(right, 'lastCanonicalSuccessAt')) ?? Number.NEGATIVE_INFINITY
  if (leftSuccess !== rightSuccess) return rightSuccess - leftSuccess
  return String(normalized(left)).localeCompare(String(normalized(right)))
}
// Discovery order is the existing discovery pipeline's priority order; do not replace
// it with a tracking-local ranking.
function sortFresh(discoveries) { return [...discoveries] }

/**
 * Fixed order: Top20, fresh-discovery reserve, bounded canonical continuity, due
 * missing retries, remaining fresh discovery, then grace-only residual capacity.
 */
export function buildActiveTrackingCohort({ discoveries = [], latestPublic = [], tracking = [], maxPaidCandidates = 50, now = new Date().toISOString(), canonicalContinuityRetentionHours = DEFAULT_CANONICAL_CONTINUITY_RETENTION_HOURS }) {
  if (!Number.isInteger(maxPaidCandidates) || maxPaidCandidates < 1 || maxPaidCandidates > TRACKING_HARD_MAX_PAID_CANDIDATES) throw new Error(`Tracking cohort max must be an integer between 1 and ${TRACKING_HARD_MAX_PAID_CANDIDATES}`)
  if (!Number.isInteger(canonicalContinuityRetentionHours) || canonicalContinuityRetentionHours < DEFAULT_TRACKING_RETENTION_HOURS) throw new Error('Canonical continuity retention must be at least generic tracking retention')
  const fresh = new Map(discoveries.map((item) => [normalized(item), item]).filter(([key]) => key))
  const state = new Map(tracking.map((item) => [normalized(item), item]).filter(([key]) => key))
  const publicRows = [...latestPublic].filter((item) => normalized(item)).sort((a, b) => publicRank(a) - publicRank(b))
  const publicSet = new Set(publicRows.slice(0, TRACKING_PUBLIC_TOP_LIMIT).map(normalized))
  const chosen = new Map(); const selected = []
  const counts = { previousTop20: 0, canonicalContinuity: 0, missingHistoryRetries: 0, freshDiscoveries: 0, graceRetained: 0 }
  const add = (item, reason, detail = {}) => {
    const key = normalized(item)
    if (!key || chosen.size >= maxPaidCandidates || chosen.has(key)) return false
    chosen.set(key, fresh.get(key) ?? candidateFromState(item)); counts[reason] += 1
    selected.push({ candidate: item.candidateId ?? item.candidate_id ?? `live:${key}`, query: key, reason, ...detail })
    return true
  }
  const addReserved = (items, reason, limit, detail) => {
    let added = 0
    for (const item of items) {
      if (added >= limit || chosen.size >= maxPaidCandidates) break
      if (add(item, reason, typeof detail === 'function' ? detail(item) : detail)) added += 1
    }
  }
  const freshRows = sortFresh([...fresh.values()])
  const continuity = [...state.values()].filter((item) => continuityEligible(item, now, canonicalContinuityRetentionHours)).sort(compareCanonicalContinuity)
  const missing = [...state.values()].filter((item) => !publicSet.has(normalized(item)) && Number(value(item, 'consecutiveMissingHistory') ?? 0) > 0 && missingRetryDue(item, now))
    .sort((left, right) => Number(value(left, 'consecutiveMissingHistory')) - Number(value(right, 'consecutiveMissingHistory')) || (date(value(left, 'lastPaidAt')) ?? 0) - (date(value(right, 'lastPaidAt')) ?? 0) || String(normalized(left)).localeCompare(String(normalized(right))))

  // Top20 protection intentionally overrides retry backoff: public tracking must not
  // vanish merely because a provider failed a prior collection.
  publicRows.slice(0, TRACKING_PUBLIC_TOP_LIMIT).forEach((item) => add(item, 'previousTop20', { publicRank: publicRank(item) }))
  addReserved(freshRows, 'freshDiscoveries', TRACKING_FRESH_DISCOVERY_RESERVE, { reservedFreshDiscovery: true })
  addReserved(continuity, 'canonicalContinuity', TRACKING_CANONICAL_CONTINUITY_RESERVE, (item) => ({ canonicalPointCount: maturity(item), recentAcceptedAlignmentConfidence: value(item, 'recentAcceptedAlignmentConfidence'), lastCanonicalSuccessAt: value(item, 'lastCanonicalSuccessAt') }))
  addReserved(missing, 'missingHistoryRetries', TRACKING_MISSING_RETRY_RESERVE, (item) => ({ consecutiveMissingHistory: Number(value(item, 'consecutiveMissingHistory') ?? 0) }))
  freshRows.forEach((item) => add(item, 'freshDiscoveries', { reservedFreshDiscovery: false }))
  continuity.forEach((item) => add(item, 'canonicalContinuity', { canonicalPointCount: maturity(item), recentAcceptedAlignmentConfidence: value(item, 'recentAcceptedAlignmentConfidence'), lastCanonicalSuccessAt: value(item, 'lastCanonicalSuccessAt') }))
  const grace = [...state.values()].filter((item) => !publicSet.has(normalized(item)) && !hasCanonicalSuccess(item) && graceEligible(item, now) && (Number(value(item, 'consecutiveMissingHistory') ?? 0) === 0 || missingRetryDue(item, now)))
    .sort((left, right) => (date(value(left, 'lastPaidAt')) ?? Number.NEGATIVE_INFINITY) - (date(value(right, 'lastPaidAt')) ?? Number.NEGATIVE_INFINITY) || String(normalized(left)).localeCompare(String(normalized(right))))
  grace.forEach((item) => add(item, 'graceRetained'))

  const exclusions = []
  for (const [key, item] of state) {
    if (chosen.has(key)) continue
    const streak = Number(value(item, 'consecutiveMissingHistory') ?? 0)
    const reason = streak > 0 && !missingRetryDue(item, now)
      ? 'missing-retry-backoff'
      : hasCanonicalSuccess(item) && !continuityEligible(item, now, canonicalContinuityRetentionHours)
        ? 'canonical-continuity-expired'
        : graceEligible(item, now) ? 'lower-priority-capacity' : 'grace-retention-expired'
    exclusions.push({ candidate: item.candidateId ?? item.candidate_id ?? `live:${key}`, query: key, reason, canonicalPointCount: maturity(item), lastCanonicalSuccessAt: value(item, 'lastCanonicalSuccessAt'), consecutiveMissingHistory: streak })
  }
  for (const [key, item] of fresh) if (!chosen.has(key)) exclusions.push({ candidate: item.candidateId ?? item.candidate_id ?? `live:${key}`, query: key, reason: 'fresh-discovery-capacity' })
  return { candidates: [...chosen.values()], diagnostics: { ...counts, deduplicatedTotal: chosen.size, maxPaidCandidates, canonicalContinuityRetentionHours, freshDiscoveryReserve: Math.min(TRACKING_FRESH_DISCOVERY_RESERVE, maxPaidCandidates), selected, exclusions } }
}
