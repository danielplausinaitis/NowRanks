export const CROSS_QUERY_COMPARABILITY_STATUS = Object.freeze({
  COMPARABLE: 'comparable',
  NOT_COMPARABLE: 'not-comparable',
  UNKNOWN: 'unknown',
})

export const CROSS_QUERY_COMPARABILITY_STATUSES = Object.freeze(Object.values(CROSS_QUERY_COMPARABILITY_STATUS))

export function isCrossQueryComparabilityStatus(value) {
  return typeof value === 'string' && CROSS_QUERY_COMPARABILITY_STATUSES.includes(value)
}
