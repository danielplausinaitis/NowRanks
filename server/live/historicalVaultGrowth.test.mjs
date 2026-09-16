import { describe, expect, it } from 'vitest'
import { evaluateVaultGrowth } from './historicalVaultGrowth.mjs'

function point(slotAt, value, patch = {}) {
  return { candidate_id: 'candidate', slot_at: slotAt, value, availability: 'available', comparability_key: 'same', comparability_status: 'comparable', quality: { growthEligible: true }, ...patch }
}
function hourly(start, values) { return values.map((value, index) => point(new Date(Date.parse(start) + index * 4 * 3_600_000).toISOString(), value)) }
function hourlyCanonical(start, values) { return values.map((value, index) => point(new Date(Date.parse(start) + index * 3_600_000).toISOString(), value)) }
function daySlots(start, dailyValues) { return dailyValues.flatMap((value, day) => Array.from({ length: 6 }, (_, slot) => point(new Date(Date.parse(start) + (day * 24 + slot * 4) * 3_600_000).toISOString(), value))) }

describe('historical vault growth', () => {
  it.each([[20, 10, 100], [110, 10, 1000], [1100, 10, 10900], [5, 10, -50]])('calculates an uncapped 24H change of %s from %s', (recent, previous, expected) => {
    const result = evaluateVaultGrowth({ measurements: hourly('2026-01-02T00:00:00.000Z', [previous, previous, previous, recent, recent, recent]), window: '24H', asOf: '2026-01-02T20:00:00.000Z' })
    expect(result).toMatchObject({ status: 'available', growthSource: 'nowranks-history', growthPercent: expected })
  })
  it('uses equal-weight daily means for 7D and does not reuse the 24H result', () => {
    const measurements = daySlots('2026-01-08T00:00:00.000Z', [10, 10, 10, 41.2, 41.2, 41.2])
    const result = evaluateVaultGrowth({ measurements, window: '7D', asOf: '2026-01-14T12:00:00.000Z' })
    expect(result).toMatchObject({ status: 'available', confidence: 'high' })
    expect(result.growthPercent).toBeCloseTo(312)
  })
  it('rejects unsafe denominators, missing segment coverage, and incompatible identities without treating missing as zero', () => {
    expect(evaluateVaultGrowth({ measurements: hourly('2026-01-02T00:00:00.000Z', [0, 0, 0, 10, 10, 10]), window: '24H', asOf: '2026-01-02T20:00:00.000Z' }).reason).toBe('zero-baseline')
    expect(evaluateVaultGrowth({ measurements: hourly('2026-01-02T00:00:00.000Z', [4, 4, 4, 100, 100, 100]), window: '24H', asOf: '2026-01-02T20:00:00.000Z' }).reason).toBe('unsafe-denominator')
    const missing = hourly('2026-01-02T00:00:00.000Z', [10, 10, 10, 100, 100, 100]).slice(0, 4)
    expect(evaluateVaultGrowth({ measurements: missing, window: '24H', asOf: '2026-01-02T20:00:00.000Z' }).reason).toBe('insufficient-recent-coverage')
    const incompatible = hourly('2026-01-02T00:00:00.000Z', [10, 10, 10, 100, 100, 100]); incompatible[0].comparability_key = 'other'
    expect(evaluateVaultGrowth({ measurements: incompatible, window: '24H', asOf: '2026-01-02T20:00:00.000Z' }).reason).toBe('incompatible-targeting')
  })
  it.each([
    [[10, 20], 100],
    [[100, 72], -28],
    [[10, 220], 2100],
  ])('uses twelve hourly canonical observations per 24H segment without capping (%o)', ([previous, recent], expected) => {
    const values = [...Array(12).fill(previous), ...Array(12).fill(recent)]
    const result = evaluateVaultGrowth({ measurements: hourlyCanonical('2026-01-02T00:00:00.000Z', values), window: '24H', asOf: '2026-01-02T23:00:00.000Z', slotMinutes: 60 })
    expect(result.status).toBe('available')
    expect(result.growthPercent).toBeCloseTo(expected)
    expect(result.recent).toMatchObject({ expected: 12, actual: 12 })
    expect(result.previous).toMatchObject({ expected: 12, actual: 12 })
  })
  it('does not substitute missing hourly canonical observations with zero', () => {
    const values = [...Array(12).fill(10), ...Array(12).fill(20)]
    const measurements = hourlyCanonical('2026-01-02T00:00:00.000Z', values).filter((_, index) => ![12, 13, 14, 15].includes(index))
    expect(evaluateVaultGrowth({ measurements, window: '24H', asOf: '2026-01-02T23:00:00.000Z', slotMinutes: 60 }).reason).toBe('insufficient-recent-coverage')
  })

  it('calculates exact uncapped 7D canonical Growth from 168 hourly slots per half', () => {
    const values = [...Array(168).fill(10), ...Array(168).fill(1_100)]
    const result = evaluateVaultGrowth({ measurements: hourlyCanonical('2026-01-01T00:00:00.000Z', values), window: '7D', asOf: '2026-01-14T23:00:00.000Z', slotMinutes: 60 })
    expect(result).toMatchObject({ status: 'available', growthSource: 'nowranks-history', growthPercent: 10_900, recent: { expected: 168, actual: 168 }, previous: { expected: 168, actual: 168 } })
  })

  it('requires 126 of 168 canonical hourly slots in each 7D half without treating missing slots as zero', () => {
    const points = hourlyCanonical('2026-01-01T00:00:00.000Z', [...Array(168).fill(10), ...Array(168).fill(20)])
    const passing = points.filter((_, index) => !(index < 42 || (index >= 168 && index < 210)))
    const belowRecent = passing.filter((_, index) => index !== 126)
    const asOf = '2026-01-14T23:00:00.000Z'
    expect(evaluateVaultGrowth({ measurements: passing, window: '7D', asOf, slotMinutes: 60 })).toMatchObject({ status: 'available', growthPercent: 100, recent: { actual: 126, expected: 168 }, previous: { actual: 126, expected: 168 } })
    expect(evaluateVaultGrowth({ measurements: belowRecent, window: '7D', asOf, slotMinutes: 60 }).reason).toBe('insufficient-recent-coverage')
  })

  it.each([[10, 5, 100], [5, 10, -50], [10, 0, null]])('preserves exact positive and negative 7D Growth while rejecting a zero baseline', (recent, previous, expected) => {
    const result = evaluateVaultGrowth({ measurements: hourlyCanonical('2026-01-01T00:00:00.000Z', [...Array(168).fill(previous), ...Array(168).fill(recent)]), window: '7D', asOf: '2026-01-14T23:00:00.000Z', slotMinutes: 60 })
    if (expected === null) expect(result.reason).toBe('zero-baseline')
    else expect(result).toMatchObject({ status: 'available', growthPercent: expected })
  })
})
