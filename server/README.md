# Server-side database connection

This directory is server-only. Do not import modules from `server/` into `src/`, React components, or any Vite client module.

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
