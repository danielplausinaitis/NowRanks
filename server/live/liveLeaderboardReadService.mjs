const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const LEGACY_LANES = new Set(['established', 'emerging'])
export const LEGACY_SNAPSHOT_FORMAT_VERSION = 1
export const UNIFIED_SNAPSHOT_FORMAT_VERSION = 2
export const PUBLIC_TOP_COUNT = 20
import { isTrendHeat } from './trendPresentation.mjs'

export class LiveSnapshotNotFoundError extends Error {
  constructor({ selectedWindow, cycleId }) { super(`No live snapshot exists for window ${selectedWindow}${cycleId ? ` and cycle ${cycleId}` : ''}`); this.name = 'LiveSnapshotNotFoundError'; this.code = 'live_snapshot_not_found' }
}
function malformed(message) { throw new Error(`Malformed live persisted data: ${message}`) }
function assert(condition, message) { if (!condition) malformed(message) }

function mapSnapshot(row) {
  assert(row?.snapshot_id && row.cycle_id && WINDOWS.has(row.selected_window), 'snapshot header is incomplete')
  assert(row.data_mode === 'live', `snapshot ${row.snapshot_id} is not live`)
  assert(row.scored_at && Number.isFinite(Date.parse(row.scored_at)), `snapshot ${row.snapshot_id} has invalid scored_at`)
  return { snapshotId: row.snapshot_id, ingestionRunId: row.ingestion_run_id, cycleId: row.cycle_id, dataMode: row.data_mode, selectedWindow: row.selected_window, scoredAt: row.scored_at, snapshotFormatVersion: row.snapshot_format_version ?? LEGACY_SNAPSHOT_FORMAT_VERSION }
}
function requireRequestedWindow(snapshot, selectedWindow, cycleId) {
  // The repository query is window-scoped, but retain this guard at the public
  // read boundary so a future repository regression cannot expose another
  // horizon's snapshot as a successful response.
  if (snapshot.selectedWindow !== selectedWindow) throw new LiveSnapshotNotFoundError({ selectedWindow, cycleId })
  if (snapshot.snapshotFormatVersion !== UNIFIED_SNAPSHOT_FORMAT_VERSION) throw new LiveSnapshotNotFoundError({ selectedWindow, cycleId })
  return snapshot
}
function mapPublicSnapshot(row, selectedWindow, cycleId) {
  if (row?.ingestion_runs?.status !== 'succeeded') throw new LiveSnapshotNotFoundError({ selectedWindow, cycleId })
  return requireRequestedWindow(mapSnapshot(row), selectedWindow, cycleId)
}
function legacyHeatDiagnostics(trendHeat) {
  return trendHeat === null
    ? { heatStatus: 'pending', heatLevel: null, heatEvidenceAvailable: false, heatEvidenceSource: null, heatFallbackUsed: false, heatPendingReason: 'legacy-heat-diagnostics-unavailable' }
    : { heatStatus: 'available', heatLevel: trendHeat, heatEvidenceAvailable: true, heatEvidenceSource: 'legacy-heat-source-not-recorded', heatFallbackUsed: false, heatPendingReason: null }
}
function mapHeatDiagnostics(presentation, trendHeat) {
  const diagnostics = presentation.heatDiagnostics
  const valid = diagnostics && typeof diagnostics === 'object'
    && ['available', 'pending'].includes(diagnostics.heatStatus)
    && diagnostics.heatEvidenceAvailable === (diagnostics.heatStatus === 'available')
    && typeof diagnostics.heatFallbackUsed === 'boolean'
    && (diagnostics.heatStatus === 'available'
      ? isTrendHeat(diagnostics.heatLevel) && diagnostics.heatLevel !== null && typeof diagnostics.heatEvidenceSource === 'string' && diagnostics.heatPendingReason === null
      : diagnostics.heatLevel === null && diagnostics.heatEvidenceSource === null && typeof diagnostics.heatPendingReason === 'string')
  if (!valid) return legacyHeatDiagnostics(trendHeat)
  // The level displayed to the public must always be the exact persisted
  // presentation level, never a read-time re-computation.
  if (diagnostics.heatLevel !== trendHeat) return legacyHeatDiagnostics(trendHeat)
  return diagnostics
}
function mapCommonEntry(row, snapshot) {
  const candidate = row?.candidates
  assert(row?.snapshot_id === snapshot.snapshotId, 'entry references a different snapshot')
  assert(candidate?.candidate_id === row.candidate_id && candidate.query_text, `entry ${row?.snapshot_entry_id ?? 'unknown'} has incomplete candidate identity`)
  assert(typeof row.confidence_reason === 'string' && row.confidence_reason.trim(), `entry ${row.snapshot_entry_id} has no confidence reason`)
  const presentation = row.component_availability?.presentation ?? {}
  const trendHeat = isTrendHeat(presentation.trendHeat) ? presentation.trendHeat : null
  const heatDiagnostics = mapHeatDiagnostics(presentation, trendHeat)
  return { candidateId: row.candidate_id, query: candidate.query_text, title: candidate.query_text, normalizedQuery: candidate.normalized_query, category: candidate.category, classification: row.classification, confidence: row.confidence, confidenceReason: row.confidence_reason, scoreBasis: row.score_basis, historyObservationCount: row.history_observation_count, historyAvailableCount: row.history_available_count, historyCoveragePercentage: row.history_coverage_percentage, searchInterest: row.search_interest_component, componentAvailability: row.component_availability, growthPercent: Number.isFinite(presentation.growthPercent) ? presentation.growthPercent : null, growthSource: ['nowranks-history', 'provider-history', 'discovery-increase', 'unavailable'].includes(presentation.growthSource) ? presentation.growthSource : 'unavailable', growthSaturated: presentation.growthSaturated === true, trendHeat, ...heatDiagnostics, scoredAt: snapshot.scoredAt, cycleId: snapshot.cycleId, selectedWindow: snapshot.selectedWindow }
}
function mapLegacyEntry(row, snapshot) {
  assert(LEGACY_LANES.has(row.score_lane), `entry ${row.snapshot_entry_id} has invalid legacy score lane`)
  assert(Number.isInteger(row.lane_rank) && row.lane_rank > 0, `entry ${row.snapshot_entry_id} has invalid lane rank`)
  const established = row.score_lane === 'established'
  assert(established ? row.emerging_trending_score === null : row.overall_score === null, `entry ${row.snapshot_entry_id} violates ${row.score_lane} score invariants`)
  assert(established ? row.overall_score !== null && row.established_trending_score !== null : row.established_trending_score === null && row.emerging_trending_score !== null, `entry ${row.snapshot_entry_id} has incomplete lane scores`)
  return { ...mapCommonEntry(row, snapshot), scoreLane: row.score_lane, laneRank: row.lane_rank, overallScore: row.overall_score, establishedTrendingScore: row.established_trending_score, emergingTrendingScore: row.emerging_trending_score }
}
function mapUnifiedEntry(row, snapshot) {
  assert(row.score_lane === 'unified', `entry ${row.snapshot_entry_id} has invalid unified score lane`)
  assert(Number.isInteger(row.public_rank) && row.public_rank >= 1 && row.public_rank <= 20, `entry ${row.snapshot_entry_id} has invalid public rank`)
  assert(Number.isFinite(row.public_score), `entry ${row.snapshot_entry_id} has invalid public score`)
  assert(['established', 'emerging'].includes(row.evidence_status), `entry ${row.snapshot_entry_id} has invalid evidence status`)
  assert(row.score_basis === 'unified-public', `entry ${row.snapshot_entry_id} has invalid unified score basis`)
  assert(row.lane_rank === null && row.overall_score === null && row.established_trending_score === null && row.emerging_trending_score === null, `entry ${row.snapshot_entry_id} mixes legacy and unified score fields`)
  return { ...mapCommonEntry(row, snapshot), publicRank: row.public_rank, publicScore: row.public_score, evidenceStatus: row.evidence_status }
}
async function hasCompleteUnifiedPublicBoard({ repository, snapshot }) {
  const entries = (await repository.listLiveSnapshotEntries({ snapshotId: snapshot.snapshotId })).flatMap((row) => row?.score_lane === 'unified' ? [mapUnifiedEntry(row, snapshot)] : [])
  validateUnique(entries, 'publicRank', 'public')
  return entries.length === PUBLIC_TOP_COUNT && entries.every((entry) => entry.publicRank >= 1 && entry.publicRank <= PUBLIC_TOP_COUNT)
}
function validateUnique(entries, rankKey, label) { const ranks = new Set(); const candidates = new Set(); for (const entry of entries) { if (ranks.has(entry[rankKey])) malformed(`duplicate ${label} rank ${entry[rankKey]}`); if (candidates.has(entry.candidateId)) malformed(`duplicate candidate ${entry.candidateId}`); ranks.add(entry[rankKey]); candidates.add(entry.candidateId) } }
function validateLegacyEntries(entries) { const ranks = { established: new Set(), emerging: new Set() }; const candidates = new Set(); for (const entry of entries) { if (ranks[entry.scoreLane].has(entry.laneRank)) malformed(`duplicate ${entry.scoreLane} lane rank ${entry.laneRank}`); if (candidates.has(entry.candidateId)) malformed(`duplicate candidate ${entry.candidateId} across live lanes`); ranks[entry.scoreLane].add(entry.laneRank); candidates.add(entry.candidateId) } }

export function computeLiveLaneMovement({ currentEntries, previousEntries, previousSnapshotExists }) {
  if (!previousSnapshotExists) return currentEntries.map((entry) => ({ ...entry, movement: { state: 'unavailable', delta: null, previousRank: null } }))
  validateLegacyEntries(previousEntries); const previousRanks = new Map(previousEntries.map((entry) => [`${entry.scoreLane}\u0000${entry.candidateId}`, entry.laneRank]))
  return currentEntries.map((entry) => { const previousRank = previousRanks.get(`${entry.scoreLane}\u0000${entry.candidateId}`); if (previousRank === undefined) return { ...entry, movement: { state: 'new', delta: null, previousRank: null } }; const delta = previousRank - entry.laneRank; return { ...entry, movement: { state: delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged', delta, previousRank } } })
}
export function computeUnifiedMovement({ currentEntries, previousEntries, previousSnapshotExists }) {
  if (!previousSnapshotExists) return currentEntries.map((entry) => ({ ...entry, movement: { state: 'unavailable', delta: null, previousRank: null } }))
  validateUnique(previousEntries, 'publicRank', 'public'); const previousRanks = new Map(previousEntries.map((entry) => [entry.candidateId, entry.publicRank]))
  return currentEntries.map((entry) => { const previousRank = previousRanks.get(entry.candidateId); if (previousRank === undefined) return { ...entry, movement: { state: 'new', delta: null, previousRank: null } }; const delta = previousRank - entry.publicRank; return { ...entry, movement: { state: delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged', delta, previousRank } } })
}
function compatibility(snapshot, status, diagnostics = []) { return { status, snapshotFormatVersion: snapshot.snapshotFormatVersion, diagnostics } }
async function readLegacySnapshot({ repository, snapshot }) {
  const diagnostics = []
  const entries = (await repository.listLiveSnapshotEntries({ snapshotId: snapshot.snapshotId })).flatMap((row) => { if (!LEGACY_LANES.has(row?.score_lane)) { diagnostics.push({ snapshotId: snapshot.snapshotId, skippedLane: row?.score_lane ?? null, reason: 'unsupported-legacy-lane' }); return [] } return [mapLegacyEntry(row, snapshot)] })
  validateLegacyEntries(entries)
  const previousHeader = await repository.getPreviousLiveSnapshot({ selectedWindow: snapshot.selectedWindow, beforeScoredAt: snapshot.scoredAt })
  const previousSnapshot = previousHeader ? mapSnapshot(previousHeader) : null
  const previousEntries = previousSnapshot ? (await repository.listLiveSnapshotEntries({ snapshotId: previousSnapshot.snapshotId })).flatMap((row) => LEGACY_LANES.has(row?.score_lane) ? [mapLegacyEntry(row, previousSnapshot)] : []) : []
  const lanes = { established: [], emerging: [] }; for (const entry of computeLiveLaneMovement({ currentEntries: entries, previousEntries, previousSnapshotExists: Boolean(previousSnapshot) })) lanes[entry.scoreLane].push(entry)
  lanes.established.sort((a, b) => a.laneRank - b.laneRank); lanes.emerging.sort((a, b) => a.laneRank - b.laneRank)
  return { rankingMode: 'legacy-lanes', snapshot, established: lanes.established, emerging: lanes.emerging, compatibility: compatibility(snapshot, diagnostics.length ? 'supported-with-skipped-entries' : 'supported', diagnostics) }
}
async function readUnifiedSnapshot({ repository, snapshot }) {
  const diagnostics = []
  const entries = (await repository.listLiveSnapshotEntries({ snapshotId: snapshot.snapshotId })).flatMap((row) => { if (row?.score_lane !== 'unified') { diagnostics.push({ snapshotId: snapshot.snapshotId, skippedLane: row?.score_lane ?? null, reason: 'non-unified-entry-in-unified-snapshot' }); return [] } return [mapUnifiedEntry(row, snapshot)] })
  validateUnique(entries, 'publicRank', 'public')
  const previousHeader = await repository.getPreviousUnifiedLiveSnapshot({ selectedWindow: snapshot.selectedWindow, beforeScoredAt: snapshot.scoredAt })
  const previousSnapshot = previousHeader ? mapSnapshot(previousHeader) : null
  const previousEntries = previousSnapshot ? (await repository.listLiveSnapshotEntries({ snapshotId: previousSnapshot.snapshotId })).flatMap((row) => row?.score_lane === 'unified' ? [mapUnifiedEntry(row, previousSnapshot)] : []) : []
  return { rankingMode: 'unified', snapshot, entries: computeUnifiedMovement({ currentEntries: entries, previousEntries, previousSnapshotExists: Boolean(previousSnapshot) }).sort((a, b) => a.publicRank - b.publicRank), compatibility: compatibility(snapshot, diagnostics.length ? 'supported-with-skipped-entries' : 'supported', diagnostics) }
}

/** Reads the latest successful v2 live snapshot for exactly one public window. */
export async function readLiveLeaderboard({ repository, selectedWindow = '24H', cycleId } = {}) {
  if (!repository) throw new Error('A live snapshot repository is required')
  if (!WINDOWS.has(selectedWindow)) throw new Error('Live read window must be 24H, 7D, 30D, or 1Y')
  let header = cycleId
    ? await repository.getUnifiedLiveSnapshot({ cycleId, selectedWindow })
    : await repository.getLatestUnifiedLiveSnapshot({ selectedWindow })
  const seenSnapshotIds = new Set()
  while (header) {
    const snapshot = mapPublicSnapshot(header, selectedWindow, cycleId)
    if (seenSnapshotIds.has(snapshot.snapshotId)) break
    seenSnapshotIds.add(snapshot.snapshotId)
    if (await hasCompleteUnifiedPublicBoard({ repository, snapshot })) return readUnifiedSnapshot({ repository, snapshot })
    // An explicit cycle request must never silently substitute another run. The
    // default read may skip an old, accidentally persisted partial v2 snapshot,
    // but only to an earlier succeeded v2 snapshot for this exact horizon.
    if (cycleId) break
    header = await repository.getPreviousUnifiedLiveSnapshot({ selectedWindow, beforeScoredAt: snapshot.scoredAt })
  }
  throw new LiveSnapshotNotFoundError({ selectedWindow, cycleId })
}
