# NowRanks database schema

`migrations/001_initial_nowranks_schema.sql` is the initial PostgreSQL schema. It is plain SQL and deliberately does not require an ORM, a database connection, or PostgreSQL extensions. The future backend supplies UUID primary keys and runs migrations.

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
