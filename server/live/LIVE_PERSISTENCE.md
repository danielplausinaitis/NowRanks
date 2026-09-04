# Gated live persistence

The live ingestion path is server-only, manual, and dry-run by default. It never falls back to replay and is not called by tests, builds, the API, the frontend, or development startup.

## Schema decision

The existing schema is partially reusable:

- `candidates` retains canonical query identity and prevents duplicate normalized queries;
- `source_provenance` records DataForSEO historical-series provenance;
- `observations` stores available and explicitly missing historical buckets without converting missing values to zero;
- `ingestion_runs` supplies cycle idempotency, failure status, and controlled stale recovery.

The existing `leaderboard_snapshots` and `leaderboard_snapshot_entries` are not sufficient for live results. Their score and component fields are non-null, their rank has no lane, and their uniqueness does not distinguish the live model. Altering them would risk replay semantics. Migration `002_live_persistence.sql` therefore adds:

- `live_provider_evidence` for normalized, credential-free SerpApi discovery, DataForSEO baseline-demand, and history-request metadata;
- `live_leaderboard_snapshots` for one live cycle/window snapshot;
- `live_leaderboard_snapshot_entries` for explicitly established or emerging rows.

There is intentionally no `trending_rank` or unified rank. `lane_rank` is unique only within `(snapshot_id, score_lane)`. Established rows require Overall and established Trending scores; Emerging rows require both to be `NULL` and store only Emerging Trending.

The migration enables RLS on every new table, revokes access from `anon` and `authenticated`, and grants the server `service_role` access. No migration is needed for a dry run. Apply it manually in the Supabase SQL Editor only before attempting a write-enabled run.

## Idempotency

The cycle key is:

`live:serpapi-dataforseo:<cycle-id>:<window>:v1`

When `LIVE_INGEST_CYCLE_ID` is unset, the command uses the current UTC hour. Set it explicitly when retrying the same intended cycle. Run, provenance, evidence, observation, snapshot, and snapshot-entry UUIDs are deterministic. Candidate identity is stable by normalized query; the repository reuses an existing candidate row where replay and live evidence refer to the same query. Historical observations use deterministic candidate/provider/timestamp identity, and all writes are upserts.

A succeeded cycle is a no-op. A failed cycle can retry the same rows. A recent running cycle is blocked. A stale cycle requires explicit `LIVE_INGEST_RECOVER_STALE=true` and uses the shared `INGESTION_STALE_AFTER_MINUTES` threshold.

## Safety configuration

`LIVE_INGEST_DRY_RUN=true` is the default. It performs provider discovery, measurement, scoring, and plan construction but never creates a Supabase client or calls a repository.

Real writes require both:

```text
LIVE_INGEST_DRY_RUN=false
ALLOW_LIVE_DATABASE_WRITE=true
```

`ALLOW_REPLAY_DATABASE_WRITE` has no effect on live writes. `LIVE_INGEST_CANDIDATE_LIMIT` defaults to 10 and must remain between 2 and 20. `LIVE_INGEST_TRENDS_MODE` defaults to `single`; `LIVE_INGEST_HISTORY_WINDOW` defaults to `1Y`.

## First manual command

The safe first run from Git Bash is:

```bash
LIVE_INGEST_DRY_RUN=true LIVE_INGEST_CANDIDATE_LIMIT=10 LIVE_INGEST_HISTORY_WINDOW=1Y LIVE_INGEST_TRENDS_MODE=single npm run ingest:live
```

It will label the run `LIVE EXTERNAL DATA — DRY RUN — NOT PERSISTED`, report each provider/scoring stage, and print:

- the UTC-hour cycle identifier and complete idempotency key;
- discovered, established, emerging, and insufficient counts;
- observations, provenance, evidence, snapshot headers, and ranked snapshot entries that would be written;
- SerpApi, Search Volume, and Trends request counts;
- provider-reported Search Volume, Trends, and total DataForSEO cost;
- `Dry run complete: zero database writes performed.`

Provider-derived counts and costs vary by the real response. No credential, authorization header, or environment dump is printed.
