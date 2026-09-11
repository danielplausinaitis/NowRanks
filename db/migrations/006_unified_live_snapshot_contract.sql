BEGIN;

-- This migration starts from the confirmed deployed schema, where legacy snapshots
-- include established, emerging, and short-window-overall rows.
ALTER TABLE live_leaderboard_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_format_version smallint;

UPDATE live_leaderboard_snapshots
  SET snapshot_format_version = 1
  WHERE snapshot_format_version IS NULL;

ALTER TABLE live_leaderboard_snapshots
  ALTER COLUMN snapshot_format_version SET DEFAULT 1,
  ALTER COLUMN snapshot_format_version SET NOT NULL;

ALTER TABLE live_leaderboard_snapshots
  DROP CONSTRAINT IF EXISTS live_leaderboard_snapshots_snapshot_format_version_check,
  ADD CONSTRAINT live_leaderboard_snapshots_snapshot_format_version_check
    CHECK (snapshot_format_version IN (1, 2));

ALTER TABLE live_leaderboard_snapshot_entries
  ADD COLUMN IF NOT EXISTS public_rank integer NULL CHECK (public_rank BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS public_score double precision NULL CHECK (public_score >= 0 AND public_score <= 100),
  ADD COLUMN IF NOT EXISTS evidence_status text NULL CHECK (evidence_status IN ('established', 'emerging'));

-- lane_rank is a legacy-lane field. v2 uses public_rank instead.
ALTER TABLE live_leaderboard_snapshot_entries
  ALTER COLUMN lane_rank DROP NOT NULL;

-- Constraint names in the deployed short-window migration are not represented in the
-- local history. Remove only checks governing lane/basis semantics, then recreate
-- those exact semantics plus the new unified branch.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.live_leaderboard_snapshot_entries'::regclass
      AND con.contype = 'c'
      AND (pg_get_constraintdef(con.oid) LIKE '%score_lane%' OR pg_get_constraintdef(con.oid) LIKE '%score_basis%')
  LOOP
    EXECUTE format('ALTER TABLE public.live_leaderboard_snapshot_entries DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE live_leaderboard_snapshot_entries
  ADD CONSTRAINT live_leaderboard_snapshot_entries_score_lane_check
    CHECK (score_lane IN ('established', 'emerging', 'short-window-overall', 'unified')),
  ADD CONSTRAINT live_leaderboard_snapshot_entries_score_basis_check
    CHECK (score_basis IN ('historical-trending', 'current-emerging-evidence', 'short-window-overall', 'unified-public')),
  ADD CONSTRAINT live_leaderboard_snapshot_entries_contract_check CHECK (
    (score_lane = 'established'
      AND lane_rank IS NOT NULL
      AND public_rank IS NULL AND public_score IS NULL AND evidence_status IS NULL
      AND overall_score IS NOT NULL
      AND established_trending_score IS NOT NULL
      AND emerging_trending_score IS NULL
      AND score_basis = 'historical-trending')
    OR
    (score_lane = 'emerging'
      AND lane_rank IS NOT NULL
      AND public_rank IS NULL AND public_score IS NULL AND evidence_status IS NULL
      AND overall_score IS NULL
      AND established_trending_score IS NULL
      AND emerging_trending_score IS NOT NULL
      AND score_basis = 'current-emerging-evidence')
    OR
    (score_lane = 'short-window-overall'
      AND lane_rank IS NOT NULL
      AND public_rank IS NULL AND public_score IS NULL AND evidence_status IS NULL
      AND overall_score IS NOT NULL
      AND established_trending_score IS NULL
      AND emerging_trending_score IS NULL
      AND score_basis = 'short-window-overall')
    OR
    (score_lane = 'unified'
      AND lane_rank IS NULL
      AND public_rank IS NOT NULL AND public_score IS NOT NULL AND evidence_status IS NOT NULL
      AND overall_score IS NULL
      AND established_trending_score IS NULL
      AND emerging_trending_score IS NULL
      AND score_basis = 'unified-public')
  );

CREATE UNIQUE INDEX IF NOT EXISTS live_leaderboard_unified_public_rank_idx
  ON live_leaderboard_snapshot_entries (snapshot_id, public_rank)
  WHERE score_lane = 'unified';

CREATE INDEX IF NOT EXISTS live_leaderboard_snapshots_version_lookup_idx
  ON live_leaderboard_snapshots (selected_window, snapshot_format_version, scored_at DESC);

COMMIT;
