const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
import { isTrendHeat } from './trendPresentation.mjs'

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
  const presentation = row.component_availability?.presentation ?? {}
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
    growthPercent: Number.isFinite(presentation.growthPercent) ? presentation.growthPercent : null,
    trendHeat: isTrendHeat(presentation.trendHeat) ? presentation.trendHeat : null,
    scoredAt: snapshot.scoredAt,
    cycleId: snapshot.cycleId,
    selectedWindow: snapshot.selectedWindow,
  }
}

function validateLaneEntries(entries) {
  const ranks = { established: new Set(), emerging: new Set() }
  const candidates = new Set()
  for (const entry of entries) {
    if (ranks[entry.scoreLane].has(entry.laneRank)) malformed(`duplicate ${entry.scoreLane} lane rank ${entry.laneRank}`)
    if (candidates.has(entry.candidateId)) malformed(`duplicate candidate ${entry.candidateId} across live lanes`)
    ranks[entry.scoreLane].add(entry.laneRank); candidates.add(entry.candidateId)
  }
}

/** Computes movement only within a persisted lane; lane changes are deliberately new entries. */
export function computeLiveLaneMovement({ currentEntries, previousEntries, previousSnapshotExists }) {
  if (!previousSnapshotExists) return currentEntries.map((entry) => ({ ...entry, movement: { state: 'unavailable', delta: null, previousRank: null } }))
  validateLaneEntries(previousEntries)
  const previousRanks = new Map(previousEntries.map((entry) => [`${entry.scoreLane}\u0000${entry.candidateId}`, entry.laneRank]))
  return currentEntries.map((entry) => {
    const previousRank = previousRanks.get(`${entry.scoreLane}\u0000${entry.candidateId}`)
    if (previousRank === undefined) return { ...entry, movement: { state: 'new', delta: null, previousRank: null } }
    const delta = previousRank - entry.laneRank
    return { ...entry, movement: { state: delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged', delta, previousRank } }
  })
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
  validateLaneEntries(entries)
  const previousHeader = await repository.getPreviousLiveSnapshot({ selectedWindow, beforeScoredAt: snapshot.scoredAt })
  const previousEntries = previousHeader
    ? (await repository.listLiveSnapshotEntries({ snapshotId: mapSnapshot(previousHeader).snapshotId })).map((row) => mapEntry(row, mapSnapshot(previousHeader)))
    : []
  const entriesWithMovement = computeLiveLaneMovement({ currentEntries: entries, previousEntries, previousSnapshotExists: Boolean(previousHeader) })
  const lanes = { established: [], emerging: [] }
  for (const entry of entriesWithMovement) {
    lanes[entry.scoreLane].push(entry)
  }
  lanes.established.sort((a, b) => a.laneRank - b.laneRank)
  lanes.emerging.sort((a, b) => a.laneRank - b.laneRank)
  return { snapshot, established: lanes.established, emerging: lanes.emerging }
}
