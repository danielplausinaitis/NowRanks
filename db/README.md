# NowRanks database schema

`migrations/001_initial_nowranks_schema.sql` is the initial PostgreSQL schema. It is plain SQL and deliberately does not require an ORM, a database connection, or PostgreSQL extensions. The future backend supplies UUID primary keys and runs migrations.

`migrations/004_observation_missing_measurement_reason.sql` is a forward-only update to `observations_check`. It preserves the available-versus-missing value invariant and adds `invalid-provider-measurement` to the closed missing-reason vocabulary used for malformed individual live-provider cells.

`migrations/006_unified_live_snapshot_contract.sql` is a forward-only live-read-model migration written for the confirmed deployed short-window schema. It preserves v1 lane snapshots and adds explicit v2 snapshot versioning plus the future unified public rank, score, and evidence-status fields. It must be applied manually before any v2 snapshot writer is enabled.

`migrations/010_canonical_alignment_gap_diagnostics.sql` is an additive diagnostics migration for the canonical-attention writer. It records the prior canonical gap, overlap-based resume decision, reason, and new-regime decision; it creates no points and must be applied manually before the v2 canonical alignment writer is enabled.

`migrations/011_live_google_trends_history_cache.sql` is an additive, server-only cache table for the economical global Google Trends path. It is keyed by a stable hash over candidate, provider, measurement mode/target, time range, and resampling identity; it retains batch metadata for auditability. Apply it manually in the Supabase SQL Editor only before write-enabled ingestion that persists Google Trends cache rows.

`migrations/012_live_daily_discovery_cache.sql` is an additive, server-only daily candidate-universe cache for the production scheduler. Apply it manually before enabling the refactored scheduler; it is required to share one fresh five-country discovery result across the due 24H, 7D, 30D, and 1Y jobs.

## Canonical mapping

- `candidates` stores the stable `SearchTopic` identity: ID, display query, normalized query, and category.
- `source_provenance` stores `SourceProvenance`. Its `data_mode` keeps `live`, `replay`, and `test` data explicit; `geographic_scope` stores the canonical scope object as JSONB.
- `observations` stores the canonical `TopicObservation`. Available values can be zero; missing values require `interest_value = NULL` and an allowed missing reason. Each observation references its candidate and provenance row.
- `ingestion_runs` records a provider run and prevents duplicate processing through its unique idempotency key.
- `leaderboard_snapshots` stores one immutable scoring mode/window result for a date. `leaderboard_snapshot_entries` stores each ranked candidate, unrounded score, movement state, and all five score components.

## Important rules

- UUID values are application-generated in the future backend; no database extension is needed at this stage.
- The unique observation key is `(candidate_id, provenance_id, observed_at)`. A replay row and a live row therefore cannot overwrite one another.
- Cross-query comparability is stored in provenance. The existing domain validator rejects non-comparable and unknown data before scoring; the future backend must retain that behavior.
- This migration creates storage only. It does not ingest data, create an API, select live sources, or treat replay data as production data.
