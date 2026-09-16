export const LIVE_TRENDS_PROVIDERS = Object.freeze({
  legacy: Object.freeze({ id: 'dataforseo-trends', transport: 'dataforseo-trends', forcedMode: null }),
  googleGlobal24h: Object.freeze({ id: 'dataforseo-google-trends', transport: 'google-trends', forcedMode: 'single' }),
})

/**
 * Global Google Trends is enabled only for the proven past_day/24H shape. Longer Google Trends
 * resolutions have not been validated against the current daily/weekly scorer cadence, so they
 * deliberately retain the established provider until that evidence exists.
 */
export function resolveLiveTrendsProvider({ measurementMode, historyWindow }) {
  if (!['global', 'us'].includes(measurementMode)) throw new Error('Live Trends measurement mode must be global or us')
  if (!['24H', '7D', '30D', '1Y'].includes(historyWindow)) throw new Error('Live Trends history window is unsupported')
  return measurementMode === 'global' && historyWindow === '24H'
    ? LIVE_TRENDS_PROVIDERS.googleGlobal24h
    : LIVE_TRENDS_PROVIDERS.legacy
}
