BEGIN;

-- Raw, slot-aligned source measurements. This is intentionally separate from
-- observations: observations holds provider historical-curve buckets whose
-- normalization scope may vary by request; vault rows require an explicit
-- comparability contract before any rolling calculation may consume them.
CREATE TABLE live_historical_vault_measurements (
  measurement_id uuid PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
  ingestion_run_id uuid NOT NULL REFERENCES ingestion_runs(run_id) ON DELETE RESTRICT,
  metric_key text NOT NULL CHECK (btrim(metric_key) <> ''),
  metric_version integer NOT NULL CHECK (metric_version >= 1),
  provider_id text NOT NULL CHECK (btrim(provider_id) <> ''),
  provider_query text NOT NULL CHECK (btrim(provider_query) <> ''),
  normalized_provider_query text NOT NULL CHECK (btrim(normalized_provider_query) <> ''),
  query_fingerprint text NOT NULL CHECK (query_fingerprint ~ '^[0-9a-f]{64}$'),
  value double precision NULL CHECK (value IS NULL OR value >= 0),
  unit text NOT NULL CHECK (btrim(unit) <> ''),
  availability text NOT NULL CHECK (availability IN ('available', 'missing')),
  missing_reason text NULL,
  slot_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  geographic_scope jsonb NOT NULL CHECK (jsonb_typeof(geographic_scope) = 'object'),
  language text NULL,
  targeting jsonb NOT NULL CHECK (jsonb_typeof(targeting) = 'object'),
  query_mode text NOT NULL CHECK (btrim(query_mode) <> ''),
  measurement_horizon text NOT NULL CHECK (btrim(measurement_horizon) <> ''),
  normalization_scope text NOT NULL CHECK (btrim(normalization_scope) <> ''),
  comparability_key text NOT NULL CHECK (comparability_key ~ '^[0-9a-f]{64}$'),
  comparability_status text NOT NULL CHECK (comparability_status IN ('comparable', 'not-comparable', 'unknown')),
  quality jsonb NOT NULL CHECK (jsonb_typeof(quality) = 'object'),
  source_evidence_id uuid NULL REFERENCES live_provider_evidence(evidence_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (availability = 'available' AND value IS NOT NULL AND missing_reason IS NULL)
    OR (availability = 'missing' AND value IS NULL AND missing_reason IN ('not-reported', 'source-unavailable', 'out-of-range', 'redacted', 'invalid-provider-measurement', 'not-selected'))
  ),
  -- One logical measurement per candidate, metric semantics, and UTC scheduler slot.
  UNIQUE (candidate_id, metric_key, metric_version, comparability_key, slot_at)
);

CREATE INDEX live_historical_vault_candidate_metric_time_idx
  ON live_historical_vault_measurements (candidate_id, metric_key, comparability_key, slot_at DESC);
CREATE INDEX live_historical_vault_slot_idx
  ON live_historical_vault_measurements (slot_at DESC);
CREATE INDEX live_historical_vault_run_idx
  ON live_historical_vault_measurements (ingestion_run_id);

ALTER TABLE live_historical_vault_measurements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON live_historical_vault_measurements FROM anon, authenticated;
GRANT ALL ON live_historical_vault_measurements TO service_role;

COMMIT;
