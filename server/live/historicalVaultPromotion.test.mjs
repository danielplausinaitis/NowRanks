import { describe, expect, it } from 'vitest'
import { evaluate24hGrowthPromotion } from './historicalVaultPromotion.mjs'
import { evaluateCanonicalGrowthPromotion } from './historicalVaultPromotion.mjs'

function growth(patch = {}) {
  return {
    status: 'available', growthSource: 'nowranks-history', growthPercent: 100, confidence: 'high', reason: null,
    recent: { expected: 12, actual: 12, values: Array(12).fill(20) },
    previous: { expected: 12, actual: 12, values: Array(12).fill(10) },
    freshnessAgeMinutes: 30, freshnessAllowanceMinutes: 300, latestPointAt: '2026-09-10T12:00:00.000Z',
    canonicalSegment: 'segment-current', recentAlignmentConfidence: 'high', crossSegmentBlended: false,
    ...patch,
  }
}
const gate = (vaultGrowth, mode = 'preferred') => evaluate24hGrowthPromotion({ window: '24H', vaultGrowth, mode })

describe('24H historical Growth public-promotion gate', () => {
  it('promotes high-confidence fresh canonical Growth and retains exact negative or very large values', () => {
    expect(gate(growth())).toMatchObject({ eligible: true, source: 'nowranks-history', fallbackReason: null, promotionOutcome: 'promoted-in-preferred', promotedInPreferred: true })
    expect(gate(growth({ growthPercent: -37.5 }))).toMatchObject({ eligible: true, promotedInPreferred: true })
    expect(gate(growth({ growthPercent: 123_456.789 }))).toMatchObject({ eligible: true, promotedInPreferred: true })
  })
  it('accepts medium alignment only with complete coverage in both canonical halves', () => {
    expect(gate(growth({ recentAlignmentConfidence: 'medium' }))).toMatchObject({ eligible: true })
    expect(gate(growth({ recentAlignmentConfidence: 'medium', recent: { expected: 12, actual: 9, values: Array(9).fill(20) } }))).toMatchObject({ eligible: false, reason: 'medium-confidence-requires-complete-coverage' })
  })
  it.each([
    ['stale canonical', growth({ freshnessAgeMinutes: 301 }), 'stale-history'],
    ['insufficient recent', growth({ recent: { expected: 12, actual: 8, values: Array(8).fill(20) } }), 'insufficient-recent-coverage'],
    ['insufficient previous', growth({ previous: { expected: 12, actual: 8, values: Array(8).fill(10) } }), 'insufficient-previous-coverage'],
    ['zero baseline', growth({ previous: { expected: 12, actual: 12, values: Array(12).fill(0) } }), 'zero-baseline'],
    ['rejected alignment', growth({ recentAlignmentConfidence: 'rejected' }), 'recent-alignment-untrusted'],
    ['cross segment', growth({ crossSegmentBlended: true }), 'cross-segment-history'],
    ['missing segment', growth({ canonicalSegment: null }), 'no-current-segment'],
    ['non-finite', growth({ growthPercent: Number.NaN }), 'non-finite-growth'],
  ])('rejects %s without fabricating a public result', (_label, vaultGrowth, reason) => {
    expect(gate(vaultGrowth)).toMatchObject({ eligible: false, reason, fallbackReason: reason, promotionOutcome: 'fallback', promotedInPreferred: false })
  })
  it('records a shadow would-promote decision without promoting, and preferred falls back when the gate fails', () => {
    expect(gate(growth(), 'shadow')).toMatchObject({ eligible: true, wouldPromoteInShadow: true, promotedInPreferred: false })
    expect(gate(growth({ status: 'unavailable', reason: 'stale-canonical-history', growthPercent: null }), 'preferred')).toMatchObject({ eligible: false, reason: 'stale-history', promotedInPreferred: false })
  })
  it('allows a new bootstrap segment only after it independently satisfies the full 12h-vs-12h evidence requirement', () => {
    expect(gate(growth({ bootstrapOnly: true }))).toMatchObject({ eligible: true, bootstrapOnly: true })
    expect(gate(growth({ bootstrapOnly: true, previous: { expected: 12, actual: 8, values: Array(8).fill(10) } }))).toMatchObject({ eligible: false, reason: 'insufficient-previous-coverage', bootstrapOnly: true })
  })
  it('does not treat a missing canonical slot as zero coverage', () => {
    const missing = growth({ recent: { expected: 12, actual: 8, values: Array(8).fill(20) } })
    expect(gate(missing)).toMatchObject({ eligible: false, reason: 'insufficient-recent-coverage' })
  })

  it('promotes qualifying 7D canonical Growth in preferred mode and leaves it diagnostic-only in shadow mode', () => {
    const sevenDay = growth({ recent: { expected: 168, actual: 126, values: Array(126).fill(20) }, previous: { expected: 168, actual: 126, values: Array(126).fill(10) } })
    expect(evaluateCanonicalGrowthPromotion({ window: '7D', vaultGrowth: sevenDay, mode: 'preferred' })).toMatchObject({ eligible: true, promotedInPreferred: true, promotionOutcome: 'promoted-in-preferred' })
    expect(evaluateCanonicalGrowthPromotion({ window: '7D', vaultGrowth: sevenDay, mode: 'shadow' })).toMatchObject({ eligible: true, wouldPromoteInShadow: true, promotedInPreferred: false, promotionOutcome: 'would-promote-in-shadow' })
  })

  it('requires complete 7D halves for medium alignment and keeps 30D and 1Y unsupported', () => {
    const sevenDay = growth({ recentAlignmentConfidence: 'medium', recent: { expected: 168, actual: 126, values: Array(126).fill(20) }, previous: { expected: 168, actual: 126, values: Array(126).fill(10) } })
    expect(evaluateCanonicalGrowthPromotion({ window: '7D', vaultGrowth: sevenDay, mode: 'preferred' })).toMatchObject({ eligible: false, reason: 'medium-confidence-requires-complete-coverage' })
    expect(evaluateCanonicalGrowthPromotion({ window: '30D', vaultGrowth: growth(), mode: 'preferred' })).toMatchObject({ eligible: false, reason: 'unsupported-window' })
    expect(evaluateCanonicalGrowthPromotion({ window: '1Y', vaultGrowth: growth(), mode: 'preferred' })).toMatchObject({ eligible: false, reason: 'unsupported-window' })
  })

  it('retains a distinct no-canonical-history diagnostic for an immature 7D candidate', () => {
    expect(evaluateCanonicalGrowthPromotion({ window: '7D', vaultGrowth: growth({ status: 'unavailable', reason: 'no-canonical-history', growthPercent: null }), mode: 'preferred' }))
      .toMatchObject({ eligible: false, reason: 'no-canonical-history', promotionOutcome: 'fallback' })
  })
})
