BEGIN;
CREATE TABLE live_google_trends_history_cache (
  cache_key text PRIMARY KEY,
  normalized_query text NOT NULL,
  provider_id text NOT NULL,
  measurement_mode text NOT NULL,
  measurement_target jsonb NULL,
  time_range text NOT NULL,
  resampling_id text NOT NULL,
  history jsonb NOT NULL CHECK (jsonb_typeof(history) = 'object'),
  batch_id text NULL,
  batch_fingerprint text NULL,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_google_trends_history_cache_lookup_idx ON live_google_trends_history_cache (provider_id, normalized_query, retrieved_at DESC);
ALTER TABLE live_google_trends_history_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON live_google_trends_history_cache FROM anon, authenticated;
GRANT ALL ON live_google_trends_history_cache TO service_role;
COMMIT;
