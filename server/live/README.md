# Live provider boundary

`providerAdapter.mjs` is server-only and makes no HTTP calls by itself. The server-only SerpApi and DataForSEO transports supply validated payloads to it; it converts them to the existing canonical `SearchTopicData` consumed by validation and a future ingestion command.

Required provider capabilities: stable topic/query identity (a provider source ID when available), a query label, category or a mapping input, timestamped numeric measurements or explicit missing reasons, retrieval/source timestamps, geographic scope, and an explicit statement whether measurements share one cross-query-comparable scale. Provider credentials must stay in a future server-only transport, never in this adapter payload or browser code.

The normalized live data is always `dataMode: 'live'`. There is no replay fallback. `ingest:live` remains intentionally absent until a separate explicit live-write safety policy is selected.

Scoring requires complete comparable numeric observations: 24H needs 1 daily value; 7D needs 7; 30D needs 30; and 1Y needs 365. The current engine rejects missing values and non-comparable sources. Growth, momentum, and breakout only become non-zero with at least 14 observations, so new candidates with 1–13 complete values can technically rank but lack meaningful growth/momentum/breakout signals; candidates with missing values cannot be truthfully scored at all.

## SerpApi discovery

`serpApiTrendingNow.mjs` calls the server-only `GET https://serpapi.com/search.json` endpoint with `engine=google_trends_trending_now`, explicit `geo`, and optional `hours` (`4`, `24`, `48`, `168`), `hl`, `only_active`, and `category_id`. It reads only `SERPAPI_API_KEY`; no `VITE_` variable is used. It produces deduplicated internal discovery candidates keyed by the normalized query and preserves legitimate volume, percentage increase, active status, start timestamp, related queries, raw unmapped categories, retrieval time, and geography. Unknown categories remain `null`/unmapped rather than being assigned arbitrarily.

Run this read-only check only after placing credentials in untracked `.env`:

```powershell
npm run live:discover-check
```

Set `SERPAPI_API_KEY` and `SERPAPI_DISCOVERY_GEO`; the other `SERPAPI_DISCOVERY_*` variables are optional. The command prints `LIVE EXTERNAL DATA — NOT PERSISTED` and does not import Supabase or ingestion code.

## DataForSEO measurement

`dataForSeoTrends.mjs` posts exactly one task to `https://api.dataforseo.com/v3/keywords_data/dataforseo_trends/explore/live`. It reads `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` only, builds a Basic authorization header only in memory, supports one to five keywords, requires exactly one explicit `location_name` or `location_code`, and supports optional `date_from`/`date_to`, documented `time_range`, and provider `type` parameters. Its normalized measurements preserve retrieval time, requested range, provider timestamps, and provider bucket boundaries when supplied.

The provider documents zero as insufficient data for this graph, so this adapter truthfully emits it as a missing `out-of-range` observation—not as zero interest. A structurally valid graph cell that is null, absent, non-numeric, negative, or non-finite is likewise recorded as missing `invalid-provider-measurement`, with compact per-run counters; it never aborts unrelated candidate histories or becomes zero. Positive numeric values are preserved. Envelope, keyword alignment, timestamp, row, and values-array shape faults remain fail-fast. Missing or non-comparable data remains unscorable under the existing engine.

```powershell
npm run live:measurement-check -- "keyword one" "keyword two"
```

Set `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, exactly one of `DATAFORSEO_LOCATION_CODE` / `DATAFORSEO_LOCATION_NAME`, and `LIVE_MEASUREMENT_CATEGORY` to an existing NowRanks category. Optional `DATAFORSEO_DATE_FROM` / `DATAFORSEO_DATE_TO` constrain the range. This command is read-only and never writes to Supabase.

## DataForSEO Search Volume baseline demand

`dataForSeoSearchVolume.mjs` uses the current Google Ads Search Volume Live endpoint:

```text
POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live
```

This endpoint was selected because one task accepts up to 1,000 keywords, returns approximate absolute monthly search-volume estimates under explicit targeting, exposes monthly history (12 months by default and up to four years when requested), and may include paid-search competition and CPC diagnostics. The approximately 100 NowRanks candidates fit in one request, avoiding a batching comparability problem. Google Ads may combine volumes for close keyword variants; consumers must retain that provider caveat rather than treating the estimates as exact counts.

The request requires exactly one explicit `DATAFORSEO_LOCATION_CODE`, `DATAFORSEO_LOCATION_NAME`, or `DATAFORSEO_LOCATION_COORDINATE`. Optional controls are `DATAFORSEO_LANGUAGE_CODE` / `DATAFORSEO_LANGUAGE_NAME`, `DATAFORSEO_VOLUME_DATE_FROM`, `DATAFORSEO_VOLUME_DATE_TO`, and `DATAFORSEO_SEARCH_PARTNERS`. Authentication reuses only `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` through the shared server-only auth module.

The normalized internal baseline-demand record keeps `searchVolume`, availability, monthly history, competition, competition index, CPC, retrieval time, geography, provider identity, and live provenance. Numeric zero remains available zero; provider `null` remains explicitly missing. Competition and CPC are retained for auditability but are not used by scoring.

```powershell
npm run live:volume-check -- "ChatGPT" "iPhone" "Tesla"
```

The command prints `LIVE EXTERNAL DATA — NOT PERSISTED` and a concise table. It imports neither Supabase nor ingestion code. Values are comparable across the one cohort request. If future batching is needed, absolute volumes remain comparable only when location, language, date range, and search-partner targeting are identical.

## Future live signal composition

`liveSignalComposition.mjs` deliberately keeps three signal families separate:

- `currentTrendIntensity`: SerpApi Trending Now discovery/intensity.
- `baselineDemand`: DataForSEO Google Ads Search Volume.
- `historicalTrendShape`: DataForSEO Trends within-topic history.

A later scoring task may derive Search Interest from current intensity plus baseline demand, while growth, momentum, consistency, and breakout use historical shape. No scoring formula or weight is changed in this milestone.

## Shadow live scoring

`shadowScoring.mjs` implements isolated diagnostic hypotheses. It has no persistence, HTTP API, frontend, or replay imports and cannot replace the production leaderboard. The live command uses the separate elapsed-time evaluator in `elapsedShadowHistory.mjs`; the original positional evaluator remains unchanged for prior tests and is not used by the live command.

Transformations and formulas:

- Current Trend Intensity = cohort min-max normalization of `log1p(SerpApi search_volume)`. `increase_percentage`, active status, and start time remain raw diagnostics; they are not given unvalidated weights.
- Baseline Demand = cohort min-max normalization of `log1p(DataForSEO Google Ads search_volume)`.
- Search Interest = `0.70 × Current Trend Intensity + 0.30 × Baseline Demand`.
- Each DataForSEO Trends series is peak-normalized within its own topic (`100 × value / candidate peak`). Only available points are transformed; missing remains missing. Raw Trends levels are never compared across candidates.
- Growth, momentum, consistency, and breakout use elapsed-time segments selected for `24H`, `7D`, `30D`, or `1Y`. Their available raw outputs are normalized across the shadow cohort, matching the existing component-normalization convention.
- Shadow Overall uses the existing weights: Search Interest 45%, Growth 25%, Momentum 15%, Consistency 10%, Breakout 5%.
- Shadow Trending uses the existing weights: Search Interest 10%, Growth 40%, Momentum 35%, Consistency 10%, Breakout 5%.

Required recent/baseline segments need at least 80% valid provider buckets. A gap greater than two expected cadence intervals invalidates an affected segment. Consistency uses each window's derived minimum (14 hourly points for 24H, 7 daily points for 7D, 14 daily points for 30D, or 26 weekly points for 1Y). Missing current intensity or baseline demand makes Search Interest unavailable.

The elapsed-time path can also emit a partial score without converting missing components to zero. Search Interest remains mandatory. At least 80% total history coverage, two historical components, and one recent-sensitive component (growth, momentum, or breakout) are required. Available base weight must be at least 70% for Overall and 60% for Trending. Each profile is independently renormalized over its available components. Confidence is `full` with all historical components, `partial-high` with three components and at least 90% history coverage, `partial-low` for another eligible partial result, and `insufficient` otherwise.

Two- and three-bucket segments require every bucket. A four-bucket segment requires three valid buckets because 3/4 (75%) is the closest attainable tolerance to the intended 80%; requiring `ceil(4 × 0.8) = 4` accidentally imposed 100%. Segments of five or more continue to require `ceil(80%)`.

Historically sparse candidates remain ineligible for established Overall and Trending scores; current volume or increase percentage never fabricates historical growth.

The shadow command now also evaluates the separate model documented in `COLD_START_MODEL.md`. Sparse topics with mandatory Search Interest, active/recent SerpApi timing, at least a doubled increase, and cohort-normalized current intensity of at least 50 can receive an `Emerging Trending` score and separate emerging rank. Their Overall and established Trending scores remain unavailable. Established and emerging rankings are not merged without calibration.

`TRENDING_CALIBRATION.md` records the current calibration decision. A combined rank is not yet defensible: the two 0–100 scores measure different evidence, and the available live sample cannot validate a conversion. `shadowTrendingCalibration.mjs` therefore exposes only product-safe separate lanes plus a pure test harness for evaluating future proposed strategies; it is not imported by production or replay scoring.

## Manual live persistence

`LIVE_PERSISTENCE.md` documents the additive schema, deterministic live cycle identities, separate Established/Emerging snapshot contract, dry-run-first command, and independent `ALLOW_LIVE_DATABASE_WRITE` gate. The path remains manual and server-only; it does not switch the API or frontend away from replay data.

Run a deliberately bounded discovery-based external check manually:

```powershell
npm run live:shadow-check
```

`LIVE_SHADOW_CANDIDATE_LIMIT` defaults to 10 and accepts 2–20. `LIVE_SHADOW_TRENDS_MODE` defaults to `single` (`N` Trends requests); `batched` retains the earlier `ceil(N / 5)` experiment. `LIVE_SHADOW_HISTORY_WINDOW` defaults to `1Y` and maps `24H`, `7D`, `30D`, and `1Y` to the provider's `past_day`, `past_7_days`, `past_30_days`, and `past_12_months` presets. The command prints cadence, coverage, gaps, component-specific reasons, provider costs, both shadow scores, and `LIVE EXTERNAL DATA — SHADOW SCORE — NOT PERSISTED`.

## Cross-batch comparability: unresolved and blocked

DataForSEO documents that a multi-keyword request is normalized to the highest value in that submitted keyword set, but does not document a cross-request calibration contract. A common anchor appearing in separate five-keyword requests therefore cannot yet be proven to yield a global scale. `comparability.mjs` permits only one request's keyword set for scoring and rejects multi-batch global scoring. No anchor transformation is implemented. To lift this guard, obtain provider documentation or an explicit support statement defining a stable, invertible cross-request scale (including zero/missing behavior and rounding).
