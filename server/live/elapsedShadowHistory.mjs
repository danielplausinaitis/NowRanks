const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export const SHADOW_HISTORY_SEGMENT_COVERAGE = 0.8
export const SHADOW_HISTORY_MAX_GAP_INTERVALS = 2

export const SHADOW_HISTORY_WINDOWS = Object.freeze({
  '24H': Object.freeze({
    providerTimeRange: 'past_day', expectedCadence: 'hourly', cadenceMs: HOUR_MS,
    windowMs: DAY_MS, minimumObservations: 14,
    growth: Object.freeze({ recent: 7, previous: 7 }),
    momentum: Object.freeze({ short: 3, long: 7 }),
    breakoutRecent: 7,
  }),
  '7D': Object.freeze({
    providerTimeRange: 'past_7_days', expectedCadence: 'daily', cadenceMs: DAY_MS,
    windowMs: 7 * DAY_MS, minimumObservations: 7,
    growth: Object.freeze({ recent: 3, previous: 3 }),
    momentum: Object.freeze({ short: 2, long: 3 }),
    breakoutRecent: 2,
  }),
  '30D': Object.freeze({
    providerTimeRange: 'past_30_days', expectedCadence: 'daily', cadenceMs: DAY_MS,
    windowMs: 30 * DAY_MS, minimumObservations: 14,
    growth: Object.freeze({ recent: 7, previous: 7 }),
    momentum: Object.freeze({ short: 3, long: 7 }),
    breakoutRecent: 7,
  }),
  '1Y': Object.freeze({
    providerTimeRange: 'past_12_months', expectedCadence: 'weekly', cadenceMs: WEEK_MS,
    windowMs: 52 * WEEK_MS, minimumObservations: 26,
    growth: Object.freeze({ recent: 13, previous: 13 }),
    momentum: Object.freeze({ short: 4, long: 13 }),
    breakoutRecent: 13,
  }),
})

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function available(value) {
  return value?.availability === 'available' && Number.isFinite(value.interest) && value.interest >= 0
}

export function resolveShadowHistoryWindow(env = process.env) {
  const window = env.LIVE_SHADOW_HISTORY_WINDOW?.trim().toUpperCase() || '1Y'
  if (!SHADOW_HISTORY_WINDOWS[window]) {
    throw new Error(`LIVE_SHADOW_HISTORY_WINDOW must be one of: ${Object.keys(SHADOW_HISTORY_WINDOWS).join(', ')}`)
  }
  return window
}

export function shadowHistoryRequestForWindow(window) {
  const definition = SHADOW_HISTORY_WINDOWS[window]
  if (!definition) throw new Error(`Unsupported shadow history window: ${window}`)
  return { timeRange: definition.providerTimeRange }
}

/** Candidate-local peak normalization. Missing points remain missing and never become zero. */
export function peakNormalizeAvailableHistory(observations) {
  const points = Array.isArray(observations) ? observations : []
  const values = points.filter(available).map((point) => point.interest)
  if (values.length === 0) return points.map((point) => ({ ...point }))
  const peak = Math.max(...values)
  return points.map((point) => available(point)
    ? { ...point, interest: peak === 0 ? 0 : point.interest / peak * 100 }
    : { ...point })
}

function sortedUnique(points) {
  const parsed = points.map((point) => ({ point, timestamp: Date.parse(point?.observedAt) }))
  if (parsed.some(({ timestamp }) => !Number.isFinite(timestamp))) {
    throw new Error('Shadow history contains an invalid timestamp')
  }
  parsed.sort((left, right) => left.timestamp - right.timestamp)
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].timestamp === parsed[index - 1].timestamp) {
      throw new Error(`Shadow history contains duplicate timestamp ${parsed[index].point.observedAt}`)
    }
  }
  return parsed
}

function segment(points, endExclusive, bucketCount, cadenceMs) {
  const start = endExclusive - bucketCount * cadenceMs
  const selected = points.filter(({ timestamp }) =>
    timestamp >= start && timestamp < endExclusive)
  const valid = selected.filter(({ point }) => available(point))
  // For two/three-point comparisons every point is structurally important. Four points permit
  // one missing value (3/4 is the closest attainable coverage to 80%); larger segments use ceil(80%).
  const required = bucketCount <= 3
    ? bucketCount
    : bucketCount === 4
      ? 3
      : Math.ceil(bucketCount * SHADOW_HISTORY_SEGMENT_COVERAGE)
  const gaps = selected.slice(1).filter((entry, index) =>
    entry.timestamp - selected[index].timestamp > cadenceMs * SHADOW_HISTORY_MAX_GAP_INTERVALS).length
  return {
    values: valid.map(({ point }) => point.interest),
    totalCount: selected.length,
    validCount: valid.length,
    expectedCount: bucketCount,
    requiredCount: required,
    coverage: bucketCount === 0 ? 0 : valid.length / bucketCount,
    largeGapCount: gaps,
  }
}

function segmentReason(value, name) {
  if (value.validCount < value.requiredCount) return `insufficient-${name}-coverage`
  if (value.largeGapCount > 0) return `excessive-gap-in-${name}-segment`
  return null
}

function unavailable(reason, diagnostics = {}) {
  return { value: null, status: 'unavailable', reason, ...diagnostics }
}

function calculated(value, diagnostics = {}) {
  return { value, status: 'available', reason: null, ...diagnostics }
}

function pairedSegments(points, end, recentCount, previousCount, cadenceMs) {
  const recent = segment(points, end, recentCount, cadenceMs)
  const previousEnd = end - recentCount * cadenceMs
  const previous = segment(points, previousEnd, previousCount, cadenceMs)
  return { recent, previous }
}

function growthComponent(points, end, definition) {
  const segments = pairedSegments(points, end, definition.growth.recent, definition.growth.previous, definition.cadenceMs)
  const reason = segmentReason(segments.recent, 'recent') || segmentReason(segments.previous, 'baseline')
  if (reason) return unavailable(reason, { segments })
  const current = average(segments.recent.values)
  const previous = average(segments.previous.values)
  const value = Math.log1p(Math.max(0, current - previous)) * Math.sqrt(current) / Math.max(1, previous)
  return calculated(value, { segments })
}

function momentumComponent(points, end, definition) {
  const short = pairedSegments(points, end, definition.momentum.short, definition.momentum.short, definition.cadenceMs)
  const long = pairedSegments(points, end, definition.momentum.long, definition.momentum.long, definition.cadenceMs)
  const checks = [
    [short.recent, 'recent-short'], [short.previous, 'baseline-short'],
    [long.recent, 'recent-long'], [long.previous, 'baseline-long'],
  ]
  for (const [value, name] of checks) {
    const reason = segmentReason(value, name)
    if (reason) return unavailable(reason, { short, long })
  }
  const recent = average(short.recent.values) - average(short.previous.values)
  const sustained = average(long.recent.values) - average(long.previous.values)
  return calculated(Math.max(0, recent * 0.65 + sustained * 0.35), { short, long })
}

function consistencyComponent(points, definition) {
  const valid = points.filter(({ point }) => available(point)).map(({ point }) => point.interest)
  const gaps = points.slice(1).filter((entry, index) =>
    entry.timestamp - points[index].timestamp > definition.cadenceMs * SHADOW_HISTORY_MAX_GAP_INTERVALS).length
  if (valid.length < definition.minimumObservations) {
    return unavailable('insufficient-valid-observations', { requiredCount: definition.minimumObservations, validCount: valid.length })
  }
  if (gaps > 0) return unavailable('excessive-gap-in-history', { largeGapCount: gaps })
  const mean = average(valid)
  if (mean === 0) return calculated(0, { validCount: valid.length })
  const variance = average(valid.map((value) => (value - mean) ** 2))
  return calculated(Math.max(0, Math.min(100, 100 * (1 - Math.sqrt(variance) / mean))), { validCount: valid.length })
}

function breakoutComponent(points, end, definition) {
  const recent = segment(points, end, definition.breakoutRecent, definition.cadenceMs)
  const baselineCount = Math.round(definition.windowMs / definition.cadenceMs) - definition.breakoutRecent
  const baselineEnd = end - definition.breakoutRecent * definition.cadenceMs
  const baseline = segment(points, baselineEnd, baselineCount, definition.cadenceMs)
  const reason = segmentReason(recent, 'recent') || segmentReason(baseline, 'baseline')
  if (reason) return unavailable(reason, { segments: { recent, baseline } })
  const recentPeak = Math.max(...recent.values)
  const baselineAverage = average(baseline.values)
  return calculated(Math.max(0, recentPeak - baselineAverage) / Math.max(1, baselineAverage), { segments: { recent, baseline } })
}

export function evaluateElapsedShadowHistory(observations, window, timeline) {
  const definition = SHADOW_HISTORY_WINDOWS[window]
  if (!definition) throw new Error(`Unsupported shadow history window: ${window}`)
  const normalized = peakNormalizeAvailableHistory(observations)
  const points = sortedUnique(normalized)
  if (points.length === 0) {
    const empty = unavailable('no-observations')
    return { normalizedHistory: normalized, components: { growth: empty, momentum: empty, consistency: empty, breakout: empty } }
  }
  if (timeline?.detectedResolution !== definition.expectedCadence) {
    const mismatch = unavailable(`unexpected-cadence:${timeline?.detectedResolution ?? 'unknown'};expected:${definition.expectedCadence}`)
    return { normalizedHistory: normalized, components: { growth: mismatch, momentum: mismatch, consistency: mismatch, breakout: mismatch } }
  }
  const lastTimestamp = points.at(-1).timestamp
  const end = lastTimestamp + definition.cadenceMs
  const windowStart = end - definition.windowMs
  const windowPoints = points.filter(({ timestamp }) => timestamp >= windowStart && timestamp < end)
  return {
    normalizedHistory: normalized,
    components: {
      growth: growthComponent(windowPoints, end, definition),
      momentum: momentumComponent(windowPoints, end, definition),
      consistency: consistencyComponent(windowPoints, definition),
      breakout: breakoutComponent(windowPoints, end, definition),
    },
  }
}
