import { UNIFIED_PUBLIC_PROFILES, UNIFIED_PUBLIC_SCORE } from './unifiedPublicScoring.mjs'

export const UNIFIED_SCORE_COMPONENTS = Object.freeze([
  'currentAttention', 'baselineDemand', 'acceleration', 'momentum', 'consistency', 'breakout', 'recency',
])

function finite(value) { return Number.isFinite(value) ? value : null }

function componentReason(entry, name, value) {
  if (value !== null) return null
  if (name === 'currentAttention') return 'missing-current-trend-intensity'
  if (name === 'baselineDemand') return 'missing-baseline-demand'
  if (name === 'acceleration') return entry?.componentDiagnostics?.growth?.reason ?? 'missing-historical-growth-and-discovery-acceleration'
  if (name === 'recency') return 'missing-or-invalid-discovery-start-time'
  return entry?.componentDiagnostics?.[name]?.reason ?? 'component-unavailable'
}

/**
 * Produces an inspectable decomposition of the already-computed unified score.
 * This is deliberately downstream of the scorer: it cannot influence score
 * inputs, normalization, eligibility, ordering, or the public score.
 */
export function unifiedScoreContributions({ window, components, availableWeight, evidenceMatch }) {
  const profile = UNIFIED_PUBLIC_PROFILES[window]
  if (!profile) throw new Error('Unified score diagnostics require a supported window')
  const denominator = finite(availableWeight)
  const modifier = finite(evidenceMatch)
  return Object.fromEntries(UNIFIED_SCORE_COMPONENTS.map((name) => {
    const value = finite(components?.[name])
    const configuredWeight = profile.weights[name]
    const available = configuredWeight > 0 && value !== null
    const normalizedContribution = available && denominator && modifier !== null
      ? value * configuredWeight / denominator * modifier
      : null
    return [name, {
      configuredWeight,
      available,
      normalizedValue: value,
      contribution: normalizedContribution,
    }]
  }))
}

/** A compact, credential-free future evidence payload for every measured candidate. */
export function serializeUnifiedScoreDiagnostic({ entry, window, wouldBeRank = null, publicDisplayLimit = 20 }) {
  const components = entry?.unifiedComponents ?? {}
  const contributions = unifiedScoreContributions({
    window,
    components,
    availableWeight: entry?.unifiedAvailableWeight,
    evidenceMatch: entry?.unifiedEvidenceMatch,
  })
  return {
    version: 'unified-public-score-diagnostic-v1',
    category: entry?.category ?? null,
    eligibility: entry?.status ?? 'unknown',
    exclusionReason: !Number.isFinite(entry?.unifiedRawScore)
      ? (entry?.confidenceReason ?? 'unified-score-unavailable')
      : Number.isInteger(wouldBeRank) && wouldBeRank > publicDisplayLimit
        ? 'outside-public-top-20'
        : null,
    wouldBeRank,
    currentIntensityRaw: finite(entry?.raw?.currentTrendIntensity?.searchVolume),
    currentIntensityNormalized: finite(entry?.normalized?.currentTrendIntensity),
    baselineDemandRaw: finite(entry?.raw?.baselineDemand?.searchVolume),
    baselineDemandNormalized: finite(entry?.normalized?.baselineDemand),
    accelerationProviderRaw: finite(entry?.raw?.currentTrendIntensity?.increasePercentage),
    accelerationSource: entry?.unifiedAccelerationSource ?? null,
    accelerationFallbackScale: finite(entry?.unifiedDiscoveryFallbackScale),
    historyCoverage: finite(entry?.history?.coveragePercentage),
    evidenceMatch: finite(entry?.unifiedEvidenceMatch),
    availableWeight: finite(entry?.unifiedAvailableWeight),
    components: Object.fromEntries(UNIFIED_SCORE_COMPONENTS.map((name) => [name, {
      ...contributions[name],
      preCohortValue: finite(entry?.raw?.scoringComponents?.[name]),
      reason: componentReason(entry, name, contributions[name].normalizedValue),
    }])),
    unifiedRawScore: finite(entry?.unifiedRawScore),
    publicScore: finite(entry?.nowScore),
    publicScoreTransform: { ...UNIFIED_PUBLIC_SCORE },
  }
}
