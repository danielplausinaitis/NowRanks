import { createServerSupabaseClient } from '../supabase/client.mjs'
import { pathToFileURL } from 'node:url'
import { assertReplayDatabaseWriteAllowed, getIngestionStaleAfterMinutes, ingestNormalizedTopicData } from '../ingestion/persistence.mjs'
import { createSupabaseIngestionRepository } from '../ingestion/supabaseRepository.mjs'
import { formatErrorDiagnostics } from '../ingestion/errorDiagnostics.mjs'

async function loadReplayData() {
  const { createServer } = await import('vite')
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
  try {
    const providerModule = await vite.ssrLoadModule('/src/data/googleTrendingNowProvider.ts')
    return new providerModule.GoogleTrendingNowSearchDataProvider().getAllTopicData()
  } finally {
    await vite.close()
  }
}

export async function runReplayIngestion({ recoverStaleRun = false } = {}) {
  const controller = new AbortController()
  const onSigint = () => {
    if (!controller.signal.aborted) {
      console.error('NowRanks replay ingestion interruption requested; marking the claimed run failed after the active request finishes.')
      controller.abort(new Error('Ingestion interrupted by SIGINT'))
    }
  }
  process.once('SIGINT', onSigint)
  try {
    assertReplayDatabaseWriteAllowed()
    console.log('NowRanks replay ingestion: writing deterministic replay data only. This is NOT live Google data.')
    const data = await loadReplayData()
    const result = await ingestNormalizedTopicData({
      data,
      idempotencyKey: 'google-trending-now-replay:2026-08-25:v1',
      repository: createSupabaseIngestionRepository(createServerSupabaseClient()),
      staleAfterMinutes: getIngestionStaleAfterMinutes(),
      recoverStaleRun,
      signal: controller.signal,
      onProgress: (progress) => {
        if (typeof progress === 'string') console.log(`NowRanks replay ingestion stage: ${progress}`)
        else console.log(`NowRanks replay ingestion Observations: ${progress.completed} / ${progress.total} (${progress.batches} batches)`)
      },
    })
    console.log(`Replay ingestion ${result.status}: ${result.candidates} candidates, ${result.observations} observations, ${result.observationBatches} batches, ${(result.elapsedMs / 1000).toFixed(1)} seconds.`)
  } catch (error) {
    const message = formatErrorDiagnostics(error)
    console.error(`NowRanks replay ingestion did not run: ${message}`)
    process.exitCode = controller.signal.aborted ? 130 : 1
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runReplayIngestion()
}
