import { createHash } from 'node:crypto'

export const DEFAULT_LIVE_DISCOVERY_REFRESH_HOURS = 24

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function liveDiscoveryCacheKey({ discoveryRequests = [], measurementTarget = null }) {
  const requests = discoveryRequests.map(({ geo, language, hours, onlyActive, categoryId, geographicScope }) => ({ geo: geo ?? null, language: language ?? null, hours: hours ?? null, onlyActive: onlyActive ?? null, categoryId: categoryId ?? null, geographicScope: geographicScope ?? null }))
  return createHash('sha256').update(canonical({ requests, measurementTarget })).digest('hex')
}

export function isFreshLiveDiscoveryCache(row, { now = new Date(), freshnessHours = DEFAULT_LIVE_DISCOVERY_REFRESH_HOURS } = {}) {
  const discoveredAt = Date.parse(row?.discovered_at)
  if (!Number.isFinite(discoveredAt) || !Number.isFinite(now.getTime()) || !Number.isFinite(freshnessHours) || freshnessHours <= 0) return false
  return now.getTime() - discoveredAt <= freshnessHours * 3_600_000
}

export function discoveryCachePayload(sharedInputs) {
  const candidates = sharedInputs?.discoveryCandidates
  if (!Array.isArray(candidates) || !candidates.length) throw new Error('A daily discovery artifact requires a non-empty candidate universe')
  return {
    candidate_universe: candidates,
    discovery_request: sharedInputs.discoveryRequest,
    discovery_requests: sharedInputs.discoveryRequests,
    discovery_diagnostics: sharedInputs.sharedMetrics?.discovery ?? null,
  }
}

export function hydrateLiveDiscoveryCache(row) {
  if (!row || !Array.isArray(row.candidate_universe) || !row.candidate_universe.length || !row.discovery_request) throw new Error('Stored daily discovery artifact is malformed')
  if (row.candidate_universe.some((candidate) => !candidate?.normalizedQuery || !candidate?.query)) throw new Error('Stored daily discovery artifact has an invalid candidate')
  return {
    candidates: row.candidate_universe,
    discoveryRequest: row.discovery_request,
    discoveryRequests: Array.isArray(row.discovery_requests) && row.discovery_requests.length ? row.discovery_requests : [row.discovery_request],
    discoveryDiagnostics: row.discovery_diagnostics ?? null,
    discoveredAt: row.discovered_at,
  }
}
