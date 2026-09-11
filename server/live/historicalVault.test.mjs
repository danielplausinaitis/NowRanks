import { describe, expect, it } from 'vitest'
import { buildDiscoveryVaultMeasurements, canonicalQueryFingerprint, comparabilityFingerprint, resolveHistoricalVaultConfig, utcSchedulerSlot } from './historicalVault.mjs'

const candidate = { query: 'Champions League', normalizedQuery: 'champions league', providerId: 'serpapi-google-trends-trending-now', searchVolume: 200, retrievedAt: '2026-09-08T08:17:00.000Z', geographicScope: { kind: 'country', countryCode: 'US' } }

describe('historical vault contract', () => {
  it('creates deterministic UTC slot evidence without claiming unvalidated SerpApi volume is growth eligible', () => {
    const rows = buildDiscoveryVaultMeasurements({ candidates: [candidate], candidateIdByQuery: new Map([[candidate.normalizedQuery, 'live:champions league']]), discoveryRequest: { geo: 'US', language: 'en', hours: 24 }, ingestionRunId: '00000000-0000-0000-0000-000000000001', slotAt: utcSchedulerSlot(candidate.retrievedAt), retrievedAt: candidate.retrievedAt })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slot_at: '2026-09-08T08:00:00.000Z', availability: 'available', value: 200, comparability_status: 'unknown', quality: { growthEligible: false }, measurement_horizon: '24h' })
    expect(rows[0].measurement_id).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('changes the comparison identity for geo, language, query mode, or query identity', () => {
    const common = { providerId: 'provider', metricKey: 'metric', unit: 'count', geographicScope: { country: 'US' }, language: 'en', targeting: { hours: 24 }, queryMode: 'mode', measurementHorizon: '24h', normalizationScope: 'absolute', queryFingerprint: canonicalQueryFingerprint({ providerQuery: 'one', normalizedProviderQuery: 'one' }) }
    const base = comparabilityFingerprint(common)
    expect(comparabilityFingerprint({ ...common, geographicScope: { country: 'GB' } })).not.toBe(base)
    expect(comparabilityFingerprint({ ...common, language: 'fr' })).not.toBe(base)
    expect(comparabilityFingerprint({ ...common, queryMode: 'other' })).not.toBe(base)
    expect(comparabilityFingerprint({ ...common, queryFingerprint: canonicalQueryFingerprint({ providerQuery: 'two', normalizedProviderQuery: 'two' }) })).not.toBe(base)
  })
  it('keeps rollout disabled by default and validates explicit modes', () => {
    expect(resolveHistoricalVaultConfig({})).toEqual({ enabled: false, growthMode: 'off', slotMinutes: 240 })
    expect(resolveHistoricalVaultConfig({ LIVE_VAULT_ENABLED: 'true', LIVE_VAULT_GROWTH_MODE: 'shadow', LIVE_REFRESH_INTERVAL_MINUTES: '240' })).toEqual({ enabled: true, growthMode: 'shadow', slotMinutes: 240 })
    expect(() => resolveHistoricalVaultConfig({ LIVE_VAULT_GROWTH_MODE: 'unsafe' })).toThrow(/off, shadow, preferred/)
  })
})
