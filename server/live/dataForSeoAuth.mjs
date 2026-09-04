export function requireDataForSeoCredentials(env = process.env) {
  const login = env.DATAFORSEO_LOGIN
  const password = env.DATAFORSEO_PASSWORD
  if (typeof login !== 'string' || !login.trim() || typeof password !== 'string' || !password) {
    throw new Error('DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are required for live DataForSEO requests')
  }
  return { login: login.trim(), password }
}

/** Builds the server-only header value in memory; callers must never log or return it. */
export function buildDataForSeoAuthorization(credentials) {
  return `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64')}`
}
