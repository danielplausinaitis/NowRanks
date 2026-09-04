# Resolution-aware live history model

The original shadow scorer treats observations as an ordered, equally spaced array. Its 14-point formulas were written for daily replay observations, but it neither reads timestamps nor validates cadence. It remains available unchanged for regression coverage. The live shadow command now uses the separate evaluator in `elapsedShadowHistory.mjs`.

The DataForSEO Trends Explore endpoint supports `date_from`/`date_to` and preset `time_range` values (`past_4_hours`, `past_day`, `past_7_days`, `past_30_days`, `past_90_days`, `past_12_months`, and `past_5_years`). Explicit dates and `time_range` are mutually exclusive in the transport. The shadow command uses a preset selected by `LIVE_SHADOW_HISTORY_WINDOW`. The endpoint does not expose an explicit aggregation-resolution parameter, so response bucket dates/timestamps—not request range alone—remain authoritative.

## Implemented shadow contract

Each history must retain bucket start/end, timestamp, availability, and resolution. Eligibility should be based on elapsed-time coverage within every comparison segment, not on an unqualified array length. Missing remains distinct from zero, and no interpolation should cross a gap larger than the expected cadence.

| NowRanks window | Provider range | Canonical cadence | Derived minimum | Growth | Momentum | Consistency | Breakout |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 24H | `past_day` | hourly | 14 hourly buckets | latest 7h vs prior 7h | latest/prior 3h (65%) plus latest/prior 7h (35%) | available hourly buckets across 24h | peak in latest 7h vs earlier baseline |
| 7D | `past_7_days` | daily | 7 daily buckets | latest 3d vs prior 3d | latest/prior 2d (65%) plus latest/prior 3d (35%) | daily buckets across 7d | peak in latest 2d vs earlier 5d |
| 30D | `past_30_days` | daily | 14 daily buckets | latest 7d vs prior 7d | existing latest/prior 3d and 7d comparisons | available daily buckets across 30d | peak in latest 7d vs earlier baseline |
| 1Y | `past_12_months` | weekly | 26 weekly buckets | latest 13w vs prior 13w | latest/prior 4w (65%) plus latest/prior 13w (35%) | available weekly buckets across 1y | peak in latest 13w vs earlier baseline |

These minima follow directly from the longest paired lookback, rather than silently treating 14 weeks as 14 days. Each recent/baseline segment requires 80% valid buckets. A gap greater than two expected cadence intervals makes the affected component unavailable. Input is sorted for evaluation, duplicate timestamps are rejected, and the original unsorted state remains diagnostic. Consistency can remain available while another component lacks segment coverage.

Discrete short segments use explicit minimum counts: two- and three-bucket segments require all buckets; a four-bucket segment requires three. This avoids the accidental 100% requirement produced by `ceil(4 × 0.8)` while retaining the closest representable coverage to 80%. Five or more buckets use `ceil(80%)`.

## Partial scoring and confidence

Search Interest is mandatory. A partial score additionally requires at least 80% total historical coverage, at least two available historical components, at least one available recent-sensitive component, at least 70% available Overall weight, and at least 60% available Trending weight. Missing components are omitted, never replaced by zero:

`partial score = Σ(available component × base weight) / Σ(available base weight)`

Overall and Trending apply that formula independently. `full` confidence requires all historical components. `partial-high` requires three of four historical components plus at least 90% total history coverage. Other eligible partial scores are `partial-low`; failures are `insufficient`. Confidence uses evidence availability and cadence quality, never score magnitude.

Sparse topics are evaluated separately by the shadow-only model in `COLD_START_MODEL.md`. Qualifying active/recent topics receive only an Emerging Trending score and separate rank; no historical component or Overall score is invented.

## Source strategy

A hybrid is preferable. DataForSEO can bootstrap shape history for a newly discovered topic. Persisted NowRanks snapshots should become authoritative only when the native series covers the requested elapsed-time window, matches the canonical cadence, has no duplicate timestamps or excessive gaps, and independently satisfies every required component segment. Until then, use the provider bootstrap as one intact source. For overlap, retain both provenances and do not splice independently normalized raw levels into one series without an explicit calibration rule. Daily NowRanks snapshots can eventually cover 7D, 30D, and 1Y (aggregated to weekly for 1Y); true 24H shape requires sub-daily collection.
