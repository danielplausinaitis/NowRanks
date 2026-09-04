function optionalInteger(value, name) {
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`)
  return number
}

function optionalBoolean(value, name) {
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

/** Builds the complete server-side SerpApi discovery request shared by live checks. */
export function buildSerpApiDiscoveryRequestFromEnv(env = process.env) {
  const geo = env.SERPAPI_DISCOVERY_GEO?.trim()
  if (!geo) throw new Error('SERPAPI_DISCOVERY_GEO is required (for example, US)')

  return {
    geo,
    hours: optionalInteger(env.SERPAPI_DISCOVERY_HOURS, 'SERPAPI_DISCOVERY_HOURS'),
    language: env.SERPAPI_DISCOVERY_LANGUAGE?.trim() || undefined,
    onlyActive: optionalBoolean(env.SERPAPI_DISCOVERY_ONLY_ACTIVE, 'SERPAPI_DISCOVERY_ONLY_ACTIVE'),
    categoryId: optionalInteger(env.SERPAPI_DISCOVERY_CATEGORY_ID, 'SERPAPI_DISCOVERY_CATEGORY_ID'),
    geographicScope: { kind: 'country', countryCode: geo },
  }
}
