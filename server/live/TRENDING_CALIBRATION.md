# Shadow Trending calibration decision

## Decision

Do not create one combined Trending rank yet. Keep **Established Trending** and **Emerging** as separate ordered lanes. This is a shadow-only decision: production/replay scoring, APIs, persistence, and frontend behavior remain unchanged.

Both models output a bounded 0–100 number, but a shared range is not a shared measurement scale. A score of 70 in Established Trending means that the weighted, cohort-normalized historical movement evidence landed at 70 for the available historical profile. A score of 70 in Emerging means that current demand, bounded provider increase, and recency combined to 70 after cold-start eligibility. Neither statement establishes that the candidates have equal present importance.

## Evidence in each model

| Evidence | Established Trending | Emerging Trending | Relationship |
| --- | ---: | ---: | --- |
| Search Interest | 10% | 50% | Shared: 70% cohort-normalized SerpApi current intensity + 30% cohort-normalized DataForSEO baseline demand |
| Growth | 40% | — | Established-only within-topic historical shape, cohort-normalized across eligible values |
| Momentum | 35% | — | Established-only within-topic historical shape, cohort-normalized across eligible values |
| Consistency | 10% | — | Established-only historical stability evidence |
| Breakout | 5% | — | Established-only recent peak versus earlier within-topic baseline |
| Bounded increase | — | 30% | Emerging-only SerpApi increase, log-dampened and saturated at 1000% |
| Recency | — | 20% | Emerging-only age inside the discovery lookback |

Missing historical evidence is never fabricated. Partial established scores renormalize only over allowed available components and retain their evidence confidence.

## Calibration options evaluated

### A. Common cohort percentile

Rejected for now. A percentile within each lane says where a candidate sits among different reference populations; it does not make the underlying evidence equivalent. With four candidates per lane, percentiles would also be coarse and highly sensitive to cohort composition.

### B. Shared current-trend backbone

Promising for future research, but not yet calibrated. Search Interest is genuinely common. However, a truthful common score still needs a validated mapping between historical Growth/Momentum/Consistency/Breakout and current increase/recency. Choosing that mapping and weights from one ten-candidate run would be arbitrary.

### C. Confidence-adjusted score

Rejected. Confidence measures evidence completeness, not trend strength. Multiplying Emerging by a penalty would encode “new means weaker” and prevent genuine new trends from ranking highly. Giving confidence a bonus could create the opposite distortion.

### D. Separate lanes

Selected. It preserves the meaning of both models, permits strong new topics to be visible, and avoids claiming unsupported cross-lane precision.

## Product semantics

The Trending surface should show two independently ranked sections:

1. **Established Trending** — topics with sufficient historical movement evidence.
2. **Emerging now** — active, recent, sufficiently intense topics whose history is sparse.

Each row retains classification, confidence, and score basis. No combined rank is displayed. Emerging topics remain omitted from normal Overall ranking (or may later be shown as `N/A — Emerging`), because Overall remains historically supported.

For the latest real shadow cohort, Tyler Cameron, Stan Kroenke, Star Wars, and Street Fighter Movie remain ordered in Established Trending. Dancing With the Stars 2026 cast, Cardinals vs Dodgers, Zverev, and Jim Thornton remain ordered in Emerging. The model makes no claim that, for example, Emerging 83.01 is above Established 59.37.

## Evaluation harness and promotion gate

`shadowTrendingCalibration.mjs` provides deterministic separate-lane output and a pure evaluator for proposed future unified strategies. Any candidate strategy must satisfy at least these ordering invariants:

- strong Emerging can outrank weak Established;
- strong Established can outrank weak Emerging;
- a saturated 1000% increase alone does not guarantee first place;
- large baseline demand alone does not guarantee first place;
- recency distinguishes otherwise similar Emerging evidence;
- historical evidence affects strength, not merely confidence;
- missing history remains missing.

Passing mocked invariants is necessary but insufficient. Before a unified rank is defensible, collect a broader read-only shadow evaluation set across multiple dates and categories, predefine an external “rising/important now” outcome, and validate calibration and ordering out of sample. The harness never approves activation automatically.
