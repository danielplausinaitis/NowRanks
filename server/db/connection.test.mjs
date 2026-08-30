import { describe, expect, it } from 'vitest'
import { DATABASE_URL_ENV, getDatabaseUrl } from './connection.mjs'

describe('server-only database configuration', () => {
  it('uses a non-client environment variable for the PostgreSQL connection string', () => {
    expect(DATABASE_URL_ENV).toBe('SUPABASE_DATABASE_URL')
    expect(DATABASE_URL_ENV.startsWith('VITE_')).toBe(false)
  })

  it('fails before opening a connection when the database URL is absent', () => {
    expect(() => getDatabaseUrl({})).toThrow(/SUPABASE_DATABASE_URL is required/)
  })

  it('reads a supplied server-side connection string without connecting during tests', () => {
    expect(getDatabaseUrl({ SUPABASE_DATABASE_URL: 'postgresql://local-test-placeholder' }))
      .toBe('postgresql://local-test-placeholder')
  })
})
