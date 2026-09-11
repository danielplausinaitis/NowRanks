BEGIN;

-- Raw provider curves and derived canonical points are deliberately distinct.
CREATE TABLE live_provider_curve_artifacts (
  artifact_id uuid PRIMARY KEY,
  ingestion_run_id uuid NOT NULL REFERENCES ingestion_runs(run_id) ON DELETE RESTRICT,
  candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  provider_id text NOT NULL, provider_query text NOT NULL, query_fingerprint text NOT NULL,
  slot_at timestamptz NOT NULL, retrieved_at timestamptz NOT NULL,
  targeting jsonb NOT NULL CHECK (jsonb_typeof(targeting) = 'object'),
  request_window text NOT NULL, normalization_scope text NOT NULL,
  algorithm_version text NOT NULL, raw_curve jsonb NOT NULL CHECK (jsonb_typeof(raw_curve) = 'array'),
  UNIQUE (ingestion_run_id, candidate_id, provider_id, request_window)
);
CREATE TABLE live_canonical_attention_points (
  point_id uuid PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  series_key text NOT NULL, segment_id text NOT NULL, observed_at timestamptz NOT NULL,
  canonical_attention double precision NOT NULL CHECK (canonical_attention > 0),
  source_artifact_id uuid NOT NULL REFERENCES live_provider_curve_artifacts(artifact_id) ON DELETE RESTRICT,
  alignment_confidence text NOT NULL CHECK (alignment_confidence IN ('high','medium')),
  algorithm_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, series_key, segment_id, observed_at)
);
CREATE TABLE live_canonical_attention_alignments (
  alignment_id uuid PRIMARY KEY, candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL REFERENCES live_provider_curve_artifacts(artifact_id) ON DELETE RESTRICT,
  series_key text NOT NULL, segment_id text NOT NULL, scale_factor double precision NULL,
  usable_overlap_count integer NOT NULL, rejected_overlap_count integer NOT NULL, dispersion double precision NULL,
  confidence text NOT NULL CHECK (confidence IN ('high','medium','rejected')),
  accepted boolean NOT NULL, reason text NULL, algorithm_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_canonical_attention_points_lookup_idx ON live_canonical_attention_points (candidate_id, series_key, segment_id, observed_at DESC);
CREATE INDEX live_provider_curve_artifacts_lookup_idx ON live_provider_curve_artifacts (candidate_id, provider_id, slot_at DESC);
ALTER TABLE live_provider_curve_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_canonical_attention_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_canonical_attention_alignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON live_provider_curve_artifacts, live_canonical_attention_points, live_canonical_attention_alignments FROM anon, authenticated;
GRANT ALL ON live_provider_curve_artifacts, live_canonical_attention_points, live_canonical_attention_alignments TO service_role;
COMMIT;
