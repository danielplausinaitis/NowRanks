import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL_ENV = 'SUPABASE_URL'
export const SUPABASE_SECRET_KEY_ENV = 'SUPABASE_SECRET_KEY'

/**
 * Server-only Supabase Data API configuration. Never import this module from
 * React, src/, or any other Vite client module.
 */
export function getSupabaseConfig(env = process.env) {
  const url = env[SUPABASE_URL_ENV]
  const secretKey = env[SUPABASE_SECRET_KEY_ENV]

  if (!url) throw new Error(`${SUPABASE_URL_ENV} is required for server-side Supabase access`)
  if (!secretKey) throw new Error(`${SUPABASE_SECRET_KEY_ENV} is required for server-side Supabase access`)

  return { url, secretKey }
}

/** Creates a server-only Data API client. It does not issue a request until used. */
export function createServerSupabaseClient(env = process.env) {
  const { url, secretKey } = getSupabaseConfig(env)
  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
}
