#!/usr/bin/env python3
"""Spatial-density guided fixed-port internal relocation study."""
from __future__ import annotations
import argparse, base64, copy, hashlib, json, os, signal, shutil, subprocess, sys, time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/"engine/scripts"), str(ROOT/"experiments/llm_joint_search")]
import ifcn_density_search as spatial
import ifcn_joint_search as search
from ifcn_layout_optimization import choose_node
from ifcn_spatial_view import render_layout
from run_study import prepare_baseline

POLICIES = ("deterministic_density", "llm_text_density", "llm_vision_density")
MAX_MENU = 64
save = search.save


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def model_call(node, context, model, target, request_id, image=None):
    request = {"request_id": request_id, "context": context,
               "timeout_ms": 60000, "max_tokens": 2200}
    if model is not None:
        request["model"] = model
    if image is not None:
        raw = Path(image).read_bytes()
        request["layout_image"] = {"data_base64": base64.b64encode(raw).decode("ascii"),
                                   "mime_type": "image/png", "sha256": hashlib.sha256(raw).hexdigest()}
    save(target/"request.json", request)
    started = time.monotonic()
    with (target/"request.json").open() as inp, (target/"response.json").open("w") as out, (target/"model.log").open("w") as err:
        proc = subprocess.Popen([node, str(ROOT/"integrations/pi/layout-proposer.mjs")],
                                stdin=inp, stdout=out, stderr=err, start_new_session=True)
        try:
            code = proc.wait(timeout=64)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL); proc.wait()
            raise TimeoutError("real model request exceeded deadline; not retried")
    audit = json.loads((target/"response.json").read_text())
    if code or audit.get("status") != "ok":
        raise ValueError("model proposal failed: "+json.dumps(audit.get("error"), ensure_ascii=False))
    return audit, time.monotonic()-started


def prior_best(case_id, prepared, prior):
    best = (copy.deepcopy(prepared["metrics"]), copy.deepcopy(prepared["baseline"]),
            copy.deepcopy(prepared["clock"]), "original_baseline")
    if prior is None or not prior.exists():
        return best
    for summary_path in prior.glob("c*/summary.json"):
        try:
            summary = json.loads(summary_path.read_text())
        except (OSError, ValueError):
            continue
        if summary.get("case_id") != case_id:
            continue
        folder = summary_path.parent
        for policy, report in summary.get("policies", {}).items():
            number = report.get("selected_round")
            if not isinstance(number, int):
                continue
            target = folder/policy/f"{number:02d}"/"joint"
            result_path = target.parent/"result.json"
            if not all(path.is_file() for path in (target/"layout_candidate.json", target/"clock.json", result_path)):
                continue
            try:
                result = json.loads(result_path.read_text())
                candidate = json.loads((target/"layout_candidate.json").read_text())
                clock = json.loads((target/"clock.json").read_text())
            except (OSError, ValueError):
                continue
            metrics = result.get("metrics")
            if result.get("status") == "accepted" and candidate.get("routed") is True and isinstance(metrics, dict) and search.pareto(best[0], metrics):
                best = (copy.deepcopy(metrics), candidate, clock, str(target.relative_to(prior)))
    return best


def certified(result):
    return result.get("status") == "certified" and result.get("certificates", {}).get("logic") == "equivalent" and all(
        result.get("certificates", {}).get(k) is True for k in ("clock", "physical", "interface"))


def run_policy(folder, policy, prepared, node, model, rounds, timeout, batch_size):
    inputs = folder/"inputs"
    current, current_metrics, current_clock = copy.deepcopy(prepared["baseline"]), copy.deepcopy(prepared["metrics"]), copy.deepcopy(prepared["clock"])
    best, best_metrics, best_clock = copy.deepcopy(current), copy.deepcopy(current_metrics), copy.deepcopy(current_clock)
    root = folder/policy; root.mkdir()
    seen, history = set(), []
    accepted_round = None
    for round_number in range(1, rounds+1):
        target = root/f"{round_number:02d}"; target.mkdir()
        row = {"round": round_number, "status": "failed", "start_metrics": copy.deepcopy(current_metrics),
               "best_metrics_before": copy.deepcopy(best_metrics), "start_placement": search.key(current)}
        started = time.monotonic()
        try:
            density, pool = spatial.build_pool(current, excluded=seen)
            menu = pool[:MAX_MENU]
            if not menu:
                row.update(status="exhausted", error="no unused spatial seed")
                history.append(row); save(target/"result.json", row); break
            image_info = render_layout(current, density, target/"layout_density.png")
            save(target/"density.json", density)
            context = spatial.context_for(current, current_metrics, current_clock, history, density, menu, round_number, batch_size, best_metrics)
            save(target/"context.json", context)
            if policy == "deterministic_density":
                seed = menu[0]
                row["selection"] = {"source": "deterministic_first_seed", "candidate_id": seed["id"]}
            else:
                image = Path(image_info["path"]) if policy == "llm_vision_density" else None
                audit, latency = model_call(node, context, model, target, f"{folder.name}:{policy}:{round_number}", image)
                row.update(model=audit.get("model"), usage=audit.get("usage") or audit.get("tokens"), model_latency_s=latency)
                decision = audit.get("decision")
                if not isinstance(decision, dict):
                    decision = json.loads(audit["response"]["raw_text"])
                seed = next((entry for entry in menu if entry["id"] == decision.get("candidate_id")), None)
                if seed is None:
                    raise ValueError("model selected an ID outside the supplied spatial menu")
                row["selection"] = {"source": "llm_vision_spatial_seed" if image else "llm_text_spatial_seed",
                                    "candidate_id": seed["id"], "rationale": decision.get("rationale")}
            actions = spatial.neighborhood(current, seed, pool, seen, limit=batch_size)
            if not actions:
                raise ValueError("selected seed has no valid neighborhood")
            (target/"candidates").mkdir()
            row["seed_id"], row["candidate_count"], row["candidates"] = seed["id"], len(actions), []
            improved = []
            for index, action in enumerate(actions, 1):
                candidate_dir = target/"candidates"/f"{index:02d}"
                proposal = action["proposal"]
                if action["id"] in seen:
                    continue
                seen.add(action["id"])
                result = search.evaluate(current, proposal, candidate_dir, inputs/"source.v", inputs/"normalized.v",
                                         prepared["manifest"]["frontend"], prepared["manifest"]["configuration"], timeout, lock_io=True)
                item = {"candidate_id": action["id"], "seed_id": action["seed_id"], "origin": action["origin"],
                        "proposal": proposal, "result": result}
                if certified(result):
                    candidate = json.loads((candidate_dir/"layout_candidate.json").read_text())
                    item["candidate"] = candidate
                    if search.pareto(current_metrics, result["metrics"]):
                        improved.append((result["metrics"]["area_tiles"], result["metrics"]["qca_cells"], result, candidate,
                                         json.loads((candidate_dir/"clock.json").read_text()), action))
                row["candidates"].append(item)
            if improved:
                _, _, result, candidate, clock, action = min(improved, key=lambda item: item[:2])
                best, best_metrics, best_clock = copy.deepcopy(candidate), copy.deepcopy(result["metrics"]), copy.deepcopy(clock)
                current, current_metrics, current_clock = copy.deepcopy(best), copy.deepcopy(best_metrics), copy.deepcopy(best_clock)
                accepted_round = round_number
                row["status"] = "improved_retained"
                row["accepted_candidate_id"], row["accepted_origin"] = action["id"], action["origin"]
            else:
                row["status"] = "no_pareto_gain"
            row["retained_metrics"], row["retained_placement"] = copy.deepcopy(best_metrics), search.key(best)
            row["candidate_outcomes"] = Counter(item["result"].get("status") for item in row["candidates"])
        except Exception as error:
            row.update(status="failed", error=str(error))
        row["elapsed_s"] = time.monotonic()-started
        history.append(row); save(target/"result.json", row)
        print(folder.name, policy, round_number, row["status"], row.get("retained_metrics", {}).get("area_tiles"), row.get("retained_metrics", {}).get("qca_cells"), flush=True)
    record = {"initial": prepared["metrics"], "selected": best_metrics, "selected_round": accepted_round,
              "outcomes": dict(Counter(row["status"] for row in history)), "rounds": history,
              "real_model_requests": len(list(root.glob("*/request.json"))),
              "live_native_evaluations": len(list(root.glob("*/candidates/*/evaluation.log")))}
    save(root/"summary.json", record)
    return {key:value for key,value in record.items() if key != "rounds"}


def aggregate(rows):
    completed = [row for row in rows if row.get("status") == "completed"]
    result = {"cases": len(rows), "eligible_cases": sum(row.get("eligible", False) for row in rows),
              "completed_cases": len(completed), "policies": {}}
    for policy in POLICIES:
        reports = [row["policies"][policy] for row in completed]
        result["policies"][policy] = {
            "improved_cases": sum(search.pareto(report["initial"], report["selected"]) for report in reports),
            "mean_area_reduction_pct": sum((r["initial"]["area_tiles"]-r["selected"]["area_tiles"])/r["initial"]["area_tiles"]*100 for r in reports)/len(reports) if reports and len(completed)==result["eligible_cases"] else None,
            "mean_qca_reduction_pct": sum((r["initial"]["qca_cells"]-r["selected"]["qca_cells"])/r["initial"]["qca_cells"]*100 for r in reports)/len(reports) if reports and len(completed)==result["eligible_cases"] else None,
            "real_model_requests": sum(r["real_model_requests"] for r in reports),
            "live_native_evaluations": sum(r["live_native_evaluations"] for r in reports),
            "outcomes": dict(sum((Counter(r["outcomes"]) for r in reports), Counter())),
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cases", nargs="+")
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--prior", default=str(ROOT/"experiments/llm_joint_search/internal_nodes_v1_1_toy_maj_r2"))
    args = parser.parse_args()
    if not 1 <= args.rounds <= 8 or not 1 <= args.batch_size <= 6 or not 1 <= args.workers <= 2:
        parser.error("rounds 1..8, batch-size 1..6, workers 1..2")
    old = ROOT/"experiments/layout_llm_full"
    old_protocol = json.loads((old/"protocol.json").read_text())
    index = json.loads((old/"index.json").read_text())
    if index["protocol_sha256"] != sha(old/"protocol.json") or json.loads((old/"audit.json").read_text())["index_sha256"] != sha(old/"index.json"):
        raise ValueError("frozen corpus audit mismatch")
    known = {case["id"] for case in old_protocol["cases"]}
    if args.cases and (not set(args.cases) <= known or len(args.cases) != len(set(args.cases))):
        parser.error("--cases must be unique frozen case IDs")
    cases = [case for case in old_protocol["cases"] if args.cases is None or case["id"] in args.cases]
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=False)
    model = {"provider": old_protocol["model"]["provider"], "modelId": old_protocol["model"]["model_id"]}
    global node
    node = choose_node(ROOT/"engine")
    prior = Path(args.prior).resolve() if args.prior else None
    entries, prepared = [], {}
    watched = {str(old/name): sha(old/name) for name in ("protocol.json", "index.json", "audit.json")}
    for ordinal, case in enumerate(cases, 1):
        selection = index["selection"][case["id"]]
        entry = {"ordinal": ordinal, "case_id": case["id"], "status": "unavailable", "eligible": False, "reasons": selection["reasons"]}
        if selection["status"] == "selected":
            entry["folder"] = f"c{ordinal:02d}_{case['group']}_{Path(case['id']).stem}"
            folder = out/entry["folder"]; folder.mkdir()
            try:
                bundle = prepare_baseline(ROOT/"engine/output/pi-runs"/selection["run_id"], folder/"inputs")
                if sha(folder/"inputs/source.v") != case["source_sha256"] or sha(folder/"inputs/normalized.v") != case["normalized_sha256"]:
                    raise ValueError("source differs from frozen corpus")
                metrics, candidate, clock, source = prior_best(case["id"], bundle, prior)
                bundle["baseline"], bundle["metrics"], bundle["clock"] = candidate, metrics, clock
                prepared[case["id"]] = bundle
                entry.update(status="eligible", eligible=True, reasons=[], run_id=selection["run_id"], starting_state=source, initial=metrics)
                watched.update(bundle["source_artifacts"])
            except Exception as error:
                entry["reasons"] = [str(error)]
        entries.append(entry)
    files = [Path(__file__), Path(__file__).with_name("run_internal_study.py"), ROOT/"integrations/pi/layout-proposer.mjs",
             *sorted((ROOT/"engine/scripts").glob("*.py")), ROOT/"engine/src/app/ifcn_layout_edit.cpp", ROOT/"engine/include/autopr/graph/circuitGraph.cpp"]
    implementation = {str(file): sha(file) for file in files}
    for file in files:
        destination = out/"implementation"/file.relative_to(ROOT); destination.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(file, destination)
    binaries = {str(ROOT/"engine/build"/name): sha(ROOT/"engine/build"/name) for name in ("ifcn_layout_edit", "ifcn_energy_analysis", "ifcn_mapping_metrics")}
    save(out/"protocol.json", {"schema":"fcn.spatial_density_study.v1", "created_at":datetime.now(timezone.utc).isoformat(),
        "case_entries":entries, "rounds_per_policy":args.rounds, "batch_size":args.batch_size, "model":model,
        "policies":{"deterministic_density":"first spatial seed", "llm_text_density":"JSON density context", "llm_vision_density":"same context plus verified native-coordinate PNG"},
        "image_contract":"Image shows native XY nodes, routes, phase-colored sites and local gate/old-wire occupancy; sparsity is a search hint, never a DRC certificate.",
        "search_contract":"Model selects one spatial seed ID. Seed, single-member, reduced-displacement and alternate-order neighbors are separate native calls with explicit origin and no hidden retry.",
        "acceptance":"PI/PO XY fixed; source/DAG equivalence, original irregular-clock constraints, exact one-pass route order, physical QCA paths/ports and actual Pareto area/cell checks remain mandatory.",
        "prior_state_policy":"The best previously certified internal state is used when available, otherwise the registered baseline; source and normalized Verilog remain the frozen corpus inputs.",
        "original_artifact_hashes":watched, "implementation_hashes":implementation, "binary_hashes":binaries})
    results = {entry["case_id"]: {"case_id":entry["case_id"], "eligible":entry["eligible"], "status":"pending" if entry["eligible"] else entry["status"], "reasons":entry["reasons"]} for entry in entries}
    def persist(): save(out/"summary.json", {"aggregate":aggregate(list(results.values())), "cases":[results[e["case_id"]] for e in entries]})
    persist()
    def run(entry):
        reports={}
        for policy in POLICIES:
            reports[policy]=run_policy(out/entry["folder"], policy, prepared[entry["case_id"]], node, model, args.rounds, old_protocol["candidate_timeout_s"], args.batch_size)
        save(out/entry["folder"] / "summary.json", {"case_id": entry["case_id"], "eligible": True, "status": "completed", "policies": reports})
        return {"case_id":entry["case_id"], "eligible":True, "status":"completed", "policies":reports}
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures={executor.submit(run,entry):entry for entry in entries if entry["eligible"]}
        for future in as_completed(futures):
            entry=futures[future]
            try: results[entry["case_id"]]=future.result()
            except Exception as error: results[entry["case_id"]]={"case_id":entry["case_id"],"eligible":True,"status":"execution_failed","error":str(error)}
            persist()
    audit={"completed_at":datetime.now(timezone.utc).isoformat(),
           "original_artifacts_unchanged":all(Path(path).is_file() and sha(Path(path))==digest for path,digest in watched.items()),
           "implementation_unchanged":all(sha(Path(path))==digest for path,digest in {**implementation,**binaries}.items()),
           "real_model_requests":len(list(out.glob("c*/llm_*_density/*/request.json"))),
           "artifact_hashes":{str(file.relative_to(out)):sha(file) for file in out.rglob("*") if file.is_file()}}
    save(out/"audit.json", audit)
    if not audit["original_artifacts_unchanged"] or not audit["implementation_unchanged"]:
        raise ValueError("baseline or implementation changed")
    print("COMPLETED", out, flush=True)


if __name__ == "__main__":
    main()

