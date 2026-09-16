BEGIN;

CREATE TABLE live_daily_discovery_cache (
  cache_key text PRIMARY KEY,
  candidate_universe jsonb NOT NULL CHECK (jsonb_typeof(candidate_universe) = 'array' AND jsonb_array_length(candidate_universe) > 0),
  discovery_request jsonb NOT NULL CHECK (jsonb_typeof(discovery_request) = 'object'),
  discovery_requests jsonb NOT NULL CHECK (jsonb_typeof(discovery_requests) = 'array'),
  discovery_diagnostics jsonb,
  discovered_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX live_daily_discovery_cache_discovered_at_idx ON live_daily_discovery_cache (discovered_at DESC);
ALTER TABLE live_daily_discovery_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON live_daily_discovery_cache FROM anon, authenticated;
GRANT ALL ON live_daily_discovery_cache TO service_role;

COMMIT;
