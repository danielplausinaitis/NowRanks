import { createLeaderboardService } from '../application/leaderboardService.mjs'
import { createViteLeaderboardEngine } from '../application/viteLeaderboardEngine.mjs'
import { createApiHandler } from '../api/handler.mjs'
import { createApiServer } from '../api/server.mjs'
import { readPersistedTopicData } from '../read/persistedData.mjs'
import { createSupabaseReadRepository } from '../read/supabaseReadRepository.mjs'
import { createServerSupabaseClient } from '../supabase/client.mjs'

const port = Number(process.env.NOWRANKS_API_PORT ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('NOWRANKS_API_PORT must be a valid TCP port')

const { rankingEngine, close: closeEngine } = await createViteLeaderboardEngine()
const leaderboardService = createLeaderboardService({
  rankingEngine,
  readPersistedTopicData: (request) => readPersistedTopicData({
    repository: createSupabaseReadRepository(createServerSupabaseClient()),
    ...request,
  }),
})
const server = createApiServer({ handler: createApiHandler({ leaderboardService }) })

server.listen(port, '127.0.0.1', () => console.log(`NowRanks API listening on http://127.0.0.1:${port}`))

async function shutdown(signal) {
  console.log(`NowRanks API received ${signal}; shutting down.`)
  server.close(async () => {
    await closeEngine()
    process.exit(0)
  })
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
