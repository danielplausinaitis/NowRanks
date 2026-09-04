/**
 * DataForSEO documents normalization to the highest value inside each submitted keyword set.
 * It does not guarantee that independently normalized sets share a common absolute transform.
 * Therefore a shared anchor is not mathematically defensible for global NowRanks scoring yet.
 */
export function assessDataForSeoBatchComparability(batchCount) {
  if (!Number.isInteger(batchCount) || batchCount < 1) throw new Error('At least one DataForSEO measurement batch is required')
  if (batchCount === 1) return { status: 'comparable', scope: 'single-batch', basis: 'Provider relative scale applies to the one submitted keyword set' }
  return { status: 'not-comparable', scope: 'multi-batch', basis: 'Provider documents per-request normalization but no cross-request calibration guarantee' }
}

export function assertGlobalDataForSeoComparable(batchCount) {
  const assessment = assessDataForSeoBatchComparability(batchCount)
  if (assessment.status !== 'comparable') throw new Error('DataForSEO measurements from multiple keyword batches cannot be used for global scoring: cross-batch comparability is unresolved')
  return assessment
}
