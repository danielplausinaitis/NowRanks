import { isGrowthEligibleMeasurement } from './historicalVault.mjs'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const DEFINITIONS = Object.freeze({
  // DataForSEO past_day canonical attention is hourly. Generic vault measurements retain
  // their configured cadence, but canonical readers pass 60 minutes and receive 12h vs 12h.
  '24H': { kind: 'slots', recentSlots: 3, previousSlots: 3, minimumSlots: 2, segmentMs: 12 * HOUR },
  '7D': { kind: 'days', recentDays: 3, previousDays: 3, minimumDays: 2, minimumSlotsPerDay: 4, segmentMs: 3 * DAY },
  '30D': { kind: 'days', recentDays: 14, previousDays: 14, minimumDays: 10, minimumSlotsPerDay: 4, segmentMs: 14 * DAY },
  '1Y': { kind: 'weeks', recentWeeks: 26, previousWeeks: 26, minimumWeeks: 21, minimumSlotsPerWeek: 24, segmentMs: 26 * 7 * DAY },
})
export const VAULT_GROWTH_DEFINITIONS = DEFINITIONS

function definitionFor(window, slotMinutes) {
  const definition = DEFINITIONS[window]
  if (!definition) throw new Error(`Unsupported vault window: ${window}`)
  // Canonical attention is the only hourly, cross-run comparable source. Keep
  // the legacy generic-vault definitions unchanged; specialize only canonical
  // reads, which explicitly pass a 60-minute slot cadence.
  if (slotMinutes !== 60) return definition
  if (window === '24H') return { ...definition, kind: 'slots', recentSlots: 12, previousSlots: 12, minimumSlots: 9, segmentMs: 12 * HOUR }
  if (window === '7D') return { ...definition, kind: 'slots', recentSlots: 168, previousSlots: 168, minimumSlots: 126, segmentMs: 7 * DAY }
  return definition
}

function mean(values) { return values.reduce((total, value) => total + value, 0) / values.length }
function iso(value) { return new Date(value).toISOString() }
function utcDay(value) { const date = new Date(value); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) }
function reason(status, diagnostics = {}) { return { status: 'unavailable', growthPercent: null, growthSource: 'unavailable', confidence: 'unavailable', reason: status, ...diagnostics } }

function compatible(measurements) {
  const usable = measurements.filter(isGrowthEligibleMeasurement)
  const keys = new Set(usable.map((item) => item.comparability_key))
  if (keys.size === 0) return { points: [], failure: 'no-growth-eligible-measurements' }
  if (keys.size > 1) return { points: [], failure: 'incompatible-targeting' }
  const bySlot = new Map()
  for (const item of usable) {
    const existing = bySlot.get(item.slot_at)
    if (existing && existing.value !== item.value) return { points: [], failure: 'duplicate-slot-conflict' }
    bySlot.set(item.slot_at, item)
  }
  return { points: [...bySlot.values()].sort((a, b) => Date.parse(a.slot_at) - Date.parse(b.slot_at)), comparabilityKey: keys.values().next().value }
}

function percentage({ recent, previous, minimumDenominator }) {
  if (!Number.isFinite(previous) || previous <= 0) return { failure: 'zero-baseline' }
  if (previous < minimumDenominator) return { failure: 'unsafe-denominator' }
  const value = (recent - previous) / previous * 100
  return Number.isFinite(value) ? { value } : { failure: 'non-finite-growth' }
}

function slotSegment(points, start, count, slotMs) {
  const expected = Array.from({ length: count }, (_, index) => start + index * slotMs)
  const index = new Map(points.map((point) => [Date.parse(point.slot_at), point.value]))
  const values = expected.map((timestamp) => index.get(timestamp)).filter(Number.isFinite)
  return { expected: expected.length, actual: values.length, values, coverage: values.length / expected.length }
}

function dailyBuckets(points, start, count, minimumSlots, dayMs) {
  const result = []
  for (let offset = 0; offset < count; offset += 1) {
    const dayStart = start + offset * dayMs
    const values = points.filter((point) => {
      const slot = Date.parse(point.slot_at)
      return slot >= dayStart && slot < dayStart + dayMs
    }).map((point) => point.value)
    result.push({ dayStart, values, available: values.length >= minimumSlots, mean: values.length ? mean(values) : null })
  }
  return result
}

function groupedSegment(points, start, buckets, minimumBuckets, minimumSlots, bucketMs) {
  const groups = dailyBuckets(points, start, buckets, minimumSlots, bucketMs)
  const values = groups.filter((group) => group.available).map((group) => group.mean)
  return { expected: buckets, actual: values.length, values, coverage: values.length / buckets, groups, eligible: values.length >= minimumBuckets }
}

export function evaluateVaultGrowth({ measurements, window, asOf, slotMinutes = 240, minimumDenominator = 5 }) {
  if (!Number.isInteger(slotMinutes) || slotMinutes < 1) throw new Error('Vault slot minutes must be a positive integer')
  const definition = definitionFor(window, slotMinutes)
  const end = Date.parse(asOf)
  if (!Number.isFinite(end)) throw new Error('Vault growth asOf must be a valid timestamp')
  const source = compatible(Array.isArray(measurements) ? measurements : [])
  if (source.failure) return reason(source.failure)
  if (definition.kind === 'slots') {
    const slotMs = slotMinutes * 60_000
    const recent = slotSegment(source.points, end - definition.segmentMs + slotMs, definition.recentSlots, slotMs)
    const previous = slotSegment(source.points, end - definition.segmentMs * 2 + slotMs, definition.previousSlots, slotMs)
    if (recent.actual < definition.minimumSlots) return reason('insufficient-recent-coverage', { recent, previous, comparabilityKey: source.comparabilityKey })
    if (previous.actual < definition.minimumSlots) return reason('insufficient-previous-coverage', { recent, previous, comparabilityKey: source.comparabilityKey })
    const calculation = percentage({ recent: mean(recent.values), previous: mean(previous.values), minimumDenominator })
    if (calculation.failure) return reason(calculation.failure, { recent, previous, comparabilityKey: source.comparabilityKey })
    return { status: 'available', growthPercent: calculation.value, growthSource: 'nowranks-history', confidence: recent.actual === recent.expected && previous.actual === previous.expected ? 'high' : 'medium', reason: null, recent, previous, comparabilityKey: source.comparabilityKey, asOf: iso(end) }
  }
  const bucketMs = definition.kind === 'weeks' ? 7 * DAY : DAY
  const count = definition.kind === 'weeks' ? definition.recentWeeks : definition.recentDays
  const minimumBuckets = definition.kind === 'weeks' ? definition.minimumWeeks : definition.minimumDays
  const start = definition.kind === 'weeks'
    ? end - definition.segmentMs + bucketMs
    : utcDay(end) - definition.segmentMs
  const recent = groupedSegment(source.points, start, count, minimumBuckets, definition.kind === 'weeks' ? definition.minimumSlotsPerWeek : definition.minimumSlotsPerDay, bucketMs)
  const previous = groupedSegment(source.points, start - definition.segmentMs, count, minimumBuckets, definition.kind === 'weeks' ? definition.minimumSlotsPerWeek : definition.minimumSlotsPerDay, bucketMs)
  if (!recent.eligible) return reason('insufficient-recent-coverage', { recent, previous, comparabilityKey: source.comparabilityKey })
  if (!previous.eligible) return reason('insufficient-previous-coverage', { recent, previous, comparabilityKey: source.comparabilityKey })
  const calculation = percentage({ recent: mean(recent.values), previous: mean(previous.values), minimumDenominator })
  if (calculation.failure) return reason(calculation.failure, { recent, previous, comparabilityKey: source.comparabilityKey })
  return { status: 'available', growthPercent: calculation.value, growthSource: 'nowranks-history', confidence: recent.actual === recent.expected && previous.actual === previous.expected ? 'high' : 'medium', reason: null, recent, previous, comparabilityKey: source.comparabilityKey, asOf: iso(end) }
}

export function evaluateVaultGrowthByCandidate({ measurements, candidateIds, window, asOf, slotMinutes, minimumDenominator }) {
  const byCandidate = new Map()
  for (const candidateId of candidateIds) byCandidate.set(candidateId, [])
  for (const measurement of measurements) if (byCandidate.has(measurement.candidate_id)) byCandidate.get(measurement.candidate_id).push(measurement)
  return new Map([...byCandidate].map(([candidateId, values]) => [candidateId, evaluateVaultGrowth({ measurements: values, window, asOf, slotMinutes, minimumDenominator })]))
}
