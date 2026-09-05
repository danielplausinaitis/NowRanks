import { DATAFORSEO_MAX_KEYWORDS, normalizeDataForSeoMeasurementWithDiagnostics } from './dataForSeoTrends.mjs'

export const SHADOW_TRENDS_MODES = Object.freeze(['single', 'batched'])

export function resolveShadowTrendsMode(env = process.env) {
  const mode = env.LIVE_SHADOW_TRENDS_MODE?.trim().toLowerCase() || 'single'
  if (!SHADOW_TRENDS_MODES.includes(mode)) {
    throw new Error(`LIVE_SHADOW_TRENDS_MODE must be one of: ${SHADOW_TRENDS_MODES.join(', ')}`)
  }
  return mode
}

export function createShadowTrendRequestGroups(candidates, mode) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Shadow Trends retrieval requires at least one candidate')
  }
  if (!SHADOW_TRENDS_MODES.includes(mode)) {
    throw new Error(`Shadow Trends mode must be one of: ${SHADOW_TRENDS_MODES.join(', ')}`)
  }
  const size = mode === 'single' ? 1 : DATAFORSEO_MAX_KEYWORDS
  return Array.from(
    { length: Math.ceil(candidates.length / size) },
    (_, index) => candidates.slice(index * size, (index + 1) * size),
  )
}

export function providerReportedCost(response) {
  if (Number.isFinite(response?.cost)) return response.cost
  return (response?.tasks ?? []).reduce(
    (total, task) => total + (Number.isFinite(task?.cost) ? task.cost : 0),
    0,
  )
}

/** Read-only shadow retrieval. The injected client is the only code allowed to perform provider I/O. */
export async function retrieveShadowTrendHistories({
  candidates,
  mode,
  client,
  request = {},
  geographicScope,
  adapter,
}) {
  if (!client?.measure) throw new Error('Shadow Trends retrieval requires a DataForSEO client')
  const groups = createShadowTrendRequestGroups(candidates, mode)
  const histories = []
  let cost = 0; const graphMeasurements = { invalidOrMissingMeasurements: 0, affectedCandidates: 0 }

  for (const group of groups) {
    const measured = await client.measure({
      ...request,
      keywords: group.map((candidate) => candidate.query),
    })
    cost += providerReportedCost(measured.response)
    const normalized = normalizeDataForSeoMeasurementWithDiagnostics({
      response: measured.response,
      candidates: group,
      geographicScope,
      retrievedAt: measured.retrievedAt,
      adapter,
      requestMetadata: measured.task,
    })
    histories.push(...normalized.histories)
    graphMeasurements.invalidOrMissingMeasurements += normalized.diagnostics.invalidOrMissingMeasurements
    graphMeasurements.affectedCandidates += normalized.diagnostics.affectedCandidates
  }

  return { histories, requestCount: groups.length, providerCost: cost, graphMeasurements }
}
