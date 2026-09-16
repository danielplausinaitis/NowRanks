import { evaluateVaultGrowth, evaluateVaultGrowthByCandidate } from './historicalVaultGrowth.mjs'

const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const RANGE_MS = Object.freeze({ '24H': 24 * 60 * 60_000, '7D': 7 * 24 * 60 * 60_000, '30D': 30 * 24 * 60 * 60_000, '1Y': 365 * 24 * 60 * 60_000 })
export const CANONICAL_PROVIDER_LAG_TOLERANCE_MINUTES = 60

function canonicalMeasurements(rows, slotMinutes) {
  const slotMs = 60 * 60_000
  const latestIdentityByCandidate = new Map()
  for (const row of rows) {
    const existing = latestIdentityByCandidate.get(row.candidate_id)
    if (!existing || Date.parse(row.observed_at) > existing.timestamp) {
      latestIdentityByCandidate.set(row.candidate_id, { seriesKey: row.series_key, segmentId: row.segment_id, timestamp: Date.parse(row.observed_at) })
    }
  }
  return rows
    .filter((row) => {
      const identity = latestIdentityByCandidate.get(row.candidate_id)
      const timestamp = Date.parse(row.observed_at)
      return identity?.seriesKey === row.series_key && identity.segmentId === row.segment_id
        && Number.isFinite(timestamp) && timestamp % slotMs === 0
    })
    .map((row) => ({
      candidate_id: row.candidate_id, slot_at: row.observed_at, observed_at: row.observed_at,
      value: row.canonical_attention, availability: 'available', provider_id: 'nowranks-canonical-attention',
      comparability_key: `${row.series_key}:${row.segment_id}`, comparability_status: 'comparable',
      quality: { growthEligible: true, confidence: row.alignment_confidence },
      series_key: row.series_key, segment_id: row.segment_id,
    }))
}

async function readGrowthMeasurements({ repository, candidateIds, startAt, endAt, slotMinutes, window }) {
  if (repository.listLiveCanonicalAttentionPoints) {
    const canonical = await repository.listLiveCanonicalAttentionPoints({ candidateIds, startAt, endAt })
    // Seven-day exact Growth is canonical-only. Do not substitute another
    // provider-derived vault series when canonical history is absent.
    if (canonical.length || window === '7D') return { source: 'canonical-attention', measurements: canonicalMeasurements(canonical, 60), points: canonical, slotMinutes: 60 }
  }
  const measurements = await repository.listLiveHistoricalVaultMeasurements({ candidateIds, startAt, endAt })
  return { source: 'historical-vault', measurements, points: measurements, slotMinutes }
}

function unavailableStaleCanonical({ latestPointAt, asOf, allowanceMinutes }) {
  return {
    status: 'unavailable', growthPercent: null, growthSource: 'unavailable', confidence: 'unavailable', reason: 'stale-canonical-history',
    latestPointAt, requestedAsOf: asOf, freshnessAllowanceMinutes: allowanceMinutes,
    freshnessAgeMinutes: (Date.parse(asOf) - Date.parse(latestPointAt)) / 60_000,
  }
}

function evaluateCanonicalCoverage({ measurements, candidateIds, window, asOf, schedulerSlotMinutes }) {
  const allowanceMinutes = schedulerSlotMinutes + CANONICAL_PROVIDER_LAG_TOLERANCE_MINUTES
  const byCandidate = new Map(candidateIds.map((candidateId) => [candidateId, []]))
  for (const point of measurements) if (byCandidate.has(point.candidate_id)) byCandidate.get(point.candidate_id).push(point)
  return new Map([...byCandidate].map(([candidateId, points]) => {
    const latest = [...points].sort((left, right) => Date.parse(right.slot_at) - Date.parse(left.slot_at))[0]
    if (!latest) {
      const unavailable = evaluateVaultGrowth({ measurements: points, window, asOf, slotMinutes: 60 })
      return [candidateId, window === '7D' && unavailable.reason === 'no-growth-eligible-measurements'
        ? { ...unavailable, reason: 'no-canonical-history' }
        : unavailable]
    }
    const ageMs = Date.parse(asOf) - Date.parse(latest.slot_at)
    const canonicalContext = { canonicalSegment: latest.segment_id ?? null, recentAlignmentConfidence: latest.quality?.confidence ?? 'unavailable', crossSegmentBlended: false }
    if (ageMs > allowanceMinutes * 60_000) return [candidateId, { ...unavailableStaleCanonical({ latestPointAt: latest.slot_at, asOf, allowanceMinutes }), ...canonicalContext }]
    const result = evaluateVaultGrowth({ measurements: points, window, asOf: latest.slot_at, slotMinutes: 60 })
    return [candidateId, { ...result, ...canonicalContext, requestedAsOf: asOf, asOf: latest.slot_at, latestPointAt: latest.slot_at, freshnessAgeMinutes: Math.max(0, ageMs / 60_000), freshnessAllowanceMinutes: allowanceMinutes }]
  }))
}

export async function readHistoricalVaultCoverage({ repository, candidateIds, window, asOf = new Date().toISOString(), slotMinutes = 240 }) {
  if (!repository?.listLiveHistoricalVaultMeasurements && !repository?.listLiveCanonicalAttentionPoints) throw new Error('A historical vault repository is required')
  if (!WINDOWS.has(window)) throw new Error(`Unsupported vault window: ${window}`)
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) return new Map()
  const end = Date.parse(asOf)
  const historyMs = RANGE_MS[window] * 2
  const result = await readGrowthMeasurements({ repository, candidateIds, startAt: new Date(end - historyMs).toISOString(), endAt: new Date(end + 1).toISOString(), slotMinutes, window })
  if (result.source === 'canonical-attention' && ['24H', '7D'].includes(window)) {
    return evaluateCanonicalCoverage({ measurements: result.measurements, candidateIds, window, asOf, schedulerSlotMinutes: slotMinutes })
  }
  return evaluateVaultGrowthByCandidate({ measurements: result.measurements, candidateIds, window, asOf, slotMinutes: result.slotMinutes })
}

export async function readTopicHistoricalVault({ repository, candidateId, window, asOf = new Date().toISOString(), slotMinutes = 240 }) {
  const coverage = await readHistoricalVaultCoverage({ repository, candidateIds: [candidateId], window, asOf, slotMinutes })
  const end = Date.parse(asOf)
  const result = await readGrowthMeasurements({ repository, candidateIds: [candidateId], startAt: new Date(end - RANGE_MS[window] * 2).toISOString(), endAt: new Date(end + 1).toISOString(), slotMinutes, window })
  return { candidateId, metric: result.source === 'canonical-attention' ? 'canonical-attention' : 'growth-eligible-vault-measurements', points: result.points.map((item) => ({ timestamp: item.observed_at ?? item.slot_at, value: item.canonical_attention ?? item.value, availability: item.availability ?? 'available', source: item.provider_id ?? 'nowranks-canonical-attention', comparabilityKey: item.comparability_key ?? `${item.series_key}:${item.segment_id}`, segment: item.segment_id ?? null, confidence: item.alignment_confidence ?? item.quality?.confidence ?? null })), coverage: coverage.get(candidateId), source: result.source }
}
