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

Snapshot format v1 has no `trending_rank` or unified rank. `lane_rank` is unique only within `(snapshot_id, score_lane)`. Established rows require Overall and established Trending scores; Emerging rows require both to be `NULL` and store only Emerging Trending.

Migration `006_unified_live_snapshot_contract.sql` is a forward-only compatibility migration written against the confirmed deployed schema, including its short-window lane. It gives snapshots an explicit format version: existing and current writes are v1; future v2 snapshots use `score_lane = 'unified'`, a unique `public_rank` (1–20), `public_score`, and an independent `evidence_status` (`established` or `emerging`). The old lane scores are `NULL` for v2 rows. `component_availability` remains the persisted component metadata. The ingestion writer deliberately remains v1 until a calibrated unified score exists.

`short-window-overall` is retained only as an opaque legacy lane so historical rows do not block the migration. The legacy reader returns a compatibility diagnostic and never turns that raw score into a unified rank.

The migration enables RLS on every new table, revokes access from `anon` and `authenticated`, and grants the server `service_role` access. No migration is needed for a dry run. Apply it manually in the Supabase SQL Editor only before attempting a write-enabled run.

## Idempotency

The cycle key is:

`live:serpapi-dataforseo:<cycle-id>:<window>:v1`

When `LIVE_INGEST_CYCLE_ID` is unset, the command uses the current UTC hour. Set it explicitly when retrying the same intended cycle. Run, provenance, evidence, observation, snapshot, and snapshot-entry UUIDs are deterministic. Candidate identity is stable by normalized query; the repository reuses an existing candidate row where replay and live evidence refer to the same query. Historical observations use deterministic candidate/provider/timestamp identity, and all writes are upserts.

A succeeded cycle is a no-op. A failed cycle can retry the same rows. A recent running cycle is blocked. A stale cycle requires explicit `LIVE_INGEST_RECOVER_STALE=true` and uses the shared `INGESTION_STALE_AFTER_MINUTES` threshold.

## Safety configuration

`LIVE_INGEST_DRY_RUN=true` is the default. It performs provider discovery, measurement, scoring, and plan construction but performs no Supabase writes. The Google Trends cache repository is bypassed entirely in this mode, so its storage migration is not required for a dry run.

Real writes require both:

```text
LIVE_INGEST_DRY_RUN=false
ALLOW_LIVE_DATABASE_WRITE=true
```

`ALLOW_REPLAY_DATABASE_WRITE` has no effect on live writes. The adaptive defaults are `LIVE_DISPLAY_LIMIT=20`, `LIVE_DISCOVERY_LIMIT=50`, `LIVE_INITIAL_PAID_CANDIDATES=15`, and `LIVE_MAX_PAID_CANDIDATES=50` (each bounded at 2–100). Discovery is a cheap SerpApi pool; the maximum paid cohort is the bounded Search Volume/Trends exposure; the display is **up to** 20 truthful ranked topics. The baseline request pre-warms the maximum paid cohort in one bulk task so an expansion does not trigger a second bulk request; Trends expands only if fewer than twenty eligible topics are found. `LIVE_INGEST_CANDIDATE_LIMIT` remains a compatibility override that makes discovery, initial paid, and maximum paid cohorts equal. `LIVE_INGEST_TRENDS_MODE` defaults to `single`; `LIVE_INGEST_HISTORY_WINDOW` defaults to `1Y`.

The scheduler preflight always prices the maximum paid cohort (not the initial batch), including four window-specific Trends passes and one cold Search Volume bulk refresh. Runtime diagnostics report the actual Trends candidates and provider-reported cost. v2 snapshots rank every eligible candidate with one common public model and store Established/Emerging as descriptive evidence status only. An undersupplied source remains an honest “up to 20” result.

## Production scheduler

The scheduler is disabled by default. `npm run scheduler:start` is the sole long-running entrypoint and delegates every slot to the same `runLiveIngestion` path used by manual ingestion; it contains no scoring, tracking, alignment, or Growth implementation. It schedules only fixed UTC boundaries `00:00`, `04:00`, `08:00`, `12:00`, `16:00`, and `20:00`; `LIVE_REFRESH_INTERVAL_MINUTES` is deliberately constrained to `240`.

Before provider work, the process claims a deterministic `live:scheduler-slot:<UTC slot>` lease in existing `ingestion_runs`. The process-local lock and a read of any currently-running scheduler lease prevent duplicate or overlapping paid cycles. A running lease is never auto-reclaimed: a long-running or stranded cycle is safer to report than to overlap. Terminal slot leases also prevent a scheduler restart from retrying the same slot forever. Within one claimed cycle, retryable network/provider failures retry at most `LIVE_SCHEDULER_RETRY_LIMIT` times after exponential delays beginning at `LIVE_SCHEDULER_RETRY_BASE_DELAY_SECONDS`; configuration, authorization, validation, cost-cap, and ordinary 4xx failures are terminal.

`npm run scheduler:check` is read-only. It shows configuration, intended UTC slots, the latest succeeded and failed scheduled ingestion runs, an active lease, whether that lease is stale according to `LIVE_SCHEDULER_STALE_AFTER_MINUTES`, and whether the latest success is overdue. It uses the existing `ingestion_runs` table; no scheduler migration is required.

## Persisted live rank movement

Live reads select an explicit reader by snapshot format. v1 compares each current row with the closest strictly earlier successful snapshot for the same window and lane. v2 compares only the previous successful v2 snapshot for the same window, by stable candidate ID and `public_rank`; it never maps a legacy lane rank into a unified rank. `delta = previousRank - currentRank`: positive is `up`, negative is `down`, and zero is `unchanged`. The first v2 snapshot is therefore `unavailable`; later absent topics are `new`. Category filtering occurs only after global movement, preserving persisted ranks. Unsupported formats or lanes are returned with compatibility diagnostics rather than crashing the whole snapshot.

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
