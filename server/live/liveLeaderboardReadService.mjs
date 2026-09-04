const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])

export class LiveSnapshotNotFoundError extends Error {
  constructor({ selectedWindow, cycleId }) {
    super(`No live snapshot exists for window ${selectedWindow}${cycleId ? ` and cycle ${cycleId}` : ''}`)
    this.name = 'LiveSnapshotNotFoundError'
    this.code = 'live_snapshot_not_found'
  }
}

function malformed(message) {
  throw new Error(`Malformed live persisted data: ${message}`)
}

function assert(condition, message) {
  if (!condition) malformed(message)
}

function mapSnapshot(row) {
  assert(row?.snapshot_id && row.cycle_id && WINDOWS.has(row.selected_window), 'snapshot header is incomplete')
  assert(row.data_mode === 'live', `snapshot ${row.snapshot_id} is not live`)
  assert(row.scored_at && Number.isFinite(Date.parse(row.scored_at)), `snapshot ${row.snapshot_id} has invalid scored_at`)
  return {
    snapshotId: row.snapshot_id,
    ingestionRunId: row.ingestion_run_id,
    cycleId: row.cycle_id,
    dataMode: row.data_mode,
    selectedWindow: row.selected_window,
    scoredAt: row.scored_at,
  }
}

function mapEntry(row, snapshot) {
  const candidate = row?.candidates
  assert(row?.snapshot_id === snapshot.snapshotId, 'entry references a different snapshot')
  assert(candidate?.candidate_id === row.candidate_id && candidate.query_text, `entry ${row?.snapshot_entry_id ?? 'unknown'} has incomplete candidate identity`)
  assert(['established', 'emerging'].includes(row.score_lane), `entry ${row.snapshot_entry_id} has invalid score lane`)
  assert(Number.isInteger(row.lane_rank) && row.lane_rank > 0, `entry ${row.snapshot_entry_id} has invalid lane rank`)
  assert(typeof row.confidence_reason === 'string' && row.confidence_reason.trim(), `entry ${row.snapshot_entry_id} has no confidence reason`)
  const established = row.score_lane === 'established'
  assert(established ? row.emerging_trending_score === null : row.overall_score === null, `entry ${row.snapshot_entry_id} violates ${established ? 'established' : 'emerging'} score invariants`)
  assert(established ? row.overall_score !== null && row.established_trending_score !== null : row.established_trending_score === null && row.emerging_trending_score !== null, `entry ${row.snapshot_entry_id} has incomplete lane scores`)
  return {
    candidateId: row.candidate_id,
    query: candidate.query_text,
    title: candidate.query_text,
    normalizedQuery: candidate.normalized_query,
    category: candidate.category,
    scoreLane: row.score_lane,
    laneRank: row.lane_rank,
    classification: row.classification,
    confidence: row.confidence,
    confidenceReason: row.confidence_reason,
    scoreBasis: row.score_basis,
    overallScore: row.overall_score,
    establishedTrendingScore: row.established_trending_score,
    emergingTrendingScore: row.emerging_trending_score,
    historyObservationCount: row.history_observation_count,
    historyAvailableCount: row.history_available_count,
    historyCoveragePercentage: row.history_coverage_percentage,
    searchInterest: row.search_interest_component,
    componentAvailability: row.component_availability,
    scoredAt: snapshot.scoredAt,
    cycleId: snapshot.cycleId,
    selectedWindow: snapshot.selectedWindow,
  }
}

/** Returns persisted live scores as two independent, intentionally non-unified lanes. */
export async function readLiveLeaderboard({ repository, selectedWindow = '1Y', cycleId } = {}) {
  if (!repository) throw new Error('A live snapshot repository is required')
  if (!WINDOWS.has(selectedWindow)) throw new Error('Live read window must be 24H, 7D, 30D, or 1Y')
  const header = cycleId
    ? await repository.getLiveSnapshot({ cycleId, selectedWindow })
    : await repository.getLatestLiveSnapshot({ selectedWindow })
  if (!header) throw new LiveSnapshotNotFoundError({ selectedWindow, cycleId })
  const snapshot = mapSnapshot(header)
  const entries = (await repository.listLiveSnapshotEntries({ snapshotId: snapshot.snapshotId })).map((row) => mapEntry(row, snapshot))
  const lanes = { established: [], emerging: [] }
  const ranks = { established: new Set(), emerging: new Set() }
  for (const entry of entries) {
    if (ranks[entry.scoreLane].has(entry.laneRank)) malformed(`duplicate ${entry.scoreLane} lane rank ${entry.laneRank}`)
    ranks[entry.scoreLane].add(entry.laneRank)
    lanes[entry.scoreLane].push(entry)
  }
  lanes.established.sort((a, b) => a.laneRank - b.laneRank)
  lanes.emerging.sort((a, b) => a.laneRank - b.laneRank)
  return { snapshot, established: lanes.established, emerging: lanes.emerging }
}
