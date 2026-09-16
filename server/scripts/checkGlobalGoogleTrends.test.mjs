import { describe, expect, it, vi } from 'vitest'
import { GLOBAL_GOOGLE_TRENDS_EXPERIMENT_TOPICS, runGlobalGoogleTrendsExperiment } from './checkGlobalGoogleTrends.mjs'

function response(query, value) {
  return { status_code: 20000, tasks: [{ status_code: 20000, cost: 0.01, result: [{ location_code: null, language_code: 'en', items: [{ type: 'google_trends_graph', keywords: [query], data: [{ timestamp: 1_789_084_800, values: [value] }] }] }] }] }
}

describe('global Google Trends experiment script', () => {
  it('limits itself to five isolated global requests and aggregates only provider reports', async () => {
    const client = { explore: vi.fn(async ({ keywords, timeRange, measurementTarget }) => {
      expect(timeRange).toBe('past_day')
      expect(measurementTarget).toBe('global')
      return { task: { keywords, time_range: timeRange, item_types: ['google_trends_graph'] }, response: response(keywords[0], 25) }
    }) }
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await runGlobalGoogleTrendsExperiment({ client })
    expect(client.explore).toHaveBeenCalledTimes(5)
    expect(result).toMatchObject({ providerRequests: 5, providerCost: 0.05, totals: { graphPointCount: 5, positive: 5, usableHourlyPoints: 5 } })
    expect(GLOBAL_GOOGLE_TRENDS_EXPERIMENT_TOPICS).toEqual(['iphone', 'bitcoin', 'android', 'real madrid', 'nfl'])
    expect(output.mock.calls.flat().join('\n')).not.toContain('password')
    output.mockRestore()
  })
})
