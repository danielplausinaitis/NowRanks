import { createServerSupabaseClient } from '../supabase/client.mjs'

function messageFor(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return error instanceof Error ? error.message : String(error ?? 'Unknown error')
}

function classifyFailure(error) {
  const message = messageFor(error)
  const normalized = message.toLowerCase()
  const status = error?.status
  const code = error?.code

  if (status === 401 || /authentication|invalid api key|api key|jwt/.test(normalized)) {
    return { kind: 'authentication failure', message }
  }

  if (status === 403 || code === '42501' || /permission denied|row-level security|rls/.test(normalized)) {
    return { kind: 'API/RLS/permission failure', message }
  }

  return { kind: 'network/configuration failure', message }
}

async function main() {
  try {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.from('candidates').select('candidate_id').limit(1)
    if (error) throw error

    if (data.length === 0) {
      console.log('NowRanks Supabase Data API connectivity check succeeded: candidates contains zero rows.')
    } else {
      console.log(`NowRanks Supabase Data API connectivity check succeeded: candidates returned ${data.length} row.`)
    }
  } catch (error) {
    const failure = classifyFailure(error)
    console.error(`NowRanks Supabase Data API connectivity check failed (${failure.kind}): ${failure.message}`)
    process.exitCode = 1
  }
}

void main()
