import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('db/migrations/006_unified_live_snapshot_contract.sql', 'utf8')

describe('remote-state-aware unified snapshot migration', () => {
  it('backfills all existing snapshots as explicit v1 without rewriting entries', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS snapshot_format_version smallint/i)
    expect(migration).toMatch(/SET snapshot_format_version = 1[\s\S]*WHERE snapshot_format_version IS NULL/i)
    expect(migration).not.toMatch(/DELETE FROM live_leaderboard/i)
  })

  it.each(['established', 'emerging', 'short-window-overall'])('keeps the deployed %s lane as a valid legacy contract', (lane) => {
    expect(migration).toContain(`score_lane = '${lane}'`)
  })

  it('adds a separate, constrained unified public contract and rank uniqueness', () => {
    expect(migration).toMatch(/score_lane = 'unified'[\s\S]*public_rank IS NOT NULL[\s\S]*public_score IS NOT NULL[\s\S]*evidence_status IS NOT NULL[\s\S]*score_basis = 'unified-public'/i)
    expect(migration).toMatch(/public_rank BETWEEN 1 AND 20/i)
    expect(migration).toMatch(/evidence_status IN \('established', 'emerging'\)/i)
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS live_leaderboard_unified_public_rank_idx[\s\S]*WHERE score_lane = 'unified'/i)
  })

  it('does not modify the deployed classification or confidence vocabularies', () => {
    expect(migration).not.toMatch(/ALTER TABLE live_leaderboard_snapshot_entries[\s\S]*classification/i)
    expect(migration).not.toMatch(/ALTER TABLE live_leaderboard_snapshot_entries[\s\S]*confidence/i)
  })
})
