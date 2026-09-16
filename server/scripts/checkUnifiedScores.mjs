import { pathToFileURL } from 'node:url'
import { withExistingScoringEngine } from '../application/viteLeaderboardEngine.mjs'
import { scoreElapsedTimeShadowLiveCohort } from '../live/shadowScoring.mjs'
import { serializeUnifiedScoreDiagnostic } from '../live/unifiedScoreDiagnostics.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const EVIDENCE_KINDS = ['discovery', 'baseline-demand', 'history-metadata']

function finite(value) { return Number.isFinite(value) ? value : null }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null }
function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function option(args, name) {
  const values = args.filter((value) => value.startsWith(`${name}=`))
  if (values.length > 1) throw new Error(`${name} may be supplied once`)
  return values[0]?.slice(name.length + 1) ?? null
}
async function allPages(build) {
  const rows = []
  for (let from = 0; ; from += 1_000) {
    const { data, error } = await build(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1_000) return rows
  }
}
function categoryStats(rows) {
  const grouped = new Map()
  for (const row of rows) {
    const values = grouped.get(row.category) ?? []
    values.push(row); grouped.set(row.category, values)
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, values]) => {
    const top = values.filter((row) => row.actualPublicRank !== null)
    return [category, {
      n: values.length,
      top20N: top.length,
      scorableShare: values.length / rows.length,
      top20Share: top.length / Math.min(20, rows.length),
      meanUnifiedRawScore: average(values.map((row) => row.unifiedRawScore).filter(Number.isFinite)),
      medianUnifiedRawScore: median(values.map((row) => row.unifiedRawScore).filter(Number.isFinite)),
      meanCurrentIntensity: average(values.map((row) => row.currentIntensityNormalized).filter(Number.isFinite)),
      meanAcceleration: average(values.map((row) => row.accelerationNormalized).filter(Number.isFinite)),
      meanBaselineDemand: average(values.map((row) => row.baselineDemandNormalized).filter(Number.isFinite)),
    }]
  }))
}
function differences(left, right) {
  const keys = ['currentAttention', 'baselineDemand', 'acceleration', 'momentum', 'consistency', 'breakout', 'recency']
  return Object.fromEntries(keys.map((key) => [key, {
    value: finite(left.components[key]?.normalizedValue) === null || finite(right.components[key]?.normalizedValue) === null
      ? null
      : left.components[key].normalizedValue - right.components[key].normalizedValue,
    contribution: finite(left.components[key]?.contribution) === null || finite(right.components[key]?.contribution) === null
      ? null
      : left.components[key].contribution - right.components[key].contribution,
  }]))
}

/** Pure report builder used by the read-only database command and deterministic tests. */
export function buildUnifiedScoreAuditReport({ snapshot, entries, scores }) {
  const actualRankByQuery = new Map(entries.map((entry) => [entry.candidate_id, entry]))
  const ranked = [...scores].filter((entry) => Number.isFinite(entry.unifiedRawScore))
    .sort((left, right) => right.unifiedRawScore - left.unifiedRawScore || left.topic.localeCompare(right.topic))
  const rows = ranked.map((entry, index) => {
    const actual = actualRankByQuery.get(`live:${entry.normalizedQuery}`) ?? null
    const diagnostic = serializeUnifiedScoreDiagnostic({ entry, window: snapshot.selected_window, wouldBeRank: index + 1, publicDisplayLimit: 20 })
    return {
      wouldBeRank: index + 1,
      actualPublicRank: actual?.public_rank ?? null,
      actualPublicScore: finite(actual?.public_score),
      actualPublic: actual !== null,
      candidate: entry.topic,
      candidateId: `live:${entry.normalizedQuery}`,
      category: entry.category ?? 'Unclassified',
      status: entry.status,
      exclusionReason: diagnostic.exclusionReason,
      currentIntensityRaw: diagnostic.currentIntensityRaw,
      currentIntensityNormalized: diagnostic.currentIntensityNormalized,
      baselineDemandRaw: diagnostic.baselineDemandRaw,
      baselineDemandNormalized: diagnostic.baselineDemandNormalized,
      accelerationProviderRaw: diagnostic.accelerationProviderRaw,
      accelerationNormalized: diagnostic.components.acceleration.normalizedValue,
      momentumNormalized: diagnostic.components.momentum.normalizedValue,
      consistencyNormalized: diagnostic.components.consistency.normalizedValue,
      breakoutNormalized: diagnostic.components.breakout.normalizedValue,
      recencyNormalized: diagnostic.components.recency.normalizedValue,
      unifiedRawScore: diagnostic.unifiedRawScore,
      publicScore: diagnostic.publicScore,
      availableWeight: diagnostic.availableWeight,
      evidenceMatch: diagnostic.evidenceMatch,
      components: diagnostic.components,
      missingComponents: entry.missingComponents,
      diagnostic,
    }
  })
  const cutoff = rows[19] ?? null
  const sportsSaturated = rows.filter((row) => row.category === 'Sports' && row.accelerationProviderRaw === 1000).length
  const nonSportsSaturated = rows.filter((row) => row.category !== 'Sports' && row.accelerationProviderRaw === 1000).length
  const nonSportsComparisons = rows.filter((row) => row.category !== 'Sports').map((row) => {
    const above = rows.slice(0, row.wouldBeRank - 1).reverse().find((candidate) => candidate.category === 'Sports') ?? null
    return {
      candidate: row.candidate,
      wouldBeRank: row.wouldBeRank,
      unifiedRawScore: row.unifiedRawScore,
      sportsCandidateImmediatelyAbove: above?.candidate ?? null,
      sportsCandidateRank: above?.wouldBeRank ?? null,
      scoreDifference: above ? above.unifiedRawScore - row.unifiedRawScore : null,
      componentDifferenceSportsMinusCandidate: above ? differences(above, row) : null,
    }
  })
  return {
    readOnly: true,
    reconstruction: 'deterministic-production-scorer-reconstruction-from-persisted-discovery-baseline-and-observation-evidence',
    snapshot: { cycleId: snapshot.cycle_id, window: snapshot.selected_window, scoredAt: snapshot.scored_at, format: snapshot.snapshot_format_version },
    counts: { reconstructedScorable: rows.length, persistedPublic: entries.length, matchedPublicRanks: rows.filter((row) => row.actualPublicRank === row.wouldBeRank).length },
    accelerationSaturation: { providerValue: 1000, scorerCap: 500, sports: sportsSaturated, nonSports: nonSportsSaturated, total: sportsSaturated + nonSportsSaturated },
    cutoff: cutoff ? {
      rank20: cutoff,
      following: rows.slice(20, 22).map((row) => ({ rank: row.wouldBeRank, candidate: row.candidate, category: row.category, unifiedRawScore: row.unifiedRawScore, deltaTo20: cutoff.unifiedRawScore - row.unifiedRawScore })),
    } : null,
    categoryStatistics: categoryStats(rows),
    nonSportsComparisons,
    ranking: rows,
  }
}

function scoreInputs({ evidence, provenances, observations }) {
  const discovery = new Map(evidence.filter((row) => row.evidence_kind === 'discovery').map((row) => [row.candidate_id, row]))
  const baseline = new Map(evidence.filter((row) => row.evidence_kind === 'baseline-demand').map((row) => [row.candidate_id, row]))
  const historyMetadata = evidence.filter((row) => row.evidence_kind === 'history-metadata')
  const provenanceById = new Map(provenances.map((row) => [row.provenance_id, row]))
  const observationsByProvenance = new Map()
  const provenanceByCandidate = new Map()
  for (const observation of observations) {
    const rows = observationsByProvenance.get(observation.provenance_id) ?? []
    rows.push(observation); observationsByProvenance.set(observation.provenance_id, rows)
    if (!provenanceByCandidate.has(observation.candidate_id) && provenanceById.has(observation.provenance_id)) {
      provenanceByCandidate.set(observation.candidate_id, provenanceById.get(observation.provenance_id))
    }
  }
  return historyMetadata.flatMap((metadata) => {
    const candidate = discovery.get(metadata.candidate_id)
    const provenance = provenanceByCandidate.get(metadata.candidate_id)
    if (!candidate || !provenance) return []
    const raw = candidate.evidence_payload ?? {}
    // `history-metadata` also records continuity-only tracking. A topic is
    // scorable for the public board only when it was in this cycle's bounded
    // current-discovery pool; continuity must never leak into reconstruction.
    if (!Number.isFinite(raw.discoveryPoolPosition)) return []
    const baselineRow = baseline.get(metadata.candidate_id)
    const baselinePayload = baselineRow?.evidence_payload ?? {}
    const points = (observationsByProvenance.get(provenance.provenance_id) ?? []).map((point) => ({
      observedAt: point.observed_at, date: point.observation_date, availability: point.availability,
      interest: point.availability === 'available' ? point.interest_value : null, missingReason: point.missing_reason,
    })).sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    return [{
      topic: raw.query ?? candidate.candidates?.query_text ?? metadata.candidate_id,
      normalizedQuery: raw.normalizedQuery ?? candidate.candidates?.normalized_query ?? metadata.candidate_id.replace(/^live:/, ''),
      category: raw.category ?? candidate.candidates?.category ?? 'Unclassified',
      currentTrendIntensity: raw,
      baselineDemand: baselineRow ? { ...baselinePayload, availability: baselineRow.availability } : null,
      historicalTrendShape: { providerId: provenance.provider_id, provenance: { providerId: provenance.provider_id }, observations: points },
    }]
  })
}

/** Read only: it issues select queries only and never imports a provider client or repository writer. */
export async function checkUnifiedScores({ env = process.env, args = process.argv.slice(2), createClient = createServerSupabaseClient, score = null, write = console.log } = {}) {
  const unsupported = args.filter((argument) => !argument.startsWith('--window=') && !argument.startsWith('--cycle='))
  if (unsupported.length) throw new Error('Usage: npm run scoring:check -- --window=24H|7D|30D|1Y --cycle=<cycle-id>')
  const window = option(args, '--window') ?? '24H'
  const cycle = option(args, '--cycle')
  if (!WINDOWS.has(window)) throw new Error('window must be 24H, 7D, 30D, or 1Y')
  if (!cycle) throw new Error('cycle is required so scoring diagnostics cannot silently inspect another run')
  const client = createClient(env)
  const snapshots = await allPages((from, to) => client.from('live_leaderboard_snapshots')
    .select('snapshot_id, ingestion_run_id, cycle_id, selected_window, scored_at, data_mode, snapshot_format_version, ingestion_runs!inner(status)')
    .eq('cycle_id', cycle).eq('selected_window', window).eq('data_mode', 'live').eq('snapshot_format_version', 2).eq('ingestion_runs.status', 'succeeded').range(from, to))
  if (snapshots.length !== 1) throw new Error(`Expected one successful live v2 ${window} snapshot for cycle ${cycle}; found ${snapshots.length}`)
  const snapshot = snapshots[0]
  const evidence = await allPages((from, to) => client.from('live_provider_evidence')
    .select('ingestion_run_id, candidate_id, evidence_kind, availability, evidence_payload, candidates(query_text, normalized_query, category)')
    .eq('ingestion_run_id', snapshot.ingestion_run_id).in('evidence_kind', EVIDENCE_KINDS).range(from, to))
  const provenances = await allPages((from, to) => client.from('source_provenance')
    .select('provenance_id, provider_id, ingestion_run_id').eq('ingestion_run_id', snapshot.ingestion_run_id).range(from, to))
  const provenanceIds = provenances.map((row) => row.provenance_id)
  const observations = provenanceIds.length ? await allPages((from, to) => client.from('observations')
    .select('candidate_id, provenance_id, observation_date, observed_at, availability, interest_value, missing_reason').in('provenance_id', provenanceIds).range(from, to)) : []
  const entries = await allPages((from, to) => client.from('live_leaderboard_snapshot_entries')
    .select('candidate_id, public_rank, public_score').eq('snapshot_id', snapshot.snapshot_id).eq('score_lane', 'unified').range(from, to))
  const inputs = scoreInputs({ evidence, provenances, observations })
  const scores = score
    ? await score(inputs)
    : await withExistingScoringEngine(({ signalEngine, scoreWeights }) => scoreElapsedTimeShadowLiveCohort({ candidates: inputs, signalEngine, scoreWeights, historyWindow: window }))
  const report = buildUnifiedScoreAuditReport({ snapshot, entries, scores })
  write(JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkUnifiedScores().catch((error) => { console.error(`Unified score check failed: ${error.message}`); process.exitCode = 1 })
}
