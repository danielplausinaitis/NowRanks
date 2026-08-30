import pg from 'pg'

const { Pool } = pg

export const DATABASE_URL_ENV = 'SUPABASE_DATABASE_URL'

/** Server-only configuration: never import this module from React or any Vite client module. */
export function getDatabaseUrl(env = process.env) {
  const connectionString = env[DATABASE_URL_ENV]
  if (!connectionString) throw new Error(`${DATABASE_URL_ENV} is required for server-side database access`)
  return connectionString
}

/** Creates a lazy PostgreSQL pool; no network connection is made until a query is issued. */
export function createDatabasePool(env = process.env) {
  return new Pool({
    connectionString: getDatabaseUrl(env),
    max: 1,
  })
}
