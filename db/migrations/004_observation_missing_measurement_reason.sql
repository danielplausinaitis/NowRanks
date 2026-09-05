BEGIN;

-- 001 created this unnamed-by-source PostgreSQL-generated constraint as observations_check.
-- Keep the availability/value invariant closed while extending the allowed missing vocabulary.
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_check;

ALTER TABLE observations
  ADD CONSTRAINT observations_check CHECK (
    (availability = 'available'
      AND interest_value IS NOT NULL
      AND interest_value >= 0
      AND missing_reason IS NULL)
    OR
    (availability = 'missing'
      AND interest_value IS NULL
      AND missing_reason IN (
        'not-reported',
        'source-unavailable',
        'out-of-range',
        'redacted',
        'invalid-provider-measurement'
      ))
  );

COMMIT;
