BEGIN;
CREATE TABLE live_baseline_demand_cache (
  cache_key text PRIMARY KEY,
  normalized_query text NOT NULL,
  provider_id text NOT NULL,
  targeting jsonb NOT NULL CHECK (jsonb_typeof(targeting) = 'object'),
  availability text NOT NULL CHECK (availability IN ('available','missing')),
  search_volume double precision NULL CHECK (search_volume IS NULL OR search_volume >= 0),
  monthly_history jsonb NULL CHECK (monthly_history IS NULL OR jsonb_typeof(monthly_history) = 'array'),
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((availability = 'available' AND search_volume IS NOT NULL) OR (availability = 'missing' AND search_volume IS NULL))
);
CREATE INDEX live_baseline_demand_cache_lookup_idx ON live_baseline_demand_cache (provider_id, normalized_query, retrieved_at DESC);
ALTER TABLE live_baseline_demand_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON live_baseline_demand_cache FROM anon, authenticated;
GRANT ALL ON live_baseline_demand_cache TO service_role;
COMMIT;
