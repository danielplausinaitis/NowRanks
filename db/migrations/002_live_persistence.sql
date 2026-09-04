BEGIN;

-- Normalized, credential-free evidence that does not fit the historical interest observation table.
CREATE TABLE live_provider_evidence (
  evidence_id uuid PRIMARY KEY,
  ingestion_run_id uuid NOT NULL REFERENCES ingestion_runs(run_id) ON DELETE RESTRICT,
  candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  data_mode text NOT NULL DEFAULT 'live' CHECK (data_mode = 'live'),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('discovery', 'baseline-demand', 'history-metadata')),
  observed_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  geographic_scope jsonb NOT NULL CHECK (jsonb_typeof(geographic_scope) = 'object'),
  availability text NOT NULL CHECK (availability IN ('available', 'missing', 'metadata')),
  evidence_payload jsonb NOT NULL CHECK (jsonb_typeof(evidence_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ingestion_run_id, candidate_id, provider_id, evidence_kind)
);

-- Live scoring cannot reuse replay snapshots truthfully: lanes, confidence, and nullable scores differ.
CREATE TABLE live_leaderboard_snapshots (
  snapshot_id uuid PRIMARY KEY,
  ingestion_run_id uuid NOT NULL REFERENCES ingestion_runs(run_id) ON DELETE RESTRICT,
  cycle_id text NOT NULL CHECK (btrim(cycle_id) <> ''),
  data_mode text NOT NULL DEFAULT 'live' CHECK (data_mode = 'live'),
  selected_window text NOT NULL CHECK (selected_window IN ('24H', '7D', '30D', '1Y')),
  scored_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, selected_window)
);

CREATE TABLE live_leaderboard_snapshot_entries (
  snapshot_entry_id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES live_leaderboard_snapshots(snapshot_id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  score_lane text NOT NULL CHECK (score_lane IN ('established', 'emerging')),
  classification text NOT NULL CHECK (classification IN ('established', 'partial-history', 'possible-new-trend')),
  confidence text NOT NULL CHECK (confidence IN ('full', 'partial-high', 'partial-low', 'emerging')),
  confidence_reason text NOT NULL CHECK (btrim(confidence_reason) <> ''),
  score_basis text NOT NULL CHECK (score_basis IN ('historical-trending', 'current-emerging-evidence')),
  overall_score double precision CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)),
  established_trending_score double precision CHECK (established_trending_score IS NULL OR (established_trending_score >= 0 AND established_trending_score <= 100)),
  emerging_trending_score double precision CHECK (emerging_trending_score IS NULL OR (emerging_trending_score >= 0 AND emerging_trending_score <= 100)),
  lane_rank integer NOT NULL CHECK (lane_rank >= 1),
  history_observation_count integer NOT NULL CHECK (history_observation_count >= 0),
  history_available_count integer NOT NULL CHECK (history_available_count >= 0),
  history_coverage_percentage double precision NOT NULL CHECK (history_coverage_percentage >= 0 AND history_coverage_percentage <= 100),
  search_interest_component double precision CHECK (search_interest_component IS NULL OR (search_interest_component >= 0 AND search_interest_component <= 100)),
  component_availability jsonb NOT NULL CHECK (jsonb_typeof(component_availability) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, candidate_id),
  UNIQUE (snapshot_id, score_lane, lane_rank),
  CHECK (
    (score_lane = 'established'
      AND overall_score IS NOT NULL
      AND established_trending_score IS NOT NULL
      AND emerging_trending_score IS NULL
      AND score_basis = 'historical-trending')
    OR
    (score_lane = 'emerging'
      AND overall_score IS NULL
      AND established_trending_score IS NULL
      AND emerging_trending_score IS NOT NULL
      AND score_basis = 'current-emerging-evidence')
  )
);

CREATE INDEX live_provider_evidence_candidate_idx ON live_provider_evidence (candidate_id, retrieved_at DESC);
CREATE INDEX live_provider_evidence_run_idx ON live_provider_evidence (ingestion_run_id);
CREATE INDEX live_leaderboard_snapshots_lookup_idx ON live_leaderboard_snapshots (scored_at DESC, selected_window);
CREATE INDEX live_leaderboard_entries_candidate_idx ON live_leaderboard_snapshot_entries (candidate_id, snapshot_id);

ALTER TABLE live_provider_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_leaderboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_leaderboard_snapshot_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON live_provider_evidence, live_leaderboard_snapshots, live_leaderboard_snapshot_entries FROM anon, authenticated;
GRANT ALL ON live_provider_evidence, live_leaderboard_snapshots, live_leaderboard_snapshot_entries TO service_role;

COMMIT;
