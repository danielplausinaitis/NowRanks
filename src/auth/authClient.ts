import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type AuthUser = { id: string, email: string | null, name: string | null, avatarUrl: string | null, createdAt: string | null }
export type AuthClient = {
  getUser: () => Promise<AuthUser | null>
  onChange: (listener: (user: AuthUser | null) => void) => () => void
  signInWithGoogle: () => Promise<{ error?: string }>
  signOut: () => Promise<{ error?: string }>
}

function mapUser(user: { id: string, email?: string, created_at?: string, user_metadata?: Record<string, unknown> }): AuthUser {
  const metadata = user.user_metadata ?? {}
  return { id: user.id, email: user.email ?? null, name: typeof metadata.full_name === 'string' ? metadata.full_name : typeof metadata.name === 'string' ? metadata.name : null, avatarUrl: typeof metadata.avatar_url === 'string' ? metadata.avatar_url : typeof metadata.picture === 'string' ? metadata.picture : null, createdAt: user.created_at ?? null }
}

function fromSupabase(client: SupabaseClient): AuthClient {
  return {
    async getUser() { const { data } = await client.auth.getUser(); return data.user ? mapUser(data.user) : null },
    onChange(listener) { const { data } = client.auth.onAuthStateChange((_event, session) => listener(session?.user ? mapUser(session.user) : null)); return () => data.subscription.unsubscribe() },
    async signInWithGoogle() { const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}${window.location.pathname}#/account` } }); return error ? { error: error.message } : {} },
    async signOut() { const { error } = await client.auth.signOut(); return error ? { error: error.message } : {} },
  }
}

/** Only Vite public credentials are read in browser code; service credentials are never accepted. */
export function createBrowserAuthClient(env: Record<string, string | undefined> = import.meta.env): AuthClient | null {
  const url = env.VITE_SUPABASE_URL
  const anonKey = env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return fromSupabase(createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }))
}
