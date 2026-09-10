# Frozen full layout study

30 representation cases; 29 byte-unique sources; 16 fixed-port-order functional groups.
Baselines: 120 allocated, 38 certified. Optimization eligible cases: 21/30.
Campaigns: 360 allocated. Rounds: 1080 allocated, 756 attempted, 324 not run.

| Policy | Campaign states | Usable sources / all sources | Attempted rounds / allocated | Mean area reduction | Mean QCA reduction | Unknown usage rounds |
|---|---|---:|---:|---:|---:|---:|
| noop | {"completed": 63, "unavailable": 27} | 21/29 | 189/270 | 0.00% | 0.00% | 0 |
| random | {"completed": 63, "unavailable": 27} | 21/29 | 189/270 | 0.00% | 0.07% | 0 |
| heuristic | {"completed": 63, "unavailable": 27} | 21/29 | 189/270 | 9.47% | 7.12% | 0 |
| llm | {"completed": 63, "unavailable": 27} | 21/29 | 189/270 | 2.33% | 2.10% | 5 |

Means summarize usable repeats of the first protocol case per byte-unique source, with missing outcomes excluded and coverage shown. See CSVs for all representations, rounds, actual moves, validation outcomes, logs and null values. Repeats and duplicate/functionally equivalent inputs are not independent circuits.

Baseline selection is first eligible June, otherwise Compact. Every policy and repeat uses the same original selected baseline. Native routing and validation are deterministic; the model only proposes edits.
