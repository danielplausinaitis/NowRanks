export type AnalyticsEvent = 'app_open' | 'rankings_view' | 'window_changed' | 'mode_changed' | 'premium_view' | 'sign_in_started' | 'sign_in_completed'
export type Analytics = { track: (event: AnalyticsEvent, properties?: Record<string, string>) => void }

/** Privacy-first no-op by default. Connect a consent-aware provider here after selecting one. */
export function createAnalytics(enabled = false): Analytics {
  return { track(event, properties = {}) { if (enabled && import.meta.env.DEV) console.info('NowRanks analytics', event, properties) } }
}
