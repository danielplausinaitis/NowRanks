BEGIN;

-- These describe a continuity decision, not a synthetic measurement. They make an
-- alignment rejection auditable even after the provider's rolling curve expires.
ALTER TABLE live_canonical_attention_alignments
  ADD COLUMN gap_since_last_canonical_point_ms bigint NULL,
  ADD COLUMN can_resume_existing_segment boolean NOT NULL DEFAULT false,
  ADD COLUMN resume_reason text NULL,
  ADD COLUMN new_segment_required boolean NOT NULL DEFAULT false;

ALTER TABLE live_canonical_attention_alignments
  ADD CONSTRAINT live_canonical_attention_alignments_gap_nonnegative CHECK (
    gap_since_last_canonical_point_ms IS NULL OR gap_since_last_canonical_point_ms >= 0
  );

COMMIT;
