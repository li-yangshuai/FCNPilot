#!/usr/bin/env python3
"""Budgeted direct-LLM internal-node relocation with fixed I/O coordinates.

This is a separate research entrypoint; it does not change frozen cut-menu runs.
Run with --output NEW_DIRECTORY [--cases TOY/t.v MAJ/par_gen.v].
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import shutil
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine/scripts"))
import ifcn_joint_search as search
import ifcn_internal_search as interior
from ifcn_layout_optimization import choose_node
from run_study import prepare_baseline, model_call

save = search.save
POLICIES = ("deterministic_internal", "llm_internal")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def evaluate(current, proposal, target, inputs, prepared, timeout):
    return search.evaluate(current, proposal, target, inputs/"source.v",
                           inputs/"normalized.v", prepared["manifest"]["frontend"],
                           prepared["manifest"]["configuration"], timeout, lock_io=True)


def run_policy(folder, policy, prepared, node, model, rounds, timeout):
    inputs = folder/"inputs"
    current = copy.deepcopy(prepared["baseline"])
    metrics = copy.deepcopy(prepared["metrics"])
    clock = copy.deepcopy(prepared["clock"])
    history, seen = [], set()
    root = folder/policy
    root.mkdir()
    selected = None
    for number in range(1, rounds+1):
        target = root/f"{number:02d}"
        target.mkdir()
        row = {"round": number, "status": "failed", "start_metrics": copy.deepcopy(metrics),
               "start_placement": search.key(current)}
        begin = time.monotonic()
        try:
            suggestions = interior.internal_actions(current, seen, limit=64)[:24]
            context = interior.context_for(current, metrics, clock, history, suggestions)
            save(target/"context.json", context)
            if policy == "llm_internal":
                audit, latency = model_call(node, context, model, target,
                                            f"{folder.parent.name}:{folder.name}:{policy}:{number}")
                row.update(model=audit["model"], usage=audit.get("tokens"),
                           model_latency_s=latency, proposal=audit["proposal"])
                proposal = search.validate_proposal(audit["proposal"], current, lock_io=True)
                row["matches_suggested_coordinates"] = any(
                    search.key(search.apply_positions(current, proposal["operations"])) ==
                    search.key(search.apply_positions(current, item["operations"]))
                    for item in suggestions)
            else:
                if not suggestions:
                    row.update(status="exhausted", error="Internal geometric candidates exhausted")
                    history.append(row)
                    save(target/"result.json", row)
                    break
                item = suggestions[0]
                proposal = {k: copy.deepcopy(item[k])
                            for k in ("schema", "operations", "routing_order", "rationale")}
                row["suggestion_id"] = item["id"]
            row["proposal"] = proposal
            identifier = interior.action_key(current, proposal)
            if identifier in seen:
                raise ValueError("Repeated exact placement/order candidate consumes this slot; no retry")
            seen.add(identifier)
            result = evaluate(current, proposal, target/"joint", inputs, prepared, timeout)
            row.update(result)
            if result["status"] == "certified":
                candidate = json.loads((target/"joint/layout_candidate.json").read_text())
                row["internal_changes"] = interior.change_record(current, candidate)
                row["status"] = "accepted" if search.pareto(metrics, result["metrics"]) else "rejected"
                # Diagnostic shadows do not affect live choices, metrics or feedback.
                # Only accepted LLM proposals trigger them; this is not a corpus-wide ablation mean.
                if row["status"] == "accepted" and policy == "llm_internal":
                    routing_only = {**proposal, "operations": [],
                                    "rationale": "Diagnostic: same exact route order with every node fixed."}
                    try:
                        shadow = evaluate(current, routing_only, target/"routing_only", inputs, prepared, timeout)
                    except Exception as error:
                        shadow = {"status": "failed", "error": str(error)}
                    save(target/"attribution.json", {
                        "scope": "Diagnostic replay of an accepted proposal, not a live search or an all-case ablation.",
                        "same_incumbent": True, "routing_only": shadow,
                        "joint_metrics": result["metrics"],
                        "joint_strictly_dominates_routing_only": (
                            search.pareto(shadow["metrics"], result["metrics"])
                            if shadow["status"] == "certified" else None)})
                    # Keep ablation scores out of feedback to the next model call.
                if row["status"] == "accepted":
                    current = candidate
                    metrics = copy.deepcopy(result["metrics"])
                    clock = json.loads((target/"joint/clock.json").read_text())
                    selected = number
        except Exception as error:
            row.update(status="failed", error=str(error))
            response = target/"response.json"
            if response.exists():
                try:
                    audit = json.loads(response.read_text())
                    row.update(model=audit.get("model"), usage=audit.get("tokens"),
                               model_error=audit.get("error"))
                except (OSError, ValueError):
                    pass
        row["total_elapsed_s"] = time.monotonic()-begin
        history.append(row)
        save(target/"result.json", row)
        print(folder.name, policy, number, row["status"],
              row.get("metrics", {}).get("area_tiles"),
              row.get("metrics", {}).get("qca_cells"), flush=True)
    record = {"initial": prepared["metrics"], "selected": metrics, "selected_round": selected,
              "outcomes": dict(Counter(r["status"] for r in history)), "rounds": history,
              "live_native_evaluations": len(list(root.glob("*/joint/evaluation.log"))),
              "real_model_requests": len(list(root.glob("*/request.json"))),
              "diagnostic_native_evaluations": len(list(root.glob("*/routing_only/evaluation.log"))),
              "final_internal_changes": interior.change_record(prepared["baseline"], current)}
    save(root/"summary.json", record)
    return {k:v for k,v in record.items() if k != "rounds"}


def run_case(entry, prepared, folder, node, model, rounds, timeout):
    reports = {}
    order = POLICIES if entry["ordinal"] % 2 else tuple(reversed(POLICIES))
    for policy in order:
        reports[policy] = run_policy(folder, policy, prepared, node, model, rounds, timeout)
    result = {"case_id": entry["case_id"], "eligible": True, "status": "completed",
              "policy_order": list(order), "policies": reports}
    save(folder/"summary.json", result)
    return result


def aggregate(rows):
    eligible = sum(r.get("eligible", False) for r in rows)
    data = [r for r in rows if r["status"] == "completed"]
    result = {"cases": len(rows), "eligible_cases": eligible, "completed_cases": len(data),
              "statuses": dict(Counter(r["status"] for r in rows)), "policies": {}}
    for policy in POLICIES:
        reports = [r["policies"][policy] for r in data]
        areas = [(r["initial"]["area_tiles"]-r["selected"]["area_tiles"]) /
                 r["initial"]["area_tiles"]*100 for r in reports]
        cells = [(r["initial"]["qca_cells"]-r["selected"]["qca_cells"]) /
                 r["initial"]["qca_cells"]*100 for r in reports]
        result["policies"][policy] = {
            "improved_cases": sum(search.pareto(r["initial"], r["selected"]) for r in reports),
            "mean_area_reduction_pct": sum(areas)/len(areas) if areas and len(data)==eligible else None,
            "mean_qca_reduction_pct": sum(cells)/len(cells) if cells and len(data)==eligible else None,
            "live_native_evaluations": sum(r["live_native_evaluations"] for r in reports),
            "real_model_requests": sum(r["real_model_requests"] for r in reports),
            "outcomes": dict(sum((Counter(r["outcomes"]) for r in reports), Counter()))}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cases", nargs="+", help="Declared subset; default: every frozen TOY/MAJ entry")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 8 or not 1 <= args.workers <= 2:
        parser.error("rounds must be 1..8 and workers 1..2")
    old = ROOT/"experiments/layout_llm_full"
    old_protocol = json.loads((old/"protocol.json").read_text())
    index = json.loads((old/"index.json").read_text())
    if index["protocol_sha256"] != sha(old/"protocol.json"):
        raise ValueError("Frozen baseline protocol hash changed")
    if json.loads((old/"audit.json").read_text())["index_sha256"] != sha(old/"index.json"):
        raise ValueError("Frozen baseline selection hash changed")
    known = {c["id"] for c in old_protocol["cases"]}
    if args.cases and (not set(args.cases) <= known or len(args.cases) != len(set(args.cases))):
        parser.error("--cases must be unique frozen case IDs")
    cases = [c for c in old_protocol["cases"] if args.cases is None or c["id"] in args.cases]
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    model = {"provider":old_protocol["model"]["provider"], "modelId":old_protocol["model"]["model_id"]}
    node = choose_node(ROOT/"engine")
    watched = {str(old/n):sha(old/n) for n in ("protocol.json","index.json","audit.json")}
    frozen = ROOT/"experiments/llm_joint_search/transfer_toy_maj_v3_r1"
    for name in ("protocol.json","summary.json","audit.json"):
        watched[str(frozen/name)] = sha(frozen/name)
    entries, prepared = [], {}
    for ordinal, case in enumerate(cases, 1):
        selection = index["selection"][case["id"]]
        entry = {"ordinal":ordinal, "case_id":case["id"], "source_sha256":case["source_sha256"],
                 "status":"unavailable", "eligible":False, "reasons":selection["reasons"]}
        if selection["status"] == "selected":
            entry["folder"] = f"c{ordinal:02d}_{case['group']}_{Path(case['id']).stem}"
            folder = out/entry["folder"]
            folder.mkdir()
            try:
                bundle = prepare_baseline(ROOT/"engine/output/pi-runs"/selection["run_id"], folder/"inputs")
                if sha(folder/"inputs/source.v") != case["source_sha256"]:
                    raise ValueError("Source does not match frozen corpus")
                if sha(folder/"inputs/normalized.v") != case["normalized_sha256"]:
                    raise ValueError("Normalized source does not match frozen corpus")
                prepared[case["id"]] = bundle
                watched.update(bundle["source_artifacts"])
                entry.update(status="eligible", eligible=True, reasons=[], run_id=selection["run_id"],
                             initial=bundle["metrics"],
                             fixed_port_count=len(interior.fixed_ports(bundle["baseline"])),
                             internal_node_count=len(bundle["baseline"]["nodes"])-len(interior.fixed_ports(bundle["baseline"])))
            except Exception as error:
                entry.update(status="preflight_failed", reasons=[str(error)])
        entries.append(entry)
    files = [Path(__file__), Path(__file__).with_name("run_study.py"),
             ROOT/"integrations/pi/layout-proposer.mjs",
             *sorted((ROOT/"engine/scripts").glob("*.py")),
             ROOT/"engine/src/app/ifcn_layout_edit.cpp",
             ROOT/"engine/include/autopr/graph/circuitGraph.cpp"]
    implementation = {str(f):sha(f) for f in files}
    for file in files:
        dest = out/"implementation"/file.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, dest)
    binary_hashes = {str(ROOT/"engine/build"/name):sha(ROOT/"engine/build"/name)
                     for name in ("ifcn_layout_edit","ifcn_energy_analysis","ifcn_mapping_metrics")}
    timeout = old_protocol["candidate_timeout_s"]
    save(out/"protocol.json", {
        "schema":"fcn.internal_relocation_study.v1.1", "created_at":datetime.now(timezone.utc).isoformat(),
        "case_entries":entries, "rounds_per_policy":args.rounds, "workers":args.workers,
        "model":model, "candidate_timeout_s":timeout, "model_timeout_s":60,
        "action_space":"Direct v2 <=8 moves/swaps; only internal nodes; all source-derived PI/PO XY locked in the native editor. Phases are not pinned.",
        "control":"Deterministic selects the first unseen internal geometric suggestion with control_order. LLM sees the same unevaluated suggestions and full state but may synthesize other legal internal placements and complete edge orders.",
        "acceptance":"Same original algorithm and irregular-clock rules, fixed graph/source/port identity, exhaustive Boolean equivalence, absolute arrivals, QCA physical routes and ports; actual area/cells both nonincreasing, one strictly lower.",
        "budgets":"Equal live proposal slots and 20s total candidate limit (native subprocess budget at most 18s); each explicit route order runs once, no fallback. Invalid/repeated/model-failed slots consume a round; no retry.",
        "diagnostics":"Only accepted LLM proposals get a routing-only replay from the same incumbent. Shadow scores are excluded from live feedback and aggregate optimization metrics.",
        "scope":"Bounded fixed-port internal optimization study; not convergence or an assertion of LLM superiority. Unavailable and failed cases retained. Grouped moves preserve all logical nodes.",
        "original_artifact_hashes":watched, "implementation_hashes":implementation,
        "binary_hashes":binary_hashes, "execution_environment":search.EXECUTION_ENV})
    results = {e["case_id"]:{"case_id":e["case_id"],"eligible":e["eligible"],
                            "status":"pending" if e["eligible"] else e["status"],
                            "reasons":e["reasons"]} for e in entries}
    def persist():
        ordered = [results[e["case_id"]] for e in entries]
        save(out/"summary.json", {"aggregate":aggregate(ordered), "cases":ordered})
    persist()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(run_case, e, prepared[e["case_id"]], out/e["folder"],
                                   node, model, args.rounds, timeout):e
                   for e in entries if e["eligible"]}
        for future in as_completed(futures):
            entry = futures[future]
            try:
                results[entry["case_id"]] = future.result()
            except Exception as error:
                results[entry["case_id"]] = {"case_id":entry["case_id"],"eligible":True,
                                             "status":"execution_failed","error":str(error)}
            persist()
    audit = {"completed_at":datetime.now(timezone.utc).isoformat(),
             "original_artifacts_unchanged":all(Path(p).is_file() and sha(p)==h for p,h in watched.items()),
             "implementation_unchanged":all(sha(p)==h for p,h in {**implementation,**binary_hashes}.items()),
             "real_model_requests":len(list(out.glob("c*/llm_internal/*/request.json"))),
             "artifact_hashes":{str(f.relative_to(out)):sha(f) for f in out.rglob("*") if f.is_file()}}
    save(out/"audit.json", audit)
    if not audit["original_artifacts_unchanged"] or not audit["implementation_unchanged"]:
        raise ValueError("Baseline or implementation changed during study")
    print("COMPLETED", out, flush=True)


if __name__ == "__main__":
    main()

