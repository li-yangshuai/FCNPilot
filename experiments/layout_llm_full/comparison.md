# TOY/MAJ full-study comparison

Audit passed: **true**. 30 named representations; 29 byte-unique sources; 16 fixed-port truth-table groups.

Source scope: Inputs preserve the original source bytes from `engine/tests/benchmarks_f`. Original TOY/RCA2 is tested exactly as supplied. Source equivalence does not imply correct two-bit arithmetic; the separately corrected v1 changes 12/32 vectors. Original TOY/xor2 header is repaired by the existing frontend without changing logic; source and normalized hashes are both frozen. 30 representation cases contain 29 byte-unique sources and 16 fixed-port-order truth-table groups. Neither repeats nor equivalent encodings are independent new functions.

Coverage: 120 native slots, 360 policy/repetition slots, 1080 allocated round slots. Failures and unavailable slots remain listed. Unavailable baselines are excluded from paired improvement means; failed policy campaigns keep the certified baseline as zero delivered improvement. Unmeasured candidate metrics remain unavailable.

Native results compare descriptive configurations within a clock family. June allows at most 10 consecutive same-phase tiles and 30% same-phase steps; Compact allows at most 4 consecutive same-phase tiles. They are not a same-constraint causal comparison. The four policy arms do share the exact same chosen backend, baseline, DAG, clock rules and candidate budget within each case.

## Native configuration coverage

| Configuration | Clock family | Certified / unique sources | Success rate |
|---|---|---:|---:|
| june | irregular | 22 / 29 | 75.86% |
| compact | irregular | 4 / 29 | 13.79% |
| normal | 2DDWave | 8 / 29 | 27.59% |
| regular_ga | 2DDWave | 4 / 29 | 13.79% |

## Paired policy outcomes

Values average the three repetitions within each canonical source, then weight eligible sources equally. The first protocol-listed name for each source hash is canonical; no best-of-duplicate selection is used.

| Policy | Eligible sources | Improved / eligible allocated campaigns | Mean area reduction | Mean cell reduction | Recorded model requests / unknown usage |
|---|---:|---:|---:|---:|---:|
| noop | 21 | 0 / 63 | 0.00% | 0.00% | 0 / 0 |
| random | 21 | 1 / 63 | 0.00% | 0.07% | 0 / 0 |
| heuristic | 21 | 24 / 63 | 9.47% | 7.12% | 0 / 0 |
| llm | 21 | 31 / 63 | 2.33% | 2.10% | 189 / 5 |

Recorded requests are not proof of provider billing. Raw response usage is summed only when known; missing/partial audits and provider-error zero placeholders remain unknown. No-op still reroutes and may reassign clocks; native routing uses its fixed deterministic search. The simple heuristic does not learn from failed proposals and can repeat them. CSV files report both unique operation lists and unique incumbent-plus-operation pairs. They do not count rationales as new proposals.

## All named native rows

Each passing entry is actual area / QCA cells; otherwise the terminal status is shown. A dagger marks a duplicate source omitted from primary aggregation.

| Case | June | Compact | Normal | Regular GA |
|---|---:|---:|---:|---:|
| TOY/1bitAdderAOIG.v | 144 / 479 | 72 / 362 | 42 / 217 | failed |
| TOY/1bitAdderMaj.v | 510 / 1413 | failed | failed | failed |
| TOY/RCA2.v | 598 / 1435 | failed | failed | failed |
| TOY/b1_r2.v | 169 / 532 | failed | failed | failed |
| TOY/clpl.v | failed | failed | failed | failed |
| TOY/mux21.v | 60 / 196 | 30 / 144 | 16 / 80 | 16 / 61 |
| TOY/mux41.v | failed | failed | failed | failed |
| TOY/newtag.v | 285 / 698 | failed | failed | failed |
| TOY/paper_2ddwave_carry_demo.v | 105 / 337 | 48 / 222 | 20 / 125 | failed |
| TOY/paper_2ddwave_crossing_demo.v | 70 / 267 | failed | failed | 42 / 169 |
| TOY/paper_2ddwave_xor_demo.v | 40 / 160 | failed | 12 / 79 | 12 / 70 |
| TOY/par_check.v | 345 / 736 | failed | failed | failed |
| TOY/par_gen.v | 162 / 501 | failed | 40 / 231 | failed |
| TOY/t.v | 120 / 387 | failed | failed | failed |
| TOY/xnor2.v | 90 / 234 | failed | failed | failed |
| TOY/xor2.v | 40 / 160 | failed | 12 / 79 | 12 / 70 |
| TOY/xor5R.v | 714 / 1494 | failed | failed | failed |
| MAJ/1bitAdderAOIG.v | failed | failed | failed | failed |
| MAJ/1bitAdderMaj.v | 120 / 308 | 56 / 258 | failed | failed |
| MAJ/RCA2.v | failed | failed | failed | failed |
| MAJ/clpl.v | 1218 / 2564 | failed | failed | failed |
| MAJ/mux41.v | failed | failed | failed | failed |
| MAJ/newtag.v | 836 / 1284 | failed | failed | failed |
| MAJ/par_check.v | failed | failed | failed | failed |
| MAJ/par_gen.v | 555 / 1361 | failed | 40 / 231 | failed |
| MAJ/t.v | 253 / 643 | failed | failed | failed |
| MAJ/xnor2.v | 341 / 681 | failed | failed | failed |
| MAJ/xor2.v | 319 / 673 | failed | 12 / 79 | failed |
| MAJ/xor5R.v | failed | failed | failed | failed |
| MAJ/xor5_r1.v † | failed | failed | failed | failed |

## All named paired policy means

Each entry is delivered area reduction / cell reduction (%), averaged over the allocated repetitions. Full statuses and unique-proposal counts are in comparison_campaigns.csv.

| Case | Paired backend | No-op | Random | Heuristic | LLM |
|---|---|---:|---:|---:|---:|
| TOY/1bitAdderAOIG.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 3.83 |
| TOY/1bitAdderMaj.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| TOY/RCA2.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.12 |
| TOY/b1_r2.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 15.38 / 4.70 | 0.00 / 0.00 |
| TOY/clpl.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| TOY/mux21.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 33.33 / 35.20 | 0.00 / 0.00 |
| TOY/mux41.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| TOY/newtag.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 7.72 / 0.00 |
| TOY/paper_2ddwave_carry_demo.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 6.13 |
| TOY/paper_2ddwave_crossing_demo.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 50.00 / 43.82 | 0.00 / 5.99 |
| TOY/paper_2ddwave_xor_demo.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 |
| TOY/par_check.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 21.74 / 14.81 | 0.00 / 0.00 |
| TOY/par_gen.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 1.33 |
| TOY/t.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 1.29 |
| TOY/xnor2.v | june_random | 0.00 / 0.00 | 0.00 / 1.57 | 0.00 / 0.00 | 5.56 / 3.56 |
| TOY/xor2.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 8.33 / 5.42 |
| TOY/xor5R.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 22.83 / 4.48 | 0.00 / 2.30 |
| MAJ/1bitAdderAOIG.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| MAJ/1bitAdderMaj.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 37.50 / 27.92 | 25.00 / 10.50 |
| MAJ/RCA2.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| MAJ/clpl.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 3.45 / 5.73 | 0.00 / 0.13 |
| MAJ/mux41.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| MAJ/newtag.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 14.59 / 12.85 | 0.00 / 0.13 |
| MAJ/par_check.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| MAJ/par_gen.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 2.22 / 1.59 |
| MAJ/t.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 1.76 |
| MAJ/xnor2.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 |
| MAJ/xor2.v | june_random | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.00 |
| MAJ/xor5R.v | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |
| MAJ/xor5_r1.v † | unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable | unavailable / unavailable |

Three repetitions are repeated evaluations of the same circuit, not new independent circuits. Equal candidate budgets do not equalize model cost or wall time; configured concurrency is 2. These are descriptive bounded results, without significance or broad-superiority claims.

Read-only source/DAG Boolean re-evaluation, actual IFCN clock-zone arrival and area, QCA counts, recorded physical-certificate coverage and content-hash bindings. No electrical waveform, device settling-time, hardware or power benefit is measured.
