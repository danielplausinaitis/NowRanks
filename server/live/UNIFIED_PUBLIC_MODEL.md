# Unified public Top 20 model

Every candidate uses the same cohort-normalized signal family. Legacy Established Trending and Emerging Trending scores are never merged. The selected window changes the relative importance of the shared signals so the board answers a different horizon question.

| Signal | 24H | 7D | 30D | 1Y |
| --- | ---: | ---: | ---: | ---: |
| Current discovery intensity | 45% | 30% | 16% | 7% |
| Baseline demand | 5% | 10% | 20% | 30% |
| Acceleration | 28% | 27% | 22% | 16% |
| Momentum | 8% | 17% | 18% | 20% |
| Consistency | 2% | 7% | 14% | 20% |
| Breakout | 2% | 3% | 5% | 7% |
| Recency | 10% | 6% | 5% | 0% |

24H asks what matters right now; 7D asks what mattered this week; 30D emphasizes month-scale prominence and consistency; 1Y emphasizes durable demand, momentum, and consistency.

Historical Growth is the preferred acceleration input. When it is unavailable, bounded current discovery acceleration can substitute at 100% of its value for 24H, 70% for 7D, 35% for 30D, and 10% for 1Y. A current spike therefore cannot masquerade as a year-scale growth signal.

Optional missing signals are omitted and the available weights renormalized. They are never represented as zero. A separate explicit history-coverage evidence-match modifier applies after composition: 90–100% in 24H, 76–100% in 7D, 60–100% in 30D, and 42–100% in 1Y. This is not a fabricated component: it transparently reduces confidence and contribution when the evidence horizon does not match the ranking horizon. Current discovery intensity remains required, so Emerging topics are still rankable; their current-only evidence naturally performs best at shorter horizons.

`public_score` is the consumer-facing Now Score: `min(99, 54 + 0.45 × unifiedRawScore)`. It is a monotonic transform of the measured raw score, not a function of rank position. Ordering uses raw score descending, then title for deterministic ties.

Evidence status is descriptive only. Candidates with sufficient historical evidence are `established`; other candidates with valid current discovery intensity are `emerging`. Neither label changes score or rank.
