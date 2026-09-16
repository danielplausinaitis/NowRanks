import { pathToFileURL } from 'node:url'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { resolveHistoricalVaultConfig } from '../live/historicalVault.mjs'
import { readHistoricalVaultCoverage } from '../live/historicalVaultReadService.mjs'
import { readLiveLeaderboard } from '../live/liveLeaderboardReadService.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

function option(args, name) {
  const match = args.find((argument) => argument.startsWith(`${name}=`))
  return match ? match.slice(name.length + 1) : null
}

function mean(values) {
  const available = (values ?? []).filter(Number.isFinite)
  return available.length ? available.reduce((total, value) => total + value, 0) / available.length : null
}

function coverage(segment) {
  if (!segment) return { expected: 168, actual: 0, percentage: 0 }
  const expected = Number(segment.expected ?? 168)
  const actual = Number(segment.actual ?? 0)
  return { expected, actual, percentage: expected > 0 ? actual / expected * 100 : null }
}

/** Pure formatter for the persisted 7D canonical-attention audit. */
export function build7dCanonicalGrowthDiagnostics({ result, canonicalPoints, coverageByCandidate }) {
  if (result?.snapshot?.selectedWindow !== '7D') throw new Error('Canonical Growth diagnostics are only available for 7D')
  const byCandidate = new Map()
  for (const point of canonicalPoints ?? []) {
    const points = byCandidate.get(point.candidate_id) ?? []
    points.push(point)
    byCandidate.set(point.candidate_id, points)
  }
  return result.entries.map((entry) => {
    const points = [...(byCandidate.get(entry.candidateId) ?? [])].sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at))
    const coverageResult = coverageByCandidate.get(entry.candidateId) ?? null
    const segmentId = coverageResult?.canonicalSegment ?? points.at(-1)?.segment_id ?? null
    const currentSegment = segmentId === null ? [] : points.filter((point) => point.segment_id === segmentId)
    const recent = coverage(coverageResult?.recent)
    const previous = coverage(coverageResult?.previous)
    const promotion = entry.componentAvailability?.presentation?.growthDiagnostics?.promotion ?? null
    return {
      candidate: entry.title,
      publicRank: entry.publicRank,
      canonicalSeriesAvailable: points.length > 0,
      canonicalSegmentId: segmentId,
      canonicalPointCountCurrentSegment: currentSegment.length,
      canonicalOldestPointAt: currentSegment[0]?.observed_at ?? null,
      canonicalLatestPointAt: coverageResult?.latestPointAt ?? currentSegment.at(-1)?.observed_at ?? null,
      canonicalFresh: Boolean(coverageResult?.latestPointAt) && coverageResult.reason !== 'stale-canonical-history',
      recent7dExpectedSlots: recent.expected,
      recent7dValidSlots: recent.actual,
      previous7dExpectedSlots: previous.expected,
      previous7dValidSlots: previous.actual,
      recent7dCoveragePct: recent.percentage,
      previous7dCoveragePct: previous.percentage,
      recent7dMean: mean(coverageResult?.recent?.values),
      previous7dMean: mean(coverageResult?.previous?.values),
      canonical7dGrowthAvailable: coverageResult?.status === 'available',
      canonical7dGrowthValue: coverageResult?.growthPercent ?? null,
      canonical7dGrowthReason: coverageResult?.reason ?? 'no-canonical-history',
      promotionEligible: promotion?.eligible ?? false,
      promotionDecision: promotion?.promotionOutcome ?? 'not-recorded-in-snapshot',
      promotionRejectionReason: promotion?.reason ?? 'not-recorded-in-snapshot',
      promotionConfidence: promotion?.confidence ?? 'unavailable',
      publicGrowthValue: entry.growthPercent,
      publicGrowthSource: entry.growthSource,
      publicGrowthSaturated: entry.growthSaturated,
    }
  })
}

/** Read-only public-7D diagnostic. It creates no provider client and writes no table. */
export async function check7dCanonicalGrowth({ env = process.env, args = process.argv.slice(2), createClient = createServerSupabaseClient, createRepository = createSupabaseIngestionRepository, read = readLiveLeaderboard, readCoverage = readHistoricalVaultCoverage, write = console.log } = {}) {
  const unsupported = args.filter((argument) => !argument.startsWith('--cycle='))
  if (unsupported.length) throw new Error('Usage: npm run growth:7d-check [-- --cycle=<cycle-id>]')
  const cycleId = option(args, '--cycle')
  const repository = createRepository(createClient(env))
  const result = await read({ repository, selectedWindow: '7D', ...(cycleId ? { cycleId } : {}) })
  const candidateIds = result.entries.map((entry) => entry.candidateId)
  const canonicalPoints = candidateIds.length ? await repository.listLiveCanonicalAttentionPoints({ candidateIds }) : []
  const config = resolveHistoricalVaultConfig(env)
  const asOf = new Date(Math.floor(Date.parse(result.snapshot.scoredAt) / (config.slotMinutes * 60_000)) * config.slotMinutes * 60_000).toISOString()
  const coverageByCandidate = await readCoverage({ repository, candidateIds, window: '7D', asOf, slotMinutes: config.slotMinutes })
  const report = {
    readOnly: true,
    requestedWindow: '7D',
    cycleId: result.snapshot.cycleId,
    scoredAt: result.snapshot.scoredAt,
    canonicalAsOf: asOf,
    vaultConfig: { enabled: config.enabled, growthMode: config.growthMode, slotMinutes: config.slotMinutes },
    topics: build7dCanonicalGrowthDiagnostics({ result, canonicalPoints, coverageByCandidate }),
  }
  write(JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  check7dCanonicalGrowth().catch((error) => { console.error(`7D canonical Growth check failed: ${error.message}`); process.exitCode = 1 })
}
