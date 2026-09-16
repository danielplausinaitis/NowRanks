import { pathToFileURL } from 'node:url'
import { createDataForSeoGoogleTrendsClient, googleTrendsProviderReportedCost, inspectDataForSeoGoogleTrendsResponse } from '../live/dataForSeoGoogleTrends.mjs'

export const GLOBAL_GOOGLE_TRENDS_EXPERIMENT_TOPICS = Object.freeze(['iphone', 'bitcoin', 'android', 'real madrid', 'nfl'])

function safeTask(task) {
  return { keywords: task.keywords, time_range: task.time_range, item_types: task.item_types, ...(task.type ? { type: task.type } : {}) }
}

function printReport(report) {
  console.log(`Google Trends global result: query=${report.query}; task=${report.taskStatusCode}; graph=${report.graphPresent ? 'yes' : 'no'}; points=${report.graphPointCount}; positive=${report.positive}; zero=${report.zero}; null=${report.null}; missing=${report.missing}; invalid=${report.invalid}; usable=${report.usableHourlyPoints}; min-positive=${report.minimumPositiveValue ?? 'none'}; max=${report.maximumValue ?? 'none'}; first=${report.firstTimestamp ?? 'none'}; last=${report.lastTimestamp ?? 'none'}; returned-location=${report.returnedLocation ?? 'global/none'}; returned-language=${report.returnedLanguage ?? 'default/none'}.`)
}

export async function runGlobalGoogleTrendsExperiment({ client, topics = GLOBAL_GOOGLE_TRENDS_EXPERIMENT_TOPICS } = {}) {
  if (!client?.explore) throw new Error('Google Trends experiment requires an injected client')
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 5) throw new Error('Google Trends experiment permits one to five topics')
  console.log(`Google Trends global experiment: estimated provider requests ${topics.length}; no database, ingestion, scheduler, Search Volume, or SerpApi access.`)
  const reports = []
  let providerCost = 0
  for (const query of topics) {
    const measured = await client.explore({ keywords: [query], timeRange: 'past_day', measurementTarget: 'global' })
    console.log(`Google Trends global request: ${JSON.stringify(safeTask(measured.task))}`)
    providerCost += googleTrendsProviderReportedCost(measured.response)
    const report = inspectDataForSeoGoogleTrendsResponse({ response: measured.response, task: measured.task, query })
    reports.push(report)
    printReport(report)
  }
  const totals = reports.reduce((total, report) => ({
    graphPointCount: total.graphPointCount + report.graphPointCount,
    positive: total.positive + report.positive,
    zero: total.zero + report.zero,
    null: total.null + report.null,
    missing: total.missing + report.missing,
    invalid: total.invalid + report.invalid,
    usableHourlyPoints: total.usableHourlyPoints + report.usableHourlyPoints,
  }), { graphPointCount: 0, positive: 0, zero: 0, null: 0, missing: 0, invalid: 0, usableHourlyPoints: 0 })
  console.log(`Google Trends global aggregate: points=${totals.graphPointCount}; positive=${totals.positive}; zero=${totals.zero}; null=${totals.null}; missing=${totals.missing}; invalid=${totals.invalid}; usable=${totals.usableHourlyPoints}; provider-reported-cost=$${providerCost.toFixed(4)}.`)
  return { reports, totals, providerCost, providerRequests: topics.length }
}

export async function main({ env = process.env } = {}) {
  return runGlobalGoogleTrendsExperiment({ client: createDataForSeoGoogleTrendsClient({ env }) })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Google Trends global experiment failed: ${error.message}`)
    process.exitCode = 1
  })
}
