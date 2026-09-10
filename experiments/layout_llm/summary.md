# Prespecified layout-edit pilot

Three fixed circuits, four policies, one repetition and three rounds per campaign. Failures remain included; no replacement circuits or model retries.

| Circuit | Policy | Status | Area, before → selected | Cells, before → selected | Accepted / rounds | Model tokens |
|---|---|---|---:|---:|---:|---:|
| xor2 | noop | completed | 40 → 40 | 160 → 160 | 0 / 3 | n/a |
| xor2 | random | completed | 40 → 40 | 160 → 160 | 0 / 3 | n/a |
| xor2 | heuristic | completed | 40 → 40 | 160 → 160 | 0 / 3 | n/a |
| xor2 | llm | completed | 40 → 30 | 160 → 140 | 1 / 3 | 6314 |
| xnor2 | noop | completed | 90 → 90 | 234 → 234 | 0 / 3 | n/a |
| xnor2 | random | completed | 90 → 90 | 234 → 223 | 1 / 3 | n/a |
| xnor2 | heuristic | completed | 90 → 90 | 234 → 234 | 0 / 3 | n/a |
| xnor2 | llm | completed | 90 → 90 | 234 → 234 | 0 / 3 | 5348 + unknown |
| mux21 | noop | completed | 60 → 60 | 196 → 196 | 0 / 3 | n/a |
| mux21 | random | completed | 60 → 60 | 196 → 196 | 0 / 3 | n/a |
| mux21 | heuristic | completed | 60 → 40 | 196 → 127 | 2 / 3 | n/a |
| mux21 | llm | completed | 60 → 60 | 196 → 196 | 0 / 3 | 8838 |

All coordinate proposals, executed moves, rerouted edges, clock repairs, rejected candidates, and failure reasons are retained in summary.json and rounds.csv, with original run paths. Missing model usage is not treated as zero.

These are descriptive small-circuit pilot results. Equal proposal counts and validation budgets do not mean equal model cost or wall time. Routing and phase assignment are shared executors; any model benefit must be assessed against noop, random and heuristic policies. This experiment does not establish general superiority, statistical significance, device-waveform correctness, or power signoff.
