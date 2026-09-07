#!/usr/bin/env python3
"""Derive fig05/06/07/S1 from hash-pinned local evidence snapshots.

Run again after compiling the PDFs to refresh their artifact hashes.  The first
run copies only the source JSON files actually referenced by these four figures;
later runs work with the paper directory alone and never rerun experiments.
"""
import collections
import csv
import hashlib
import json
from pathlib import Path
import sys

REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / "experiments/scripts"))
from archive_paths import recorded_path

PAPER = Path(__file__).resolve().parents[1]
ROOT = REPOSITORY / "engine"
DATA = PAPER / "data"
FIGURES = PAPER / "figures"
SOURCE_INDEX = REPOSITORY / "experiments/archive/figure-source-index.json"
FIGURE_NAMES = ("fig05_backend_coverage", "fig06_paired_area", "fig07_llm_pilot", "figS1_benchmark_curation")
_source_cache = {}
BENCH = ROOT / "output/pi-validation/backend-comparison-20260905T103536Z"
PILOT = ROOT / "output/pi-validation/agent-comparison-2026-09-05T10-29-05-410Z"
MANIFEST = ROOT / "tests/benchmarks_pi/v1/manifest.json"
SUMMARY = BENCH / "summary/summary.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source(path):
    """Read only the curated archive and verify its original pinned digest."""
    relative = path.relative_to(ROOT).as_posix()
    if relative in _source_cache:
        return _source_cache[relative]
    index = json.loads(SOURCE_INDEX.read_text())
    record = index["sources"][relative]
    snapshot = recorded_path(path)
    if digest(snapshot) != record["sha256"]:
        raise ValueError(f"Evidence snapshot hash mismatch: {snapshot}")
    record = {**record, "snapshot_path": snapshot.relative_to(REPOSITORY).as_posix()}
    _source_cache[relative] = (snapshot, record)
    return snapshot, record


def read(path):
    snapshot, _ = source(path)
    return json.loads(snapshot.read_text())


def table(name, fields, records):
    path = DATA / name
    with path.open("w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=fields)
        writer.writeheader()
        writer.writerows(records)
    return path


def tex(value):
    return str(value).replace("_", r"\_")


def evidence(name, sources, elements, data_paths, limitations):
    document = {
        "schema": "ifcn.paper.figure.evidence.v1", "figure": name,
        "sources": [dict(source(path)[1], keys=keys) for path, keys in sources],
        "elements": elements, "derived_data": [{"path": str(path.relative_to(PAPER)), "sha256": digest(path)} for path in data_paths],
        "generator": {"path": str(Path(__file__)), "sha256": digest(Path(__file__))},
        "figure_artifacts": [{"path": str(path.relative_to(PAPER)), "sha256": digest(path)}
                             for path in [FIGURES / (name + suffix) for suffix in (".tex", ".pdf", ".caption.md")]
                             if path.exists()],
        "shared_preamble": {"path": "figures/common.tex", "sha256": digest(FIGURES / "common.tex")},
        "transformation": "python3 scripts/build_audit_figures_data.py (from paper directory); deterministic selection and aggregation of hash-pinned local snapshots; rerun after PDF compilation to refresh artifact hashes",
        "limitations": limitations,
        "relations": "No arrows or junctions assert physical interconnection; marks encode observations or grouping only.",
    }
    (FIGURES / (name + ".evidence.json")).write_text(json.dumps(document, indent=2) + "\n")


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    manifest, summary = read(MANIFEST), read(SUMMARY)
    assert manifest["counts"]["files"] == 30 and manifest["counts"]["frozen_byte_unique"] == 29
    assert manifest["counts"]["fixed_port_order_truth_table_classes"] == 16
    assert summary["eligible_for_comparison"] and summary["qualified_comparison_eligible"]
    qualification = summary["joined_qualification"]
    assert qualification["raw_execution_completed"] == 55 and qualification["source_dag_and_qca_counts_qualified"] == 48
    methods = ["normal_2ddwave", "compact", "june_random"]
    rows = {(row["case"], row["algorithm"]): row for row in qualification["rows"]}
    matrix, fragments, status_counts = [], [], collections.Counter()
    for index, case in enumerate(manifest["cases"]):
        codes = []
        for method in methods:
            row = rows[(case["id"], method)]
            unsupported = row["logic_status"] == "unsupported"
            io_bad = row["qca_interface_counts_status"] == "count_mismatch"
            if not row["raw_execution_completed"]:
                code, label = 0, "execution_incomplete"
            elif row["source_dag_and_qca_counts_qualified"]:
                code, label = 1, "added_checks_passed"
            elif unsupported and io_bad:
                code, label = 4, "unsupported_and_io_count_mismatch"
            elif unsupported:
                code, label = 2, "dag_unsupported_only"
            elif io_bad:
                code, label = 3, "io_count_mismatch_only"
            else:
                raise ValueError(f"Unclassified outcome: {case['id']} {method}")
            codes.append(code)
            status_counts[label] += 1
            matrix.append({"case": case["id"], "algorithm": method, "code": code, "category": label})
        fragments.append(r"\CoverageRow{%d}{%s}{%d}{%d}{%d}" % (index, tex(case["id"]), *codes))
    assert list(status_counts.values()) and sum(status_counts.values()) == 90
    assert status_counts == {"execution_incomplete": 35, "added_checks_passed": 48, "dag_unsupported_only": 3,
                             "io_count_mismatch_only": 3, "unsupported_and_io_count_mismatch": 1}
    coverage_csv = table("fig05_coverage.csv", ["case", "algorithm", "code", "category"], matrix)
    matrix_tex = DATA / "fig05_matrix_rows.tex"
    matrix_tex.write_text("\n".join(fragments) + "\n")
    bars = []
    for index, method in enumerate(methods, 1):
        bars.append({"x": index, "raw": qualification["by_algorithm"][method]["raw_execution_completed"],
                     "qualified": qualification["by_algorithm"][method]["source_dag_and_qca_counts_qualified"],
                     "representative": summary["qualified_scopes"]["preselected_function_representatives"]["by_algorithm"][method]["completed"]})
    bars_csv = table("fig05_coverage_bars.csv", ["x", "raw", "qualified", "representative"], bars)
    evidence("fig05_backend_coverage", [(MANIFEST, ["cases[].id", "function_groups[].representative_case_id"]),
             (SUMMARY, ["joined_qualification.rows[]", "joined_qualification.by_algorithm", "qualified_scopes.preselected_function_representatives"]),
             (BENCH / "results.json", ["finished", "total", "rows"]),
             (ROOT / "output/pi-validation/routed-logic-audit-final.json", ["by_status", "rows"]),
             (ROOT / "output/pi-validation/qca-output-count-diagnostic.json", ["output_count_mismatches"])],
             [{"element": "30 by 3 matrix", "claim": "Every planned case and algorithm retained", "unit": "one archived execution", "categories": dict(status_counts)},
              {"element": "raw/added-check bars", "claim": "55 execution completions versus 48 source-DAG and QCA-count qualifications", "unit": "attempts / 90"},
              {"element": "representative panel", "claim": "8, 5, 13 of 16 manifest-preselected representatives", "unit": "representative cases"}],
             [coverage_csv, matrix_tex, bars_csv], ["The four unsupported DAG audits are not four proven nonequivalences; no not_equivalent outcome was observed.", "One unsupported case also loses QCA outputs; categories are mutually exclusive.", "Qualified does not imply device waveform, timing or power correctness.", "Archived matrix predates later production guard additions."])

    pair_paths = []
    pair_elements = []
    pairs = summary["qualified_scopes"]["preselected_function_representatives"]["paired_comparisons"]
    for index, pair in enumerate(pairs, 1):
        data = pair["metrics"]["occupied_bbox_area_tiles"]
        assert data["paired_case_count"] == [4, 8, 5][index - 1]
        records = [{"case": item["case"], "left": item["left"], "right": item["right"]} for item in data["pairs"]]
        pair_paths.append(table(f"fig06_pair{index}.csv", ["case", "left", "right"], records))
        coordinates = collections.Counter((item["left"], item["right"]) for item in records)
        pair_paths.append(table(f"fig06_pair{index}_points.csv", ["left", "right", "multiplicity"],
                                [{"left": a, "right": b, "multiplicity": count} for (a,b),count in coordinates.items()]))
        pair_elements.append({"element": f"scatter panel {index}", "left": pair["left_algorithm"], "right": pair["right_algorithm"],
                              "claim": "Occupied bounding-box area for identical preselected representatives passing both pipelines' added checks", "n": len(records), "unit": "gate-level tiles", "cases": records})
    evidence("fig06_paired_area", [(SUMMARY, ["qualified_scopes.preselected_function_representatives.paired_comparisons[].metrics.occupied_bbox_area_tiles"]),
             (MANIFEST, ["function_groups[].representative_case_id"]),
             (BENCH / "results.json", ["rows[].occupied_bounds", "rows[].metrics.pnr.area_tiles"])], pair_elements, pair_paths,
             ["Pair-specific common subsets differ (n=4,8,5); no cross-subset mean comparison or superiority inference.", "Axes are logarithmic and equal within each panel; the dashed line is equal occupied area.", "Compact/June contains two coincident cases at (48,126), explicitly marked x2.", "Pipeline inputs are identical frozen Verilog; the pipelines need not use identical DAG representations."])

    aggregate, trials, posthoc = read(PILOT / "aggregate.json"), read(PILOT / "results.json"), read(PILOT / "posthoc-analysis.json")
    llm_methods = ["script", "generic_pi", "domain_agent"]
    group = {x["method"]: x for x in aggregate["groups"]}
    post = {x["method"]: x for x in posthoc["posthoc_full_report_correct"]}
    llm_bars = []
    for index, method in enumerate(llm_methods, 1):
        assert group[method]["trials"] == 8
        llm_bars.append({"x": index, "mapping": group[method]["completed"], "structured": group[method]["delivery_correct"],
                         "text": post[method]["posthoc_full_report_correct"]})
    assert [(x["mapping"],x["structured"],x["text"]) for x in llm_bars] == [(8,8,8),(7,5,5),(6,6,5)]
    llm_csv = table("fig07_llm_bars.csv", ["x", "mapping", "structured", "text"], llm_bars)
    post_trials = {x["id"]: x for x in posthoc["trials"]}
    cases = {(x["task"], x["repeat"], x["method"]): x for x in trials}
    fragments, fullrows = [], []
    tasks = [("ordinary_map", "Map"), ("specified_backend", "Backend"), ("recover_missing_input", "Recover"), ("artifact_boundaries", "Read")]
    for task_index, (task, label) in enumerate(tasks):
        for repeat in (1, 2):
            row_index = task_index * 2 + repeat - 1
            fragments.append(r"\PilotRowLabel{%d}{%s %d}" % (row_index, label, repeat))
            for method_index, method in enumerate(llm_methods):
                item = cases[(task, repeat, method)]
                review = post_trials[item["id"]]
                mapping = int(item["metrics"]["requested_work_completed"])
                structured = int(item["metrics"]["task_delivery_correct"])
                text_passed = int(bool(structured) and not review["qualitative_issues"])
                service_error = int(bool(review["error_class"]))
                fragments.append(r"\PilotTrial{%d}{%d}{%d}{%d}{%d}{%d}" % (row_index, method_index, mapping, structured, text_passed, service_error))
                fullrows.append({"trial": item["id"], "task": task, "repeat": repeat, "method": method,
                                 "mapping": mapping, "structured": structured, "text": text_passed, "service_error": service_error})
    for method in llm_methods:
        selected = [x for x in fullrows if x["method"] == method]
        assert sum(x["text"] for x in selected) == post[method]["posthoc_full_report_correct"]
    trial_csv = table("fig07_trial_cells.csv", ["trial", "task", "repeat", "method", "mapping", "structured", "text", "service_error"], fullrows)
    trial_tex = DATA / "fig07_trial_cells.tex"
    trial_tex.write_text("\n".join(fragments) + "\n")
    evidence("fig07_llm_pilot", [(PILOT / "aggregate.json", ["groups[].completed", "groups[].delivery_correct", "groups[].trials"]),
             (PILOT / "results.json", ["[].metrics.requested_work_completed", "[].metrics.task_delivery_correct"]),
             (PILOT / "posthoc-analysis.json", ["trials[].qualitative_issues", "trials[].error_class", "posthoc_full_report_correct"]),
             (PILOT / "protocol.json", ["protocol_version", "tasks", "schedule[].method", "comparison", "default_model", "limits"])],
             [{"element": "grouped bars", "claim": "Mapping 8/7/6, prespecified structured delivery 8/5/6, post-hoc text-inclusive delivery 8/5/5, all denominators eight", "unit": "trials"},
              {"element": "24-trial grid", "claim": "Three separate Boolean scores per original trial; infrastructure errors retained", "unit": "one task/repeat/method execution", "service_errors": 4}],
             [llm_csv, trial_csv, trial_tex], ["Four task types, two repeats and three methods constitute a pilot, not evidence of method superiority.", "The LLM conditions share qwen3-vl-plus and the same tools, backend, permissions and budgets; only the system prompt differs.", "The fixed script consumes structured task specifications and is not a natural-language understanding baseline.", "All tasks stop at mapping. Prespecified and post-hoc scores are separate analyses; failed trials were not removed or rerun."])

    evidence("figS1_benchmark_curation", [(MANIFEST, ["counts", "cases[].change_notes", "cases[].exact_duplicate_of", "function_groups"]),
             (ROOT / "tests/benchmarks_pi/v1/evidence_eligibility.json", ["entries[].eligibility", "default_for_unlisted_artifacts"])],
             [{"element": "three aligned corpus panels", "claim": "30 files, 29 byte identities and 16 fixed-port truth-table groups describe the same snapshot; they are not a causal filtering pipeline", "unit": "explicitly labeled identity levels"},
              {"element": "copy edits", "claim": "TOY/xor2 header normalization and TOY/RCA2 independently checked arithmetic correction; originals preserved"},
              {"element": "historical exclusion strip", "claim": "small_compaction_results.csv and large_fiction_results.csv excluded from new efficacy evidence"}], [],
             ["The sixteen groups use declaration-order input/output truth tables, not unrestricted permutation or NPN equivalence.", "MAJ/RCA2 and par_check retain source logic without assigning an unverified conventional specification.", "Byte duplicates and equivalent alternative representations do not add independent functions."])
    print("Derived four figures: 90 outcomes; 4/8/5 paired representatives; 24 pilot trials; 30/29/16 corpus descriptors.")


if __name__ == "__main__":
    main()
