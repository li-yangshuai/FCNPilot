#!/usr/bin/env python3
"""Paired spatial-seed ablation; native trials and failed model slots stay visible.

This driver does not change proposals, neighborhoods, model clients or validators.
All candidates in a batch are evaluated from its frozen round-start incumbent.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import shutil
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "engine/scripts"), str(Path(__file__).parent)]
import run_density_study as base

spatial, search, save = base.spatial, base.search, base.save
POLICIES = ("deterministic_density", "deterministic_global_proxy", "random_density",
            "llm_text_no_feedback", "llm_text_feedback")


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def derived_seed(master, *parts):
    return int(fingerprint([master, *parts])[:16], 16)


def control_seed(policy, menu, rng):
    if policy == "deterministic_density":
        index = 0
    elif policy == "deterministic_global_proxy":
        def rank(item):
            features = item["features"]
            proxy = features["placement_proxy"]
            return proxy["manhattan_edges"], proxy["area_tiles"], features["changed_nodes"], item["id"]
        index = min(range(len(menu)), key=lambda i: rank(menu[i]))
    elif policy == "random_density":
        index = rng.randrange(len(menu))
    else:
        raise ValueError("Not a non-model seed policy: " + policy)
    return menu[index], {"source": policy, "menu_index": index, "menu_size": len(menu),
                         "candidate_id": menu[index]["id"]}


def ablated_context(context, policy):
    result = copy.deepcopy(context)
    if policy == "llm_text_no_feedback":
        result["feedback"] = []
    return result


def model_decision(audit):
    raw = {}
    try:
        raw = json.loads(audit.get("response", {}).get("raw_text", ""))
    except (TypeError, ValueError):
        pass
    decision = audit.get("decision")
    if not isinstance(decision, dict):
        decision = raw
    if not isinstance(decision, dict):
        raise ValueError("Missing model decision")
    proposal = audit.get("proposal") or {}
    rationale = decision.get("rationale") or (raw.get("rationale") if isinstance(raw, dict) else None) or proposal.get("rationale")
    return {**decision, "rationale": rationale}


def read_model_metadata(target):
    """Raw request/response files remain authoritative, including malformed output."""
    path = target / "response.json"
    if not path.exists():
        return {"response_available": False}
    try:
        audit = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        return {"response_available": True, "response_parse_error": str(error)}
    return {"response_available": True, "status": audit.get("status"),
            "model": audit.get("model"), "sdk_version": audit.get("sdk_version"),
            "usage": audit.get("usage") or audit.get("tokens"),
            "latency_ms": audit.get("latency_ms"), "error": audit.get("error"),
            "parameters": audit.get("request", {}).get("parameters") or audit.get("request_parameters")}


def run_policy(folder, policy, prepared, inputs, node, model, *, rounds, timeout,
               batch_size, selection_seed, on_progress=None, stop_event=None):
    """One independent arm. All evaluator calls and all unspent slots are recorded."""
    if policy not in POLICIES:
        raise ValueError("Unknown policy: " + policy)
    root = folder / policy
    root.mkdir(exist_ok=False)
    current, metrics, clock = (copy.deepcopy(prepared[k]) for k in ("baseline", "metrics", "clock"))
    initial = copy.deepcopy(metrics)
    save(root / "initial_layout.json", current)
    rng = random.Random(selection_seed)
    history, trace, seen = [], [], set()
    model_attempts = successful_decisions = evaluations = native_reports = 0
    accepted_round = first_improvement = first_retained = None
    interrupted = False
    started = time.monotonic()

    def summary(completed):
        return {"policy": policy, "status": "completed" if completed else ("interrupted" if interrupted else "running"),
                "initial": initial, "selected": copy.deepcopy(metrics),
                "initial_layout_fingerprint": fingerprint(prepared["baseline"]),
                "selection_seed": selection_seed, "selected_round": accepted_round,
                "completed_rounds": len(history), "allocated_rounds": rounds,
                "allocated_native_slots": rounds * batch_size,
                "model_request_attempts": model_attempts,
                "successful_model_decisions": successful_decisions,
                "candidate_evaluation_attempts": evaluations,
                "native_launch_logs": native_reports,
                "unused_candidate_slots": rounds * batch_size - evaluations,
                "full_candidate_budget": evaluations == rounds * batch_size,
                "first_discovered_improvement": first_improvement,
                "first_retained_improvement": first_retained,
                "outcomes": dict(Counter(row["status"] for row in history)),
                "candidate_outcomes": dict(Counter(item["result"].get("status", "unknown")
                                                   for row in history for item in row.get("candidates", []))),
                "elapsed_s": time.monotonic() - started}

    save(root / "summary.json", summary(False))
    if on_progress:
        on_progress(summary(False))
    for number in range(1, rounds + 1):
        if stop_event is not None and stop_event.is_set():
            interrupted = True
            break
        target = root / f"{number:02d}"
        target.mkdir()
        row = {"round": number, "status": "failed", "allocated_native_slots": batch_size,
               "start_metrics": copy.deepcopy(metrics), "best_metrics_before": copy.deepcopy(metrics),
               "start_placement": search.key(current), "candidates": []}
        round_start = time.monotonic()
        winner = None
        prefix_metrics = copy.deepcopy(metrics)
        slot_reason = "round_failed"
        used_slots = 0

        def append_slot(slot, status, *, reason=None, native_ordinal=None, evaluation_ordinal=None,
                        candidate_id=None, origin=None):
            nonlocal first_improvement
            point = {"round": number, "slot_in_round": slot,
                     "allocated_ordinal": (number - 1) * batch_size + slot,
                     "native_ordinal": native_ordinal, "evaluation_ordinal": evaluation_ordinal,
                     "status": status, "reason": reason, "candidate_id": candidate_id, "origin": origin,
                     "best_retained_after_call": copy.deepcopy(prefix_metrics),
                     "elapsed_s": time.monotonic() - started}
            trace.append(point)
            if first_improvement is None and search.pareto(initial, prefix_metrics):
                first_improvement = {k: point[k] for k in
                                     ("round", "allocated_ordinal", "native_ordinal", "evaluation_ordinal", "elapsed_s")}
            save(root / "anytime.json", {"initial": initial, "points": trace})

        try:
            density, pool = spatial.build_pool(current, excluded=seen)
            menu = pool[:base.MAX_MENU]
            row["menu_size"] = len(menu)
            row["menu_fingerprint"] = fingerprint(menu)
            save(target / "density.json", density)
            save(target / "menu.json", menu)
            if not menu:
                row["status"], slot_reason = "exhausted", "no_unused_seed"
            else:
                context = spatial.context_for(current, metrics, clock, history, density, menu,
                                              number, batch_size, metrics)
                context = ablated_context(context, policy)
                save(target / "context.json", context)
                row["context_fingerprint"] = fingerprint(context)
                if stop_event is not None and stop_event.is_set():
                    slot_reason = "interrupted"
                    raise InterruptedError("Study interrupted before seed selection")
                if policy.startswith("llm_"):
                    model_attempts += 1
                    model_start = time.monotonic()
                    try:
                        audit, latency = base.model_call(node, context, model, target,
                                                       f"{folder.parent.name}:{folder.name}:{policy}:{number}")
                        row["model_latency_s"] = latency
                        row["usage"] = audit.get("usage") or audit.get("tokens")
                        decision = model_decision(audit)
                        seed = next((item for item in menu if item["id"] == decision.get("candidate_id")), None)
                        if seed is None:
                            raise ValueError("Model selected an ID outside the supplied menu")
                        successful_decisions += 1
                        row["selection"] = {"source": policy, "candidate_id": seed["id"],
                                            "menu_size": len(menu), "rationale": decision.get("rationale")}
                    except Exception:
                        slot_reason = "model_error_or_invalid_selection"
                        raise
                    finally:
                        row["model_wall_s"] = time.monotonic() - model_start
                        row["model_audit"] = read_model_metadata(target)
                else:
                    seed, row["selection"] = control_seed(policy, menu, rng)
                    row["selection"]["selection_seed"] = selection_seed
                actions = spatial.neighborhood(current, seed, pool, seen, limit=batch_size)
                if len(actions) > batch_size:
                    raise ValueError("Neighborhood exceeds the shared native budget")
                row["seed_id"], row["candidate_count"] = seed["id"], len(actions)
                (target / "candidates").mkdir()
                for slot, action in enumerate(actions, 1):
                    if stop_event is not None and stop_event.is_set():
                        slot_reason = "interrupted"
                        raise InterruptedError("Study interrupted before the next native candidate")
                    used_slots = slot
                    if action["id"] in seen:
                        append_slot(slot, "not_evaluated", reason="duplicate_candidate")
                        continue
                    seen.add(action["id"])
                    candidate_dir = target / "candidates" / f"{slot:02d}"
                    evaluations += 1
                    call_start = time.monotonic()
                    try:
                        result = search.evaluate(current, action["proposal"], candidate_dir,
                                                 inputs / "source.v", inputs / "normalized.v",
                                                 prepared["manifest"]["frontend"],
                                                 prepared["manifest"]["configuration"], timeout, lock_io=True)
                    except Exception as error:
                        result = {"status": "failed", "error": str(error), "driver_exception": True}
                        candidate_dir.mkdir(exist_ok=True)
                        save(candidate_dir / "driver_failure.json", result)
                    executed = (candidate_dir / "native.log").is_file()
                    if executed:
                        native_reports += 1
                    item = {"candidate_id": action["id"], "seed_id": action["seed_id"],
                            "origin": action["origin"], "proposal": action["proposal"], "result": result,
                            "evaluation_ordinal": evaluations,
                            "native_ordinal": native_reports if executed else None,
                            "elapsed_s": time.monotonic() - call_start,
                            "launch_evidence": {name: (candidate_dir / name).is_file() for name in ("evaluation.log", "native.log")}}
                    row["candidates"].append(item)
                    # Preserve the old batch selector: Pareto against the frozen round start,
                    # then lexicographically minimize (area,cells), keeping the first tie.
                    try:
                        if base.certified(result) and search.pareto(metrics, result["metrics"]):
                            rank = (result["metrics"]["area_tiles"], result["metrics"]["qca_cells"])
                            if winner is None or rank < winner[0]:
                                candidate = json.loads((candidate_dir / "layout_candidate.json").read_text())
                                candidate_clock = json.loads((candidate_dir / "clock.json").read_text())
                                winner = (rank, candidate, copy.deepcopy(result["metrics"]), candidate_clock, action)
                                prefix_metrics = copy.deepcopy(result["metrics"])
                    except (OSError, ValueError, KeyError) as error:
                        result = {"status": "failed", "error": "Missing/malformed retained artifact: " + str(error),
                                  "evaluator_result": result}
                        item["result"] = result
                    item["best_retained_after_call"] = copy.deepcopy(prefix_metrics)
                    append_slot(slot, result.get("status", "unknown"), native_ordinal=item["native_ordinal"],
                                evaluation_ordinal=evaluations, candidate_id=action["id"], origin=action["origin"])
                    save(target / "result.json", row)
                row["status"] = "improved_retained" if winner else "no_pareto_gain"
                slot_reason = "neighborhood_shorter_than_budget"
        except Exception as error:
            if isinstance(error, InterruptedError):
                interrupted = True
            row.update(status="interrupted" if interrupted else "failed", error=str(error))
        # An evaluator failure never erases a previously certified prefix candidate.
        if winner is not None:
            _, current, metrics, clock, action = winner
            accepted_round = number
            if first_retained is None and search.pareto(initial, metrics):
                first_retained = {"round": number, "native_ordinal_at_batch_end": native_reports,
                                  "evaluation_ordinal_at_batch_end": evaluations,
                                  "allocated_ordinal_at_batch_end": number * batch_size,
                                  "batch_status": row["status"], "elapsed_s": time.monotonic() - started}
            row["accepted_candidate_id"], row["accepted_origin"] = action["id"], action["origin"]
        for slot in range(used_slots + 1, batch_size + 1):
            append_slot(slot, "not_evaluated", reason=slot_reason)
        row["retained_metrics"], row["retained_placement"] = copy.deepcopy(metrics), search.key(current)
        row["elapsed_s"] = time.monotonic() - round_start
        row["candidate_outcomes"] = dict(Counter(item["result"].get("status", "unknown") for item in row["candidates"]))
        history.append(row)
        save(target / "result.json", row)
        save(root / "summary.json", summary(False))
        if on_progress:
            on_progress(summary(False))
        print(folder.parent.name, folder.name, policy, number, row["status"], metrics["qca_cells"], flush=True)
    record = summary(not interrupted and len(history) == rounds)
    save(root / "summary.json", {**record, "rounds": history})
    if on_progress:
        on_progress(record)
    return record


def checked_prior(prior):
    if prior is None:
        return {}
    audit_path = prior / "audit.json"
    audit = json.loads(audit_path.read_text())
    if not audit.get("original_artifacts_unchanged") or not audit.get("implementation_unchanged"):
        raise ValueError("Prior archive did not pass its preservation audit")
    watched = {str(audit_path): base.sha(audit_path)}
    for relative, expected in audit["artifact_hashes"].items():
        file = (prior / relative).resolve()
        if not file.is_relative_to(prior.resolve()) or not file.is_file() or base.sha(file) != expected:
            raise ValueError("Prior archive hash mismatch: " + relative)
        watched[str(file)] = expected
    return watched


def prepare_cases(out, old_protocol, index, requested, prior):
    """Read-only preflight of the entire registry, even for a selected-case pilot."""
    entries, prepared, watched = [], {}, {}
    for ordinal, case in enumerate(old_protocol["cases"], 1):
        selection = index["selection"][case["id"]]
        entry = {"ordinal": ordinal, "case_id": case["id"], "requested": case["id"] in requested,
                 "eligible": False, "registry_status": selection["status"], "status": "unavailable",
                 "reasons": selection.get("reasons", [])}
        if selection["status"] == "selected":
            entry["folder"] = f"c{ordinal:02d}_{case['group']}_{Path(case['id']).stem}"
            folder = out / entry["folder"]
            folder.mkdir()
            try:
                bundle = base.prepare_baseline(ROOT / "engine/output/pi-runs" / selection["run_id"], folder / "inputs")
                for file, key in [("source.v", "source_sha256"), ("normalized.v", "normalized_sha256")]:
                    if base.sha(folder / "inputs" / file) != case[key]:
                        raise ValueError("Source differs from frozen registry: " + file)
                metrics, candidate, clock, source = base.prior_best(case["id"], bundle, prior)
                original = bundle["baseline"]
                roles = lambda g: sorted((n["id"], n["name"], n["type"], n["is_input"], n["is_output"]) for n in g["nodes"])
                ports = lambda g: sorted((n["id"], n["x"], n["y"]) for n in g["nodes"] if n["is_input"] or n["is_output"])
                if (roles(candidate) != roles(original) or ports(candidate) != ports(original)
                        or sorted(candidate["edges"]) != sorted(original["edges"])
                        or candidate["algorithm"] != original["algorithm"]):
                    raise ValueError("Prior state changed the fixed source/DAG, I/O or native algorithm")
                if source != "original_baseline":
                    prior_inputs = prior / Path(source).parts[0] / "inputs"
                    for file in ("source.v", "normalized.v"):
                        if base.sha(prior_inputs / file) != base.sha(folder / "inputs" / file):
                            raise ValueError("Prior source identity mismatch")
                    evidence = folder / "starting_evidence"
                    evidence.mkdir()
                    for name in ("layout_candidate.json", "clock.json", "logic.json", "physical.json",
                                 "interface.json", "routed_dag.json", "layout.ifcn", "device_energy_input.qca", "result.json"):
                        src = prior / source / name
                        if src.is_file():
                            shutil.copy2(src, evidence / name)
                bundle.update(baseline=candidate, metrics=metrics, clock=clock)
                save(folder / "starting_layout.json", candidate)
                save(folder / "starting_clock.json", clock)
                save(folder / "starting_metrics.json", metrics)
                prepared[case["id"]] = bundle
                watched.update(bundle["source_artifacts"])
                entry.update(eligible=True, status="pending" if entry["requested"] else "not_selected",
                             reasons=[], run_id=selection["run_id"], starting_state=source, initial=metrics,
                             starting_layout_fingerprint=fingerprint(candidate), backend=candidate["algorithm"])
            except Exception as error:
                entry.update(status="preflight_failed", reasons=[str(error)])
        entries.append(entry)
    return entries, prepared, watched


def aggregate(entries, blocks, policies, repeats, rounds, batch_size):
    eligible = [entry for entry in entries if entry["requested"] and entry["eligible"]]
    allocated = len(eligible) * repeats
    result = {"registered_cases": len(entries), "requested_cases": sum(e["requested"] for e in entries),
              "preflight_eligible_cases": sum(e["eligible"] for e in entries),
              "requested_eligible_cases": len(eligible), "allocated_case_rep_blocks": allocated,
              "registry_statuses": dict(Counter(e["status"] for e in entries)), "policies": {}}
    for policy in policies:
        arms = [(b["case_id"], b.get("policies", {}).get(policy)) for b in blocks]
        known = [(case, arm) for case, arm in arms if arm and arm.get("status") == "completed" and arm.get("selected")]
        complete = len(known) == allocated
        def reduction(arm, key):
            return 100 * (arm["initial"][key] - arm["selected"][key]) / arm["initial"][key]
        report = {"allocated_case_rep_blocks": allocated, "reported_final_blocks": len(known),
                  "missing_final_blocks": allocated - len(known),
                  "allocated_rounds": allocated * rounds, "allocated_native_slots": allocated * rounds * batch_size,
                  "requested_registry_round_slots": sum(e["requested"] for e in entries) * repeats * rounds,
                  "improved_case_rep_blocks": sum(search.pareto(a["initial"], a["selected"]) for _, a in known),
                  "improved_unique_cases": len({case for case, a in known if search.pareto(a["initial"], a["selected"])})}
        for key in ("model_request_attempts", "successful_model_decisions", "candidate_evaluation_attempts", "native_launch_logs"):
            report[key] = sum((arm or {}).get(key, 0) for _, arm in arms)
        report["counts_may_be_incomplete"] = not complete
        report["unused_candidate_slots"] = report["allocated_native_slots"] - report["candidate_evaluation_attempts"]
        for metric, label in [("area_tiles", "area"), ("qca_cells", "qca")]:
            report["mean_" + label + "_reduction_pct"] = sum(reduction(a, metric) for _, a in known) / allocated if complete and allocated else None
            total = sum(a["initial"][metric] for _, a in known)
            saved = sum(a["initial"][metric] - a["selected"][metric] for _, a in known)
            report["total_" + label + "_saved"] = saved if complete else None
            report["pooled_" + label + "_reduction_pct"] = 100 * saved / total if complete and total else None
        result["policies"][policy] = report
    return result


def create_output(path):
    path = Path(path).resolve()
    path.mkdir(parents=True, exist_ok=False)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cases", nargs="+")
    parser.add_argument("--policies", nargs="+", choices=POLICIES, default=list(POLICIES))
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260909)
    parser.add_argument("--prior", default=str(ROOT / "experiments/llm_joint_search/internal_nodes_v1_1_toy_maj_r2"),
                        help="Audited shared prior; use an empty string for the registered baseline")
    args = parser.parse_args(argv)
    if not (1 <= args.repeats <= 30 and 1 <= args.rounds <= 8 and 1 <= args.batch_size <= 6 and 1 <= args.workers <= 2):
        parser.error("repeats 1..30, rounds 1..8, batch-size 1..6, workers 1..2")
    if len(set(args.policies)) != len(args.policies):
        parser.error("policies must be unique")
    old = ROOT / "experiments/layout_llm_full"
    protocol, index = (json.loads((old / f).read_text()) for f in ("protocol.json", "index.json"))
    if index["protocol_sha256"] != base.sha(old / "protocol.json") or json.loads((old / "audit.json").read_text())["index_sha256"] != base.sha(old / "index.json"):
        raise ValueError("Frozen corpus audit mismatch")
    known = {case["id"] for case in protocol["cases"]}
    requested = set(args.cases or known)
    if not requested <= known or (args.cases and len(requested) != len(args.cases)):
        parser.error("cases must be unique frozen registry IDs")
    out = create_output(args.output)
    prior = Path(args.prior).resolve() if args.prior else None
    watched = {str(old / name): base.sha(old / name) for name in ("protocol.json", "index.json", "audit.json")}
    watched.update(checked_prior(prior))
    entries, prepared, baseline_hashes = prepare_cases(out, protocol, index, requested, prior)
    watched.update(baseline_hashes)
    files = [Path(__file__), Path(__file__).with_name("run_density_study.py"), Path(__file__).with_name("run_study.py"),
             ROOT / "integrations/pi/layout-proposer.mjs", *sorted((ROOT / "engine/scripts").glob("*.py")),
             ROOT / "engine/src/app/ifcn_layout_edit.cpp", ROOT / "engine/include/autopr/graph/circuitGraph.cpp"]
    implementation = {str(file): base.sha(file) for file in files}
    for file in files:
        dest = out / "implementation" / file.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, dest)
    binaries = {str(ROOT / "engine/build" / name): base.sha(ROOT / "engine/build" / name)
                for name in ("ifcn_layout_edit", "ifcn_energy_analysis", "ifcn_mapping_metrics")}
    model = {"provider": protocol["model"]["provider"], "modelId": protocol["model"]["model_id"]}
    plans = []
    for entry in entries:
        if not entry["requested"] or not entry["eligible"]:
            continue
        for rep in range(1, args.repeats + 1):
            order_seed = derived_seed(args.seed, entry["case_id"], rep, "policy_order")
            order = list(args.policies)
            random.Random(order_seed).shuffle(order)
            plans.append({"case_id": entry["case_id"], "rep": rep, "policy_order_seed": order_seed,
                          "policy_order": order, "selection_seeds": {p: derived_seed(args.seed, entry["case_id"], rep, p) for p in order}})
    save(out / "protocol.json", {"schema": "fcn.density_ablation.v1", "created_at": datetime.now(timezone.utc).isoformat(),
         "arguments": vars(args), "case_entries": entries, "blocks": plans, "model": model,
         "model_parameters": {"max_tokens": 2200, "timeout_ms": 60000, "max_retries": 0, "cache_retention": "none",
                              "temperature": "unspecified", "top_p": "unspecified", "sampling_seed": "not_exposed"},
         "candidate_timeout_s": protocol["candidate_timeout_s"], "max_menu": base.MAX_MENU,
         "policy_definitions": {"deterministic_density": "First spatially diversified ranked menu entry",
             "deterministic_global_proxy": "Global minimum (Manhattan edges, proxy area, changed nodes, ID) over the same menu",
             "random_density": "Uniform random.Random.randrange(menu size); per-arm seed and chosen indices recorded",
             "llm_text_no_feedback": "Omit explicit trial feedback only: replace feedback with []. Current state, metrics and deduplication still encode search history.",
             "llm_text_feedback": "Shared text context including projected previous candidate feedback"},
         "pairing": "Every case/repetition/policy starts from the same archived state; identical pool, neighborhood, batch and validator code. Later menus depend on each arm's retained state and deduplication history.",
         "acceptance": "All certificates pass; Pareto relative to frozen round-start incumbent; choose minimum (area,cells) in each batch. No exploratory regression between rounds.",
         "anytime": "One record per allocated slot; evaluation_ordinal counts candidate-evaluator invocations and is the budget axis, including pre-launch failures. native_ordinal counts observed native.log files as launch-attempt evidence only, not successful execution; launch_evidence preserves both backend and native log presence. best_retained_after_call is the unchanged batch selector applied to the observed prefix. Within-batch incomparable candidates may trade area against cells; round endpoints remain Pareto-monotone.",
         "failure_policy": "No fallback or retry. Model/invalid-selection/exhausted slots remain allocated and retain the incumbent. Means include all allocated eligible case-repetition blocks, including zero-native model failures; unresolved execution failures yield null full-cohort means.",
         "replication": "The two LLM arms make independent requests even when their first-round contexts match; uncontrolled sampling prevents a pure causal paired-response interpretation. One repeat is descriptive only. Repeats do not imply independent functions, random native routing, or controlled model temperature. Same native ceilings do not imply equal wall time/token cost.",
         "prior_state_policy": "Choose the same previously certified internal prior once per case, or the registered baseline; all 30 registry cases undergo read-only preflight.",
         "original_artifact_hashes": watched, "implementation_hashes": implementation, "binary_hashes": binaries})
    progress_lock, stop_event = threading.Lock(), threading.Event()
    blocks = {(p["case_id"], p["rep"]): {**p, "status": "pending", "policies": {}} for p in plans}
    def persist():
        save(out / "summary.json", {"aggregate": aggregate(entries, list(blocks.values()), args.policies, args.repeats, args.rounds, args.batch_size),
             "cases": [{**e, "repetitions": [blocks[(e["case_id"], r)] for r in range(1, args.repeats + 1) if (e["case_id"], r) in blocks]} for e in entries]})
    persist()
    node = base.choose_node(ROOT / "engine") if any(p.startswith("llm_") for p in args.policies) and plans else None
    by_id = {e["case_id"]: e for e in entries}
    def run(plan):
        entry = by_id[plan["case_id"]]
        folder = out / entry["folder"] / f"rep_{plan['rep']:02d}"
        folder.mkdir()
        report = {**plan, "status": "completed", "policies": {}}
        for policy in plan["policy_order"]:
            if stop_event.is_set():
                report["status"] = "interrupted"
                break
            def progress(arm, policy=policy):
                with progress_lock:
                    partial = blocks[(plan["case_id"], plan["rep"])]
                    partial["status"] = "running"
                    partial["policies"][policy] = copy.deepcopy(arm)
                    persist()
            try:
                arm = run_policy(folder, policy, prepared[entry["case_id"]], out / entry["folder"] / "inputs", node, model,
                                 rounds=args.rounds, timeout=protocol["candidate_timeout_s"], batch_size=args.batch_size,
                                 selection_seed=plan["selection_seeds"][policy], on_progress=progress, stop_event=stop_event)
            except Exception as error:
                arm = {"status": "execution_failed", "error": str(error), "initial": entry["initial"], "selected": None}
                report["status"] = "execution_failed"
            report["policies"][policy] = arm
            if arm.get("status") == "interrupted":
                report["status"] = "interrupted"
            save(folder / "summary.json", report)
        return report
    executor = ThreadPoolExecutor(max_workers=args.workers)
    futures = {}
    try:
        futures = {executor.submit(run, plan): plan for plan in plans}
        for future in as_completed(futures):
            plan = futures[future]
            try:
                result = future.result()
            except Exception as error:
                result = {**plan, "status": "execution_failed", "error": str(error), "policies": {}}
            with progress_lock:
                blocks[(plan["case_id"], plan["rep"])] = result
                persist()
    except KeyboardInterrupt:
        stop_event.set()
        for future in futures:
            future.cancel()
        print("INTERRUPTING: finish the current bounded call, preserve partial records, launch no new work", flush=True)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
        if stop_event.is_set():
            with progress_lock:
                for future, plan in futures.items():
                    if future.done() and not future.cancelled():
                        try:
                            blocks[(plan["case_id"], plan["rep"])] = future.result()
                        except Exception as error:
                            blocks[(plan["case_id"], plan["rep"])]["error"] = str(error)
                    elif future.cancelled():
                        blocks[(plan["case_id"], plan["rep"])]["status"] = "not_started_interrupted"
                persist()
    unchanged = lambda hashes: all(Path(p).is_file() and base.sha(p) == digest for p, digest in hashes.items())
    audit = {"completed_at": datetime.now(timezone.utc).isoformat(), "interrupted": stop_event.is_set(), "original_artifacts_unchanged": unchanged(watched),
             "implementation_unchanged": unchanged({**implementation, **binaries}),
             "artifact_hashes": {str(f.relative_to(out)): base.sha(f) for f in out.rglob("*") if f.is_file()}}
    save(out / "audit.json", audit)
    if not audit["original_artifacts_unchanged"] or not audit["implementation_unchanged"]:
        raise ValueError("Source, prior, implementation or binary changed during the study")
    print("INTERRUPTED" if stop_event.is_set() else "COMPLETED", out, flush=True)
    return 130 if stop_event.is_set() else 0


if __name__ == "__main__":
    sys.exit(main())