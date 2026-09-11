BEGIN;

-- Retain per-attempt overlap composition so production diagnostics do not have to
-- reconstruct a historical provider curve after the fact.
ALTER TABLE live_canonical_attention_alignments
  ADD COLUMN total_timestamp_overlap integer NOT NULL DEFAULT 0,
  ADD COLUMN available_overlap_count integer NOT NULL DEFAULT 0,
  ADD COLUMN strong_usable_overlap_count integer NOT NULL DEFAULT 0,
  ADD COLUMN weak_overlap_rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN zero_overlap_rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN missing_overlap_rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN outlier_overlap_rejected integer NOT NULL DEFAULT 0;

ALTER TABLE live_canonical_attention_alignments
  ADD CONSTRAINT live_canonical_attention_alignments_overlap_counts_nonnegative CHECK (
    total_timestamp_overlap >= 0 AND available_overlap_count >= 0 AND strong_usable_overlap_count >= 0
    AND weak_overlap_rejected >= 0 AND zero_overlap_rejected >= 0
    AND missing_overlap_rejected >= 0 AND outlier_overlap_rejected >= 0
  );

COMMIT;
