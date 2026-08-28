BEGIN;

CREATE TABLE ingestion_runs (
  run_id uuid PRIMARY KEY,
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  data_mode text NOT NULL CHECK (data_mode IN ('live', 'replay', 'test')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  records_received integer NOT NULL DEFAULT 0 CHECK (records_received >= 0),
  records_accepted integer NOT NULL DEFAULT 0 CHECK (records_accepted >= 0),
  records_rejected integer NOT NULL DEFAULT 0 CHECK (records_rejected >= 0),
  error_summary text,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE source_provenance (
  provenance_id uuid PRIMARY KEY,
  ingestion_run_id uuid REFERENCES ingestion_runs(run_id) ON DELETE RESTRICT,
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  data_mode text NOT NULL CHECK (data_mode IN ('live', 'replay', 'test')),
  source_observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  source_version text,
  collection_method text,
  geographic_scope jsonb NOT NULL CHECK (jsonb_typeof(geographic_scope) = 'object'),
  cross_query_comparability_status text NOT NULL CHECK (cross_query_comparability_status IN ('comparable', 'not-comparable', 'unknown')),
  cross_query_comparability_basis text
);

CREATE TABLE candidates (
  candidate_id text PRIMARY KEY CHECK (btrim(candidate_id) <> ''),
  query_text text NOT NULL CHECK (btrim(query_text) <> ''),
  normalized_query text NOT NULL UNIQUE CHECK (btrim(normalized_query) <> ''),
  category text NOT NULL CHECK (btrim(category) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER candidates_set_updated_at
BEFORE UPDATE ON candidates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE observations (
  observation_id uuid PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  provenance_id uuid NOT NULL REFERENCES source_provenance(provenance_id) ON DELETE RESTRICT,
  observation_date date NOT NULL,
  observed_at timestamptz NOT NULL,
  availability text NOT NULL CHECK (availability IN ('available', 'missing')),
  interest_value double precision,
  missing_reason text,
  ingested_at timestamptz NOT NULL,
  CHECK (
    (availability = 'available' AND interest_value IS NOT NULL AND interest_value >= 0 AND missing_reason IS NULL)
    OR
    (availability = 'missing' AND interest_value IS NULL AND missing_reason IN ('not-reported', 'source-unavailable', 'out-of-range', 'redacted'))
  ),
  UNIQUE (candidate_id, provenance_id, observed_at)
);

CREATE TABLE leaderboard_snapshots (
  snapshot_id uuid PRIMARY KEY,
  snapshot_date date NOT NULL,
  snapshot_at timestamptz NOT NULL,
  scoring_mode text NOT NULL CHECK (scoring_mode IN ('overallScore', 'trendingScore')),
  selected_window text NOT NULL CHECK (selected_window IN ('24H', '7D', '30D', '1Y')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, scoring_mode, selected_window)
);

CREATE TABLE leaderboard_snapshot_entries (
  snapshot_id uuid NOT NULL REFERENCES leaderboard_snapshots(snapshot_id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  rank integer NOT NULL CHECK (rank >= 1),
  nowranks_score double precision NOT NULL CHECK (nowranks_score >= 0 AND nowranks_score <= 100),
  previous_rank integer CHECK (previous_rank IS NULL OR previous_rank >= 1),
  movement integer,
  movement_state text NOT NULL CHECK (movement_state IN ('new', 'known', 'unavailable')),
  search_interest_component double precision NOT NULL CHECK (search_interest_component >= 0 AND search_interest_component <= 100),
  growth_component double precision NOT NULL CHECK (growth_component >= 0 AND growth_component <= 100),
  momentum_component double precision NOT NULL CHECK (momentum_component >= 0 AND momentum_component <= 100),
  consistency_component double precision NOT NULL CHECK (consistency_component >= 0 AND consistency_component <= 100),
  breakout_component double precision NOT NULL CHECK (breakout_component >= 0 AND breakout_component <= 100),
  PRIMARY KEY (snapshot_id, candidate_id),
  UNIQUE (snapshot_id, rank),
  CHECK (
    (movement_state = 'new' AND previous_rank IS NULL AND movement IS NULL)
    OR (movement_state = 'known' AND previous_rank IS NOT NULL AND movement IS NOT NULL)
    OR (movement_state = 'unavailable' AND previous_rank IS NULL AND movement IS NULL)
  )
);

CREATE INDEX observations_candidate_observed_at_idx ON observations (candidate_id, observed_at DESC);
CREATE INDEX observations_provenance_idx ON observations (provenance_id);
CREATE INDEX ingestion_runs_provider_started_at_idx ON ingestion_runs (provider_id, started_at DESC);
CREATE INDEX leaderboard_snapshots_lookup_idx ON leaderboard_snapshots (snapshot_date DESC, scoring_mode, selected_window);
CREATE INDEX leaderboard_snapshot_entries_candidate_idx ON leaderboard_snapshot_entries (candidate_id, snapshot_id);

COMMIT;
