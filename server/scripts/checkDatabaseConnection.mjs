import { createDatabasePool } from '../db/connection.mjs'

async function main() {
  let pool
  try {
    pool = createDatabasePool()
    const result = await pool.query('SELECT 1 AS ok')
    if (result.rows[0]?.ok !== 1) throw new Error('Database did not return the expected health-check result')
    console.log('NowRanks database connectivity check succeeded.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database connectivity error'
    console.error(`NowRanks database connectivity check failed: ${message}`)
    process.exitCode = 1
  } finally {
    if (pool) await pool.end()
  }
}

void main()
