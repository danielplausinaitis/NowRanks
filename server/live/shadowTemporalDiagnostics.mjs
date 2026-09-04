const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function resolutionForInterval(intervalMs) {
  if (intervalMs === null) return 'unknown'
  if (intervalMs >= 0.5 * HOUR_MS && intervalMs <= 2 * HOUR_MS) return 'hourly'
  if (intervalMs >= 18 * HOUR_MS && intervalMs <= 30 * HOUR_MS) return 'daily'
  if (intervalMs >= 5 * DAY_MS && intervalMs <= 9 * DAY_MS) return 'weekly'
  if (intervalMs >= 25 * DAY_MS && intervalMs <= 35 * DAY_MS) return 'monthly'
  return 'irregular'
}

/** Cadence detection is diagnostic only; it does not alter shadow-score eligibility. */
export function analyzeObservationTimeline(observations) {
  const points = Array.isArray(observations) ? observations : []
  const originalTimestamps = points
    .map((point) => Date.parse(point?.observedAt))
    .filter(Number.isFinite)
  const unsorted = originalTimestamps.some((timestamp, index) => index > 0 && timestamp < originalTimestamps[index - 1])
  const timestamps = [...originalTimestamps].sort((left, right) => left - right)
  const duplicateCount = timestamps.filter((timestamp, index) => index > 0 && timestamp === timestamps[index - 1]).length
  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index])
  const medianIntervalMs = median(intervals)
  const detectedResolution = resolutionForInterval(medianIntervalMs)
  const gapThreshold = medianIntervalMs === null ? null : medianIntervalMs * 2
  const largeGapCount = gapThreshold === null
    ? 0
    : intervals.filter((interval) => interval > gapThreshold).length

  return {
    firstTimestamp: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    lastTimestamp: timestamps.length ? new Date(timestamps.at(-1)).toISOString() : null,
    medianIntervalHours: medianIntervalMs === null ? null : medianIntervalMs / HOUR_MS,
    detectedResolution,
    largeGapCount,
    duplicateCount,
    unsorted,
    timestampsValid: timestamps.length === points.length,
  }
}

export function diagnoseHistoricalComponents(observations, requirements) {
  const points = Array.isArray(observations) ? observations : []
  const validCount = points.filter(
    (point) => point?.availability === 'available' && Number.isFinite(point.interest) && point.interest >= 0,
  ).length
  const completeSeries = points.length > 0 && validCount === points.length
  const components = Object.fromEntries(Object.entries(requirements).map(([component, minimum]) => {
    if (points.length === 0) return [component, { status: 'unavailable', reason: 'no-observations' }]
    if (!completeSeries) {
      return [component, {
        status: 'unavailable',
        reason: 'incomplete-series-rejected-by-current-contract',
        missingCount: points.length - validCount,
      }]
    }
    if (validCount < minimum) {
      return [component, {
        status: 'unavailable',
        reason: 'insufficient-valid-observations',
        required: minimum,
        actual: validCount,
      }]
    }
    return [component, { status: 'available', reason: null }]
  }))

  return {
    totalCount: points.length,
    validCount,
    missingCount: points.length - validCount,
    completeSeries,
    timeline: analyzeObservationTimeline(points),
    components,
  }
}
