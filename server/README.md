# Server-side database connection

This directory is server-only. Do not import modules from `server/` into `src/`, React components, or any Vite client module.

## Live-provider boundary

The server-only live boundary is documented in [live/README.md](./live/README.md). Its SerpApi discovery and DataForSEO measurement transports validate into canonical topic data with `dataMode: live` and have no replay fallback. The manual live ingestion path is dry-run by default and documented in [live/LIVE_PERSISTENCE.md](./live/LIVE_PERSISTENCE.md); it is not used by the current API or frontend.

DataForSEO Google Ads Search Volume provides the separate common-scale baseline-demand signal. Its read-only check accepts up to 1,000 keywords in one request:

```powershell
npm run live:volume-check -- "ChatGPT" "iPhone" "Tesla"
```

Configure existing `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`, one explicit `DATAFORSEO_LOCATION_*` value, and optional language/history variables from `.env.example`. The command clearly labels external live data as not persisted and has no database dependency.

The bounded shadow scorer combines all three read-only live sources without affecting persisted or frontend rankings:

```powershell
npm run live:shadow-check
```

It defaults to 10 candidates (`LIVE_SHADOW_CANDIDATE_LIMIT`, allowed 2–20), single-keyword historical retrieval (`LIVE_SHADOW_TRENDS_MODE=single`), and the elapsed-time-aware one-year window (`LIVE_SHADOW_HISTORY_WINDOW=1Y`). It prints raw and normalized diagnostics, cadence, component-specific history availability, and separate provider request counts/costs, and never invokes ingestion or Supabase.

## Supabase Data API connection

The Supabase Data API client is the development connection foundation. It is independent of the existing PostgreSQL `pg` setup, which remains available but is not used by this check.

1. Copy `.env.example` to an untracked `.env` file.
2. Set `SUPABASE_URL` to the project's Supabase URL.
3. Set `SUPABASE_SECRET_KEY` to a server-side Supabase **secret key**. If the project only exposes a legacy `service_role` key, place that value in `SUPABASE_SECRET_KEY` instead.
4. Run the read-only check:

```powershell
npm run supabase:check
```

The check sends `select candidate_id from candidates limit 1` through the Data API. It reports zero rows and one returned row as separate successful outcomes. Authentication, API/RLS/permission, and network/configuration failures are labeled separately. It never writes data or changes the schema.

`SUPABASE_SECRET_KEY` must never have a `VITE_` prefix and must never be imported into Vite or React client code.

## Development replay ingestion

The development-only replay script is the first persistent ingestion path. It uses the existing deterministic replay provider and **never represents its data as live Google data**.

Set this explicit local opt-in in `.env` before running it:

```text
ALLOW_REPLAY_DATABASE_WRITE=true
```

Then run:

```powershell
npm run ingest:replay
```

The script refuses to write without that exact value. It uses the deterministic key `google-trending-now-replay:2026-08-25:v1`; once successful, rerunning it returns an already-completed no-op. It is never invoked by the application, tests, build, or normal development startup.

An active replay run is protected from concurrent execution. A run is stale after 15 minutes by default; set `INGESTION_STALE_AFTER_MINUTES` to a positive number to change that development threshold. A normal replay command refuses stale runs until recovery is explicitly requested:

```powershell
npm run ingest:replay:recover
```

Recovery remains protected by `ALLOW_REPLAY_DATABASE_WRITE=true`, reuses the same idempotency identity, and safely upserts deterministic candidate, provenance, and observation records.

Observations are upserted in bounded batches of 500 records per Data API request. Progress reports completed observations, total observations, and batch count. If Ctrl+C is received, the script waits for the active request to return, then makes a best-effort attempt to mark the claimed ingestion run as failed before exiting.

## Persisted-data read check

The server-only reader pages through persisted candidates, provenance, and observations, reconstructs the canonical topic-data shape, and reads only the selected ranking window. It does not modify Supabase.

```powershell
npm run data:read-check
```

This verification reads the explicit `google-trending-now` `replay` dataset and prints that it is not live Google data.

## Persisted leaderboard check

The application leaderboard service reads canonical persisted data and invokes the existing `src/domain/leaderboard.ts` ranking engine; it does not carry a second scoring formula. This is read-only and development-only until a future HTTP API calls the same service.

```powershell
npm run leaderboard:check -- 7D
```

Use `24H`, `7D`, `30D`, or `1Y` as the optional window argument. The check always labels the selected replay dataset as not live Google data.

## Development HTTP API

Start the local, read-only API server:

```powershell
npm run api:dev
```

Then request [health](http://127.0.0.1:8787/api/health) or the [7-day replay leaderboard](http://127.0.0.1:8787/api/leaderboard?window=7D). The API permits only `GET` and exposes no CORS headers. Vite proxies `/api` to this loopback server during development, so a future frontend can use same-origin API calls without broad CORS.

`window` accepts `24H`, `7D`, `30D`, or `1Y`; `category` is optional. `mode` accepts `overall` (the default) or `trending`. Unknown or repeated query parameters are rejected with a JSON `400` response. Leaderboard responses use a short private cache; health and errors are not cached.

`LEADERBOARD_DATA_SOURCE` is a server-only, strict `replay` (default) or `live` setting. `live` reads only persisted Supabase live snapshots; it never runs ingestion, contacts providers, or falls back to replay. In live mode, `overall` returns only the Established lane. `trending` returns Established and Emerging as separate lanes, never a unified rank. Category filtering narrows persisted lanes but retains global `laneRank` values because the stored snapshot was ranked for the full cohort and is not defensibly reranked after filtering.

To verify the persisted live API path without writing data, run this in Git Bash (terminal 1):

```bash
LEADERBOARD_DATA_SOURCE=live npm run api:dev
```

Then, in terminal 2:

```bash
curl "http://127.0.0.1:8787/api/leaderboard?window=1Y&mode=overall"
curl "http://127.0.0.1:8787/api/leaderboard?window=1Y&mode=trending"
```

In PowerShell, use `$env:LEADERBOARD_DATA_SOURCE = 'live'; npm run api:dev` for terminal 1. This path makes only Supabase Data API reads against the persisted live snapshot.

## Local configuration

1. Copy `.env.example` to an untracked `.env` file.
2. Set only `SUPABASE_DATABASE_URL` to your PostgreSQL connection URI.
3. Run the read-only health check:

```powershell
npm run db:check
```

The script loads `.env`, opens a one-connection PostgreSQL pool, executes only `SELECT 1 AS ok`, reports success or failure, and closes the pool. It does not insert, update, delete, or query NowRanks data.

## Supabase connection value

In the Supabase dashboard, open the NowRanks project and select **Connect**. Copy a PostgreSQL connection URI appropriate for your runtime into the local `SUPABASE_DATABASE_URL` value. For a future long-running server, the Session pooler URI is the normal choice; retain the URI's SSL options. Use the direct URI only when its network requirements are satisfied.

Never put the URI, database password, service-role key, or any other secret in `.env.example`, source files, browser variables, screenshots, or Git. The existing `.gitignore` ignores `.env` and `.env.*` while allowing `.env.example` to be tracked.

No Supabase browser key is needed for this milestone. RLS remains enabled and no policies are created here.
