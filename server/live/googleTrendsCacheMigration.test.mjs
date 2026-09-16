import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationPath = 'db/migrations/011_live_google_trends_history_cache.sql'
const migration = readFileSync(migrationPath, 'utf8')

describe('Google Trends history cache migration', () => {
  it('uses the next unique migration number after the existing sequence', () => {
    const files = readdirSync('db/migrations').filter((name) => name.endsWith('.sql')).sort()
    expect(files.filter((name) => name.startsWith('004_'))).toEqual(['004_observation_missing_measurement_reason.sql'])
    expect(files).toContain('011_live_google_trends_history_cache.sql')
    expect(files.at(-1)).toBe('012_live_daily_discovery_cache.sql')
  })

  it('is additive, isolates the cache identity, and follows server-only RLS access', () => {
    expect(migration).toMatch(/CREATE TABLE live_google_trends_history_cache/i)
    for (const column of ['cache_key text PRIMARY KEY', 'normalized_query text NOT NULL', 'provider_id text NOT NULL', 'measurement_mode text NOT NULL', 'measurement_target jsonb', 'time_range text NOT NULL', 'resampling_id text NOT NULL', 'history jsonb NOT NULL', 'batch_fingerprint text', 'retrieved_at timestamptz NOT NULL']) expect(migration).toContain(column)
    expect(migration).toMatch(/CREATE INDEX live_google_trends_history_cache_lookup_idx/i)
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i)
    expect(migration).toMatch(/REVOKE ALL ON live_google_trends_history_cache FROM anon, authenticated/i)
    expect(migration).toMatch(/GRANT ALL ON live_google_trends_history_cache TO service_role/i)
    expect(migration).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/i)
    expect(migration).not.toMatch(/ALTER TABLE\s+(?!live_google_trends_history_cache\s+ENABLE ROW LEVEL SECURITY)/i)
  })
})
