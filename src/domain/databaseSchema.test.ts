import schema from '../../db/migrations/001_initial_nowranks_schema.sql?raw'
import { describe, expect, it } from 'vitest'
import { SCORE_COMPONENT_KEYS } from './types'
import { TIME_WINDOWS } from './config'

const normalizedSchema = schema.replace(/\s+/g, ' ')

describe('initial PostgreSQL schema', () => {
  it('creates the canonical candidate, provenance, observation, ingestion, and snapshot tables', () => {
    for (const table of ['candidates', 'source_provenance', 'observations', 'ingestion_runs', 'leaderboard_snapshots', 'leaderboard_snapshot_entries']) {
      expect(normalizedSchema).toContain(`CREATE TABLE ${table}`)
    }
  })

  it('preserves the canonical zero-versus-missing observation distinction', () => {
    expect(normalizedSchema).toContain("availability IN ('available', 'missing')")
    expect(normalizedSchema).toContain("availability = 'available' AND interest_value IS NOT NULL AND interest_value >= 0")
    expect(normalizedSchema).toContain("availability = 'missing' AND interest_value IS NULL")
    expect(normalizedSchema).toContain("missing_reason IN ('not-reported', 'source-unavailable', 'out-of-range', 'redacted')")
  })

  it('stores replay/live/test provenance and cross-query comparability', () => {
    expect(normalizedSchema).toContain("data_mode IN ('live', 'replay', 'test')")
    expect(normalizedSchema).toContain("cross_query_comparability_status IN ('comparable', 'not-comparable', 'unknown')")
    expect(normalizedSchema).toContain('geographic_scope jsonb NOT NULL')
  })

  it('supports all current windows and the full score-component contract', () => {
    for (const window of Object.keys(TIME_WINDOWS)) expect(normalizedSchema).toContain(`'${window}'`)
    const columns = {
      searchInterest: 'search_interest_component',
      growth: 'growth_component',
      momentum: 'momentum_component',
      consistency: 'consistency_component',
      breakout: 'breakout_component',
    }
    for (const component of SCORE_COMPONENT_KEYS) expect(normalizedSchema).toContain(`${columns[component]} double precision NOT NULL`)
  })

  it('protects ingestion idempotency, observation duplication, and snapshot rank uniqueness', () => {
    expect(normalizedSchema).toContain('idempotency_key text NOT NULL UNIQUE')
    expect(normalizedSchema).toContain('UNIQUE (candidate_id, provenance_id, observed_at)')
    expect(normalizedSchema).toContain('UNIQUE (snapshot_id, rank)')
    expect(normalizedSchema).toContain('nowranks_score double precision NOT NULL CHECK (nowranks_score >= 0 AND nowranks_score <= 100)')
  })
})
