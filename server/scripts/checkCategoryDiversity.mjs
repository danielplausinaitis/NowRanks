import { pathToFileURL } from 'node:url'
import { CATEGORIES } from '../../shared/categories.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'
import { classifyPersistedSerpApiDiscoveryCategory } from '../live/serpApiTrendingNow.mjs'

const WINDOWS = new Set(['24H', '7D', '30D', '1Y'])
const CATEGORY_SET = new Set(CATEGORIES)
const EVIDENCE_KINDS = ['discovery', 'baseline-demand', 'history-metadata']

function option(args, name) {
  const matches = args.filter((argument) => argument.startsWith(`${name}=`))
  if (matches.length > 1) throw new Error(`${name} may be supplied once`)
  return matches[0] ? matches[0].slice(name.length + 1) : null
}

function category(value) { return CATEGORY_SET.has(value) ? value : 'Unclassified' }
function persistedClassification(row) {
  const payload = row?.evidence_payload ?? {}
  const classification = classifyPersistedSerpApiDiscoveryCategory({ query: payload.query ?? row?.candidates?.query_text, categories: payload.categories ?? [], unmappedCategories: payload.unmappedCategories ?? [] })
  const fallback = payload.category ?? row?.candidates?.category
  return { category: category(classification.category ?? fallback), source: classification.category ? classification.source : 'unclassified' }
}
function candidateCategory(row) { return persistedClassification(row).category }
function counts(rows, key = candidateCategory) {
  return Object.fromEntries([...rows.reduce((result, row) => {
    const label = key(row)
    result.set(label, (result.get(label) ?? 0) + 1)
    return result
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)))
}
function concentration(distribution) {
  const values = Object.values(distribution).sort((left, right) => right - left)
  const total = values.reduce((sum, value) => sum + value, 0)
  return { total, largestCategoryShare: total ? values[0] / total : 0, topTwoCategoryShare: total ? (values[0] + (values[1] ?? 0)) / total : 0, uniqueCategories: values.length }
}
function candidateName(row) { return row?.evidence_payload?.query ?? row?.candidates?.query_text ?? row?.candidate_id ?? 'unknown' }
function candidateKey(row) { return row?.candidate_id ?? row?.evidence_payload?.normalizedQuery ?? candidateName(row) }
function finite(value) { return Number.isFinite(value) ? value : null }
function persistedComponent(entry, name) { return finite(entry?.component_availability?.[name]?.value) }
export function isSuccessfulLiveV2Snapshot(snapshot) {
  const run = Array.isArray(snapshot?.ingestion_runs) ? snapshot.ingestion_runs[0] : snapshot?.ingestion_runs
  return snapshot?.data_mode === 'live' && snapshot?.snapshot_format_version === 2 && run?.status === 'succeeded'
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

function stage(distribution, available = true, reason = null) {
  return { available, reason, categories: distribution, concentration: concentration(distribution) }
}

/** Pure, read-only report builder. It never scores, ranks, or modifies categories. */
export function buildCategoryDiversityDiagnostics({ snapshots, evidence, entries }) {
  const evidenceByRun = new Map()
  for (const row of evidence) {
    const rows = evidenceByRun.get(row.ingestion_run_id) ?? []
    rows.push(row)
    evidenceByRun.set(row.ingestion_run_id, rows)
  }
  const entriesBySnapshot = new Map()
  for (const row of entries) {
    const rows = entriesBySnapshot.get(row.snapshot_id) ?? []
    rows.push(row)
    entriesBySnapshot.set(row.snapshot_id, rows)
  }
  return snapshots.map((snapshot) => {
    const rows = evidenceByRun.get(snapshot.ingestion_run_id) ?? []
    const discovery = rows.filter((row) => row.evidence_kind === 'discovery')
    const baselines = rows.filter((row) => row.evidence_kind === 'baseline-demand')
    const measured = rows.filter((row) => row.evidence_kind === 'history-metadata')
    const publicEntries = [...(entriesBySnapshot.get(snapshot.snapshot_id) ?? [])].sort((left, right) => left.public_rank - right.public_rank)
    const discoveryByCandidate = new Map(discovery.map((row) => [candidateKey(row), row]))
    const baselineByCandidate = new Map(baselines.map((row) => [candidateKey(row), row]))
    const measuredByCandidate = new Map(measured.map((row) => [candidateKey(row), row]))
    const publicByCandidate = new Map(publicEntries.map((row) => [row.candidate_id, row]))
    const allCandidates = new Map()
    for (const row of [...discovery, ...baselines, ...measured]) allCandidates.set(candidateKey(row), row)
    for (const row of publicEntries) allCandidates.set(row.candidate_id, row)
    const candidateDetails = [...allCandidates.entries()].map(([id, row]) => {
      const discoveryRow = discoveryByCandidate.get(id)
      const baseline = baselineByCandidate.get(id)
      const history = measuredByCandidate.get(id)
      const publicEntry = publicByCandidate.get(id)
      const payload = discoveryRow?.evidence_payload ?? {}
      const baselinePayload = baseline?.evidence_payload ?? {}
      const classification = persistedClassification(discoveryRow ?? row)
      const paidSelected = typeof payload.paidTrackingSelected === 'boolean' ? payload.paidTrackingSelected : null
      const exclusionReason = publicEntry
        ? null
        : !discoveryRow ? 'retained-tracking-only'
          : paidSelected === false ? (payload.paidTrackingSelectionReason ?? 'not-selected-for-paid-tracking')
          : !baseline ? 'baseline-not-persisted'
            : baseline.availability !== 'available' ? `baseline-${baseline.availability}`
              : !history ? 'not-measured'
                : 'score-and-top20-decision-not-persisted'
      return {
        candidate: candidateName(discoveryRow ?? row),
        candidateId: id,
        persistedCanonicalCategory: category(payload.category ?? (discoveryRow ?? row)?.candidates?.category),
        category: classification.category,
        classificationSource: classification.source,
        providerTag: [...new Set([...(payload.categories ?? []), ...(payload.unmappedCategories ?? [])])],
        rawDiscoveryPosition: finite(payload.providerDiscoveryRank),
        normalizedDiscoveryPosition: finite(payload.normalizedDiscoveryPosition),
        discoveryPoolPosition: finite(payload.discoveryPoolPosition),
        discoverySelectionReason: payload.discoverySelectionReason ?? null,
        searchVolume: Number.isFinite(payload.searchVolume) ? payload.searchVolume : null,
        // Do not conflate SerpApi discovery volume with the normalized Trends
        // intensity component. The latter is only persisted for public rows.
        currentIntensity: persistedComponent(publicEntry, 'searchInterest'),
        acceleration: Number.isFinite(payload.increasePercentage) ? payload.increasePercentage : null,
        momentum: persistedComponent(publicEntry, 'momentum'),
        baseline: Number.isFinite(baselinePayload.searchVolume) ? baselinePayload.searchVolume : null,
        measured: Boolean(history),
        eligible: Boolean(discoveryRow),
        paidSelected,
        paidSelectionReason: payload.paidTrackingSelectionReason ?? null,
        unifiedRawScore: null,
        publicScore: publicEntry?.public_score ?? null,
        publicRank: publicEntry?.public_rank ?? null,
        top20: Boolean(publicEntry),
        exclusionReason,
      }
    }).sort((left, right) => (left.publicRank ?? Infinity) - (right.publicRank ?? Infinity) || left.candidate.localeCompare(right.candidate))
    const mappedProviderTags = discovery.flatMap((row) => row.evidence_payload?.categories ?? [])
    const unmappedProviderTags = discovery.flatMap((row) => row.evidence_payload?.unmappedCategories ?? [])
    const rawCandidateCount = discovery.map((row) => finite(row.evidence_payload?.rawProviderResultCount)).find((value) => value !== null)
    const classifiedDiscovery = discovery.filter((row) => candidateCategory(row) !== 'Unclassified')
    const unclassifiedDiscovery = discovery.filter((row) => candidateCategory(row) === 'Unclassified')
    const paidSelectedDiscovery = discovery.filter((row) => row.evidence_payload?.paidTrackingSelected === true)
    const discoveryPoolRows = discovery.filter((row) => Number.isFinite(row.evidence_payload?.discoveryPoolPosition))
    const hasPaidSelectionEvidence = discovery.some((row) => typeof row.evidence_payload?.paidTrackingSelected === 'boolean')
    return {
      cycleId: snapshot.cycle_id,
      window: snapshot.selected_window,
      scoredAt: snapshot.scored_at,
      counts: { rawCandidateCount, normalizedCandidateCount: discovery.length, classifiedCandidateCount: classifiedDiscovery.length, unclassifiedCandidateCount: unclassifiedDiscovery.length, taxonomyCoveragePercent: discovery.length ? 100 * classifiedDiscovery.length / discovery.length : 0, discoveryPoolCandidateCount: discoveryPoolRows.length, paidCandidateCount: paidSelectedDiscovery.length, publicCandidateCount: publicEntries.length },
      rawProviderResults: { available: rawCandidateCount !== null, reason: rawCandidateCount === null ? 'raw-provider-result-count-not-persisted' : 'raw provider response body is not persisted; count and normalized provider tags are retained', categories: counts(discovery), concentration: concentration(counts(discovery)) },
      rawProviderCategoryTags: counts(mappedProviderTags, (value) => value),
      unmappedProviderCategoryTags: counts(unmappedProviderTags, (value) => value),
      // Evidence rows are written for retained discovery candidates, not for the
      // complete SerpApi response or each pre-retention eligibility decision.
      // Keep the distribution useful while making that boundary explicit.
      normalizedDiscovery: stage(counts(discovery)),
      classifiedCandidates: stage(counts(classifiedDiscovery)),
      unclassified: stage(counts(unclassifiedDiscovery)),
      discoveryEligible: stage(counts(discovery), false, 'raw discovery eligibility before retained evidence is not persisted; retained discovery evidence shown'),
      discoveryPool: stage(counts(discoveryPoolRows), hasPaidSelectionEvidence, hasPaidSelectionEvidence ? null : 'paid discovery selection diagnostics are not persisted for this historical cycle'),
      baselineDemand: stage(counts(baselines.filter((row) => row.availability === 'available'))),
      // A successful history row proves measurement, not that every selected
      // paid slot was persisted as a separate selection decision.
      paidTracking: stage(counts(paidSelectedDiscovery), hasPaidSelectionEvidence, hasPaidSelectionEvidence ? null : 'paid tracking selection diagnostics are not persisted separately; successful measurements shown below'),
      measured: stage(counts(measured)),
      scorable: stage({}, false, 'non-public unified scores are not persisted'),
      publicTop20: stage(counts(publicEntries)),
      candidateDetails,
    }
  })
}

/** Read-only category attrition report over successful live-v2 snapshots only. */
export async function checkCategoryDiversity({ env = process.env, args = process.argv.slice(2), createClient = createServerSupabaseClient, write = console.log } = {}) {
  const unsupported = args.filter((argument) => !argument.startsWith('--window=') && !argument.startsWith('--cycle=') && !argument.startsWith('--limit='))
  if (unsupported.length) throw new Error('Usage: npm run categories:check [-- --window=24H|7D|30D|1Y] [--cycle=<cycle-id>] [--limit=<count>]')
  const window = option(args, '--window')
  const cycle = option(args, '--cycle')
  const limit = Number(option(args, '--limit') ?? 12)
  if (window && !WINDOWS.has(window)) throw new Error('window must be 24H, 7D, 30D, or 1Y')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100')
  const client = createClient(env)
  const snapshots = await allPages((from, to) => {
    let query = client.from('live_leaderboard_snapshots').select('snapshot_id, ingestion_run_id, cycle_id, selected_window, scored_at, data_mode, snapshot_format_version, ingestion_runs!inner(status)')
      .eq('data_mode', 'live').eq('snapshot_format_version', 2).eq('ingestion_runs.status', 'succeeded')
    if (window) query = query.eq('selected_window', window)
    if (cycle) query = query.eq('cycle_id', cycle)
    return query.order('scored_at', { ascending: false }).range(from, to)
  })
  // Repeat the database predicates in-process.  This keeps the report
  // read-only and prevents a future query/edit from mixing replay, mock,
  // legacy, or failed rows into the diagnostic.
  const selected = snapshots.filter(isSuccessfulLiveV2Snapshot).slice(0, limit)
  const runIds = selected.map((row) => row.ingestion_run_id)
  const snapshotIds = selected.map((row) => row.snapshot_id)
  const evidence = runIds.length ? await allPages((from, to) => client.from('live_provider_evidence')
    .select('ingestion_run_id, candidate_id, evidence_kind, availability, evidence_payload, candidates(query_text, category)')
    .in('ingestion_run_id', runIds).in('evidence_kind', EVIDENCE_KINDS).range(from, to)) : []
  const entries = snapshotIds.length ? await allPages((from, to) => client.from('live_leaderboard_snapshot_entries')
    .select('snapshot_id, candidate_id, public_rank, public_score, search_interest_component, component_availability, candidates(query_text, category)')
    .in('snapshot_id', snapshotIds).eq('score_lane', 'unified').range(from, to)) : []
  const report = { readOnly: true, requestedWindow: window ?? null, requestedCycle: cycle ?? null, officialCategories: CATEGORIES, snapshots: buildCategoryDiversityDiagnostics({ snapshots: selected, evidence, entries }) }
  write(JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkCategoryDiversity().catch((error) => { console.error(`Category diversity check failed: ${error.message}`); process.exitCode = 1 })
}
