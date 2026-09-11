# NowRanks Historical Data Vault

## Purpose

The vault is a durable, server-only record of slot-aligned source measurements. It is not a second leaderboard and it does not replace unified v2 snapshots. Its rule is simple: a raw value may be retained for audit or future research, but it may produce rolling Growth only after its measurement contract explicitly says that it is comparable across scheduler cycles.

The intended model is: **SerpApi discovers, DataForSEO enriches, NowRanks remembers, and NowRanks calculates.**

## Existing data flow and semantics

`SerpApi Trending Now -> collectLiveSharedInputs -> currentTrendIntensity -> unified scorer -> live persistence -> v2 snapshot -> read service/API`.

DataForSEO Search Volume enters the same shared stage as `baselineDemand`. DataForSEO Trends is retrieved separately for each selected history window, converted to `historicalTrendShape`, evaluated by `elapsedShadowHistory`, and passed to the unified scorer. The v2 snapshot stores rank, Now Score, evidence status, and component presentation; it is already the correct history for rank/Now Score/heat graphs and is not duplicated by this vault.

| Measurement | Meaning / scale | Cross-time | Cross-candidate | Vault Growth / chart decision |
|---|---|---:|---:|---|
| SerpApi `search_volume` | provider-reported Trending Now field; request horizon semantics not verified | unknown | unknown | retain as unvalidated artifact; never Growth eligible |
| SerpApi `increase_percentage` | provider derived acceleration, known to quantize/saturate | no | no | discovery fallback only; `1000` is displayed as a lower bound |
| SerpApi timestamps / active | discovery lifecycle metadata | timestamp-only | n/a | provenance / recency only |
| DataForSEO Search Volume | approximate monthly Google Ads count, explicit targeting | yes if targeting is identical | yes if targeting is identical | baseline/monthly chart candidate, not short-term attention Growth |
| DataForSEO Trends graph | relative popularity within request range and keyword set | no across independent requests | only within one request scope | provider historical artifact; do not stitch into vault Growth |
| CurrentTrendIntensity / SearchInterest | cohort-normalized scoring inputs | no | cohort-local only | derived score input only |
| Growth / Momentum / Consistency / Breakout | window/algorithm-derived signals | no without raw inputs + version | no | snapshot diagnostics/features only |
| unified raw / Now Score | derived ranking score | version-dependent | yes only inside a snapshot | snapshot history, never raw attention |
| public rank | relative position | no | relative | rank-history chart only |

DataForSEO documents its graph values as relative keyword-popularity rates over the requested range; in multi-keyword requests they are scaled to the highest specified keyword. A new request can have a different maximum. Overlap does not provide an absolute anchor, and rounding/zero handling make ratio stitching unvalidated. No overlap rescaling is used in production. A future experiment must retain each request artifact, use non-zero overlapping points, a robust median ratio, uncertainty, and an explicit rejection threshold; it must remain shadow-only until independently validated.

## Why `observations` is not the vault

`observations` correctly stores provider historical curve buckets, but it has no metric key/version, scheduler slot, query fingerprint, language/targeting contract, normalization scope, or comparability key. Reusing it would let independently normalized Trends curves look compatible. Migration 007 adds `live_historical_vault_measurements` instead. It is additive and leaves replay, legacy v1, and unified v2 records unchanged.

Each row records raw value/availability, candidate and provider query identity, UTC `slot_at`, observed/retrieved times, provider/metric/version/unit, geography/language/targeting/query mode/horizon/normalization, quality, evidence reference, and a deterministic SHA-256 comparability key. The unique key `(candidate_id, metric_key, metric_version, comparability_key, slot_at)` makes a retry idempotent. The first successful measurement for a logical slot is retained; retries cannot overwrite it.

The initial writer records the evaluated discovery cohort (up to the existing paid/evaluated bound, not merely Top 20) as `serpapi-trending-search-volume`, with `comparability_status=unknown` and `quality.growthEligible=false`. This preserves evidence without pretending the field is canonical. Discovery absence is never written as zero.

## Growth engine and maturity

## Canonical attention alignment (shadow-first)

Migration 008 introduces a separate raw-curve artifact, immutable canonical-point, and alignment-event contract. The canonical source is the highest-resolution `past_day` DataForSEO Trends response: it supplies the four-hour-scale points needed for one accumulating series, while 7D/30D/1Y responses remain provider-history enrichment and are never blindly blended into it.

The first valid curve bootstraps its arbitrary ruler unchanged. Every later curve is aligned **directly** to overlapping immutable canonical timestamps, never by multiplying a prior local factor. For each exact overlapping timestamp, `ratio = canonical / provider`; provider values below 10 are excluded to avoid integer-rounding instability. The median ratio is the scale factor, and relative MAD (`median(abs(ratio - median))/median`) measures dispersion. At least three strong overlaps are required; four with relative MAD <= 8% are high confidence, while three-or-more with relative MAD <= 15% are medium. Other attempts are rejected, retained as diagnostics, and append no point.

Only provider timestamps not already present are appended. Existing canonical points are never overwritten. Query fingerprint, geo/language/targeting, provider mode, metric and algorithm version form the series identity; a mismatch creates a new segment and Growth never bridges segments. Topic absence is not zero.

### Temporary unalignable gaps

A regime is resumable for any elapsed wall-clock duration only when the incoming curve still has direct canonical timestamps and passes the unchanged alignment rule (at least three provider values of 10 or higher and the existing median/MAD confidence threshold). Direct accepted timestamp overlap therefore overrides elapsed time. A weak, zero, or missing overlapping curve remains a rejected, point-free event and keeps the old segment intact for the next scheduled retry. If a usable curve has **zero direct timestamp overlaps with every retained segment**, continuity cannot be calibrated: it bootstraps a new segment with its own ruler. Missing- or zero-only curves never establish a new segment. This overlap boundary is the explicit maximum resumable gap; there is no wall-clock-only expiration that can overrule trustworthy direct overlap.

This module is intentionally shadow-first. When `LIVE_VAULT_ENABLED=true`, `LIVE_VAULT_GROWTH_MODE=shadow`, and the selected ingestion window is `24H`, `buildLivePersistencePlan` consumes the raw parsed `history.observations` from the DataForSEO `past_day` response. It reads existing points in one cohort query, then writes an idempotent raw artifact, alignment event, and new immutable points in that order. Candidate alignment faults are isolated; a rejected alignment remains an event and adds no points. `7D`, `30D`, and `1Y` provider curves stay on their existing provider-history route.

The raw artifact identity is the ingestion run, candidate, provider and `past_day` window; alignment and point IDs are deterministic. Retrying the same cycle therefore cannot duplicate artifacts, events, or points. The logical `slot_at` is the deterministic UTC four-hour scheduler slot, never the later retrieval time. A query, geo, language, request-mode, or normalization identity mismatch produces a separate series/segment rather than bridging old history.

An all-missing `past_day` graph is an explicit canonical-unavailable result: its raw artifact and rejected `no-valid-provider-points` alignment event are retained, but it creates neither a point nor a bootstrap segment. The next four-hour collection retries independently; the first later curve with usable points bootstraps normally. Provider `out-of-range` is never converted to zero.

### Active paid tracking allocation

Canonical points are retained permanently, but paid collection is bounded to 50 topics. Allocation is derived and does not alter public ranking: prior public Top20 topics are protected first; up to 10 new discoveries are reserved next; up to 15 canonical histories with a successful alignment from the prior seven days are then selected; up to five due missing-history retries follow; remaining fresh discoveries may fill capacity; generic 48-hour grace retention is last and never displaces canonical continuity. Within canonical continuity, a 24-or-more-point history, accepted confidence (`high`, then `medium`), public rank, least-recent paid measurement, point count, and recent canonical success provide a deterministic order. Missing retries use the existing 4/8/24-hour backoff (Top20 remains the explicit public-protection exception). A canonical history that has not succeeded for seven days loses paid priority, while its immutable points remain stored.

The scheduled cycle uses three deliberately separate sets: the SerpApi discovery pool, the deduplicated paid Trends tracking cohort (at most 50), and public snapshot entries. Every selected paid topic receives a Trends history request and can produce a canonical artifact, including continuity-only and missing-retry topics absent from discovery. Public scoring receives only discovery-backed topics that were measured in that cohort; tracking-only history cannot enter a public snapshot merely by being retained. Cycle diagnostics report both pool sizes, Trends requests, selected topics absent from discovery, and selected-but-not-measured topics (normally zero).

The pure engine accepts only rows whose status is `comparable`, `quality.growthEligible=true`, same candidate, and one comparability key. Other data returns a diagnostic such as `no-growth-eligible-measurements` or `incompatible-targeting`.

- **24H:** latest three 4-hour slots (12 hours) versus preceding three slots. Each side needs 2/3 valid slots. This is responsive while allowing one failed slot.
- **7D:** latest three completed UTC days versus preceding three days. A day needs at least four of six expected slots, each segment needs 2/3 eligible days, and each day contributes one daily mean (so extra successful slots never overweight a day).
- **30D:** fourteen completed UTC days versus previous fourteen; at least ten valid daily means per segment.
- **1Y:** twenty-six completed UTC weeks versus previous twenty-six; at least twenty-one valid weekly means per segment.

For every mature window: `growth = ((recentMean - previousMean) / previousMean) * 100`. Values are never capped. A zero baseline yields `zero-baseline`; a baseline below the metric-specific configured minimum (currently 5 for the integer-like test metric) yields `unsafe-denominator`. A real canonical metric must set and document its own resolution-aware denominator policy before promotion.

Source order is `nowranks-history -> provider-history -> discovery-increase -> unavailable`. `LIVE_VAULT_GROWTH_MODE=shadow` persists/diagnoses vault calculations without changing public Growth. `preferred` uses a canonical 24H value only when it passes the promotion gate below; otherwise it follows the unchanged provider-history/discovery fallback. Current retained SerpApi rows cannot satisfy that condition, so both modes preserve provider-history/discovery public behavior today.

### Public 24H Growth promotion gate

The gate is separate from alignment and never changes alignment thresholds or recomputes Growth. A `nowranks-history` canonical 24H result can be promoted only when it is finite and available, belongs to the current segment without cross-segment blending, is within the explicit canonical freshness allowance, has a finite nonzero (positive) preceding mean, and has at least 9 of 12 actual hourly points in both the recent and preceding windows. Its latest canonical point must have an accepted alignment confidence: `high` is eligible with the 9/12 minimum, while `medium` additionally requires complete 12/12 coverage in both windows. Missing, stale, weak, rejected, zero-baseline, untrusted, or segment-ambiguous results always fall back and never become zero.

A fresh bootstrap or newly started segment may become promotable only through that same full internal comparison: 12/12 actual points on each side plus the required accepted confidence. It is not compared or blended with an older segment. Negative and uncapped positive values are retained unchanged. In `shadow`, a passing result records `wouldPromoteInShadow` but leaves public Growth and source unchanged. In `preferred`, the identical passing condition records `promotedInPreferred` and permits the normal source resolver to select canonical history.

## Read, diagnostics, and future products

`historicalVaultReadService.mjs` does batch range reads for a candidate cohort and returns graph-ready canonical points (timestamp, value, segment, confidence) plus coverage/reason diagnostics. The canonical `past_day` graph remains hourly even though collection is every four hours. Its 24H Growth is `((mean(latest 12 valid hourly points) - mean(previous 12 valid hourly points)) / previousMean) * 100`, with at least 9 of 12 actual hourly slots in each segment; it is uncapped and never treats missing data as zero. `npm run vault:check -- --candidate-id=<id>` is read-only and reports all four horizons. `npm run vault:alignment-check -- --candidate-id=<id>` is also read-only and reports recent raw-artifact-backed bootstrap/alignment/rejection events using the ingestion run's `idempotency_key` as cycle identity. This layer can later serve topic charts, watchlists, alert thresholds, growth/velocity timelines, and AI summary context. Unified v2 snapshots remain the source for rank, Now Score, and heat history.

For canonical 24H Growth, wall-clock `asOf` is only a freshness gate. The actual twelve-hour windows end at the latest canonical hourly point, preventing an `asOf` minute offset such as `19:47` from requesting impossible `:47` measurements. Freshness is inclusive and derived as `LIVE_REFRESH_INTERVAL_MINUTES + 60 minutes` of provider-lag tolerance (five hours at the default four-hour schedule). Older series return `stale-canonical-history`; freshness is not unlimited.

## Cost and caching

The pure cost planner does not claim savings from Growth maturity alone. Unified scoring still consumes provider momentum, consistency, and breakout, so a Trends refresh becomes avoidable only after every historical feature used by that horizon has a validated vault replacement. A canonical vault metric can then avoid the matching refresh; it never removes SerpApi discovery or the current attention measurement. A future history-artifact cache may safely reduce repeat Trends calls by horizon (for example 30D/1Y less often), but cache freshness must be explicit and that policy is not enabled by this migration.

## Rollout

`LIVE_VAULT_ENABLED=false` and `LIVE_VAULT_GROWTH_MODE=off` are defaults. Apply migration 007 manually, run write-enabled cycles only after existing approval gates, then enable `LIVE_VAULT_ENABLED=true` with `shadow`. Leave public output unchanged through enough deterministic slots to inspect `vault:check`. Do not set `preferred` until a provider measurement has documented stable cross-cycle semantics, its metric contract has been updated to `comparable/growthEligible`, and shadow comparisons have been reviewed.
