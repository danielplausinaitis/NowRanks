import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIVE_MISSING_REASONS } from './providerAdapter.mjs'

const migration = readFileSync('db/migrations/004_observation_missing_measurement_reason.sql', 'utf8').replace(/\s+/g, ' ')

describe('live observation schema contract', () => {
  it('replaces observations_check with the exact closed application missing-reason vocabulary', () => {
    expect(migration).toContain('ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_check')
    expect(migration).toContain('ADD CONSTRAINT observations_check CHECK')
    for (const reason of LIVE_MISSING_REASONS) expect(migration).toContain(`'${reason}'`)
    expect(migration).toContain("availability = 'available' AND interest_value IS NOT NULL AND interest_value >= 0 AND missing_reason IS NULL")
    expect(migration).toContain("availability = 'missing' AND interest_value IS NULL")
  })
})
