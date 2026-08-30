import { describe, expect, it } from 'vitest'
import {
  SUPABASE_SECRET_KEY_ENV,
  SUPABASE_URL_ENV,
  getSupabaseConfig,
} from './client.mjs'

describe('server-only Supabase configuration', () => {
  it('uses only non-client environment variable names', () => {
    expect(SUPABASE_URL_ENV).toBe('SUPABASE_URL')
    expect(SUPABASE_SECRET_KEY_ENV).toBe('SUPABASE_SECRET_KEY')
    expect(SUPABASE_URL_ENV.startsWith('VITE_')).toBe(false)
    expect(SUPABASE_SECRET_KEY_ENV.startsWith('VITE_')).toBe(false)
  })

  it('does not fall back to VITE_ variables', () => {
    expect(() => getSupabaseConfig({
      VITE_SUPABASE_URL: 'https://client.example.supabase.co',
      VITE_SUPABASE_SECRET_KEY: 'client-visible-secret',
    })).toThrow(/SUPABASE_URL is required/)
  })

  it('fails clearly when the URL is missing', () => {
    expect(() => getSupabaseConfig({ SUPABASE_SECRET_KEY: 'test-secret' }))
      .toThrow(/SUPABASE_URL is required/)
  })

  it('fails clearly when the secret key is missing', () => {
    expect(() => getSupabaseConfig({ SUPABASE_URL: 'https://example.supabase.co' }))
      .toThrow(/SUPABASE_SECRET_KEY is required/)
  })

  it('reads supplied server-side configuration without making a request', () => {
    expect(getSupabaseConfig({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'test-secret',
    })).toEqual({
      url: 'https://example.supabase.co',
      secretKey: 'test-secret',
    })
  })
})
