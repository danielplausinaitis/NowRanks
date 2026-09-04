# Shadow-only cold-start / emerging Trending model

This model exists only in the read-only live shadow command. It does not produce an Overall score and does not alter established historical Trending, replay scoring, the API, or the frontend.

## Provider evidence

SerpApi Trending Now supplies current search volume, percentage increase, active status, start time, optional end time for inactive trends, related queries, and retrieval time. Current volume is cohort-normalized with the other discovered candidates. Related-query count is not used because the provider does not define it as a popularity measure. Current-volume-to-DataForSEO-baseline ratio is not used because Trending Now volume and monthly baseline demand have incompatible time horizons; baseline demand contributes only through the existing Search Interest calculation.

## Classification

A history-sparse topic (`<80%` valid historical coverage) is `possible-new-trend` only when all conditions hold:

- established/partial historical scoring is unavailable;
- Search Interest is available;
- SerpApi reports `active: true`;
- current search volume is positive;
- cohort-normalized current intensity is at least 50;
- percentage increase is at least 100% (at least doubled);
- start and retrieval timestamps are valid, and age is within the configured SerpApi discovery lookback (24 hours by default).

Otherwise it is `insufficient-provider-data`. Sparse history alone never creates emerging status.

## Score

`Emerging Trending = 50% Search Interest + 30% bounded increase signal + 20% recency`

- Search Interest remains `70% normalized current intensity + 30% normalized baseline demand`.
- Increase signal is `100 × log1p(min(increasePercentage, 1000)) / log1p(1000)`. Values at or above 1000% are equal because real responses repeatedly saturate/quantize there; the model does not claim precision above the cap.
- Recency is `100 × (1 - ageHours / discoveryLookbackHours)` for an active trend inside that lookback.

No historical Growth, Momentum, Consistency, or Breakout value is fabricated. The Emerging score has `emerging` confidence, while Overall and established Trending remain unavailable.

## Ranking treatment

Established Trending and Emerging Trending are separate lanes with separate ranks. Both are bounded 0–100, but they measure different evidence and are not assumed to be calibrated onto one interchangeable ordering. The calibration decision, rejected shortcuts, product treatment, and deterministic evaluation harness are documented in `TRENDING_CALIBRATION.md`.
