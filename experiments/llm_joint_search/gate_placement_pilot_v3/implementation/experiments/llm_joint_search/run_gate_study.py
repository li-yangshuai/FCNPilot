#!/usr/bin/env python3
"""Direct Pi-LLM gate placement/routing with device-level certification feedback.

Every policy gets one proposal slot and at most one native evaluation per round.
Invalid proposals consume a slot. Only a fully certified state may be explored;
the separately retained result can improve, but can never regress.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "engine/scripts"), str(Path(__file__).parent)]
import ifcn_density_search as density_search
import ifcn_gate_search as gate
import ifcn_joint_search as search
from ifcn_axis_compaction import cut_proposals, placement_metrics
from ifcn_layout_optimization import choose_node, node_delta
from ifcn_spatial_density import density_context
from ifcn_spatial_view import render_layout
from run_study import prepare_baseline

save = search.save
POLICIES = ("deterministic_gate", "llm_gate_placement", "llm_gate_direct")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resolve_model(node, requested):
    script = ("import {resolveConfiguredModel} from " + json.dumps((ROOT / "integrations/pi/layout-proposer.mjs").as_uri()) + ";"
              "resolveConfiguredModel(JSON.parse(process.argv[1])).then(m=>process.stdout.write(JSON.stringify(m)))"
              ".catch(()=>{process.stderr.write('Pi model selection could not be resolved');process.exitCode=1});")
    result = subprocess.run([node, "--input-type=module", "-e", script, json.dumps(requested)], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError("Existing Pi model selection is unavailable; no substitute model was chosen")
    return json.loads(result.stdout)


def action_key(candidate, proposal):
    data = [gate.state_key(candidate), search.key(search.apply_positions(candidate, proposal["operations"])), proposal["routing_order"]]
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def validate_action(candidate, proposal, lock_io):
    search.validate_proposal(proposal, candidate, lock_io=lock_io)
    # Exclude port-only compaction and pure routing: this study investigates
    # relocation of internal gates, even when port coordinates are released.
    internal = {n["id"] for n in candidate["nodes"] if not n["is_input"] and not n["is_output"]}
    changed = {n["node_id"] for n in node_delta(candidate, search.apply_positions(candidate, proposal["operations"]))}
    if not changed & internal:
        raise ValueError("At least one internal gate must move; port-only and routing-only actions are outside this study")
    return proposal


def control_pool(candidate, seen, lock_io):
    _, entries = density_search.build_pool(candidate)
    proposals = [density_search.proposal_from_entry(entry) for entry in entries]
    if not lock_io:
        for item in cut_proposals(candidate, max_operations=8, max_shift=4):
            placed = search.apply_positions(candidate, item["operations"])
            proposals.append({"schema": "ifcn.layout_search.v2", "operations": item["operations"],
                              "routing_order": search.control_order(placed), "rationale": item["rationale"][:1200]})
    result, identities = [], set()
    for proposal in proposals:
        try:
            validate_action(candidate, proposal, lock_io)
        except ValueError:
            continue
        identity = action_key(candidate, proposal)
        if identity in seen or identity in identities:
            continue
        identities.add(identity)
        result.append({"id": identity, "proposal": proposal,
                       "proxy": placement_metrics(search.apply_positions(candidate, proposal["operations"]))})
    return sorted(result, key=lambda item: (item["proxy"]["area_tiles"],
                                            item["proxy"]["manhattan_edges"], item["id"]))


def model_call(context, node, model, target, request_id, vision, model_timeout):
    request = {"request_id": request_id, "context": context, "timeout_ms": model_timeout * 1000, "max_tokens": 4096}
    if model is not None:
        request["model"] = model
    if vision:
        import base64
        raw = (target / "gate_layout.png").read_bytes()
        request["layout_image"] = {"data_base64": base64.b64encode(raw).decode("ascii"),
                                   "mime_type": "image/png", "sha256": hashlib.sha256(raw).hexdigest()}
    save(target / "request.json", request)
    with (target / "request.json").open() as inp, (target / "response.json").open("w") as out, (target / "model.log").open("w") as err:
        process = subprocess.Popen([node, str(ROOT / "integrations/pi/layout-proposer.mjs")],
                                   stdin=inp, stdout=out, stderr=err, start_new_session=True)
        try:
            process.wait(timeout=model_timeout + 4)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise TimeoutError("Pi model request timed out; this round has no hidden retry")
    audit = json.loads((target / "response.json").read_text())
    if process.returncode or audit.get("status") != "ok":
        raise ValueError("Pi model proposal failed: " + json.dumps(audit.get("error")))
    return audit


def is_certified(row):
    return (row.get("status") == "certified" and row.get("certificates", {}).get("logic") == "equivalent"
            and all(row.get("certificates", {}).get(k) is True for k in ("clock", "physical", "interface")))


def run_policy(folder, policy, prepared, args, node, model):
    target_root = folder / policy
    target_root.mkdir()
    inputs = folder / "inputs"
    initial = copy.deepcopy(prepared["baseline"])
    current, metrics, clock = initial, copy.deepcopy(prepared["metrics"]), copy.deepcopy(prepared["clock"])
    best, best_metrics, best_clock = copy.deepcopy(current), copy.deepcopy(metrics), copy.deepcopy(clock)
    best_path = inputs
    history, seen, expanded = [], set(), set()
    selected_round = None
    requests = successes = native_calls = diagnostic_calls = 0
    consecutive_provider_failures = 0
    lock_io = args.port_policy == "fixed"
    for number in range(1, args.rounds + 1):
        target = target_root / f"{number:02d}"
        target.mkdir()
        started = time.monotonic()
        row = {"round": number, "status": "failed", "start_metrics": copy.deepcopy(metrics),
               "best_metrics_before": copy.deepcopy(best_metrics), "start_state": gate.state_key(current)}
        expanded.add(gate.state_key(current))
        try:
            proposals = control_pool(current, seen, lock_io)
            context = gate.gate_context(current, metrics, clock, history, best_metrics, lock_io=lock_io)
            context["rules"]["require_internal_relocation"] = True
            context["rules"]["proposal_contract"] = (
                "Directly choose internal-gate XY moves or swaps and the complete routing order. "
                "At least one internal gate must move. There is no candidate-ID menu. "
                "You may coordinate internal and port moves only when port_coordinates_movable=true. "
                "One exact proposal is executed per round; failed moves return diagnostics for the next round.")
            context["state_features"]["reference_routing_order"] = search.control_order(current)
            context["state_features"]["area_controlling_nodes"] = {
                label: [{"id": n["id"], "xy": [n["x"], n["y"]], "is_port": n["is_input"] or n["is_output"]}
                        for n in current["nodes"] if n[axis] == reducer(node[axis] for node in current["nodes"])]
                for label, axis, reducer in (("left", "x", min), ("right", "x", max), ("bottom", "y", min), ("top", "y", max))}
            if policy == "llm_gate_placement":
                context["action_space"]["routing_order_owner"] = "deterministic_executor"
                context["rules"]["require_explicit_routing_order"] = False
                context["rules"]["proposal_contract"] = "Model synthesizes internal gate coordinates; routing_order=null; executor derives the disclosed deterministic order after placement."
                context["rules"]["search_contract"] = "Return a direct gate proposal with routing_order=null; the compiler derives and logs one order using exactly the same rule as the deterministic control. All area/device, exploration, graph identity, clock and physical constraints remain enforced."
                context["rules"]["routing_execution"] = "One executor-derived complete order after moves; no portfolio fallback."
            if args.guidance == "geometry":
                context["state_features"]["unevaluated_gate_geometry_hints"] = [
                    {"operations": p["proposal"]["operations"], "placement_proxy": p["proxy"],
                     "rationale": p["proposal"]["rationale"],
                     "scope": "Geometry only, shared with deterministic policy; not routed, not a QCA score, not a menu restriction."}
                    for p in proposals[:12]]
                context["rules"]["geometry_guidance"] = (
                    "Inspect the shared gate-geometry hints as possible starting moves. You may combine or adapt them, "
                    "or propose new coordinates. Do not repeat a failed geometry merely by swapping the edge list. "
                    "Use a smaller displacement or a different node subset when routing fails. "
                    "If moving ports is permitted and they set the outer box, coordinate their relocation with internal gates. "
                    "Swapping unrelated distant nodes often creates detours; give it a concrete geometric justification.")
            save(target / "context.json", context)
            render_layout(current, density_context(current), target / "gate_layout.png")
            if policy.startswith("llm_"):
                requests += 1
                audit = model_call(context, node, model, target, f"{folder.parent.name}:{folder.name}:{number}", args.vision, args.model_timeout)
                successes += 1
                consecutive_provider_failures = 0
                row.update(model=audit.get("model"), usage=audit.get("usage"), proposal_origin="direct_llm_gate_action")
                proposal = audit["proposal"]
                row["model_proposal"] = copy.deepcopy(proposal)
                if policy == "llm_gate_placement":
                    if proposal["routing_order"] is not None:
                        raise ValueError("Placement-only model policy requires null routing order")
                    proposal = {**proposal, "routing_order": search.control_order(search.apply_positions(current, proposal["operations"]))}
                    row["routing_order_origin"] = "deterministic_executor_from_model_gate_positions"
            else:
                if not proposals:
                    row.update(status="exhausted", error="No unused deterministic internal-gate action")
                    history.append(row)
                    save(target / "result.json", row)
                    break
                proposal = proposals[0]["proposal"]
                row["proposal_origin"] = "deterministic_gate_geometry"
                row["control_generation"] = {"unevaluated_candidates": len(proposals), "selected_proxy": proposals[0]["proxy"],
                                             "scope": "Geometry-only generation; no native evaluator called to rank the pool"}
            row["proposal"] = proposal
            validate_action(current, proposal, lock_io)
            row["matches_shared_hint_positions"] = any(
                search.key(search.apply_positions(current, proposal["operations"])) ==
                search.key(search.apply_positions(current, p["proposal"]["operations"])) for p in proposals[:12]) if args.guidance == "geometry" else None
            identity = action_key(current, proposal)
            if identity in seen:
                raise ValueError("Repeated exact gate-state/action pair; slot consumed without another native call")
            seen.add(identity)
            native_calls += 1
            result = search.evaluate(current, proposal, target / "candidate", inputs / "source.v", inputs / "normalized.v",
                                     prepared["manifest"]["frontend"], prepared["manifest"]["configuration"], args.candidate_timeout, lock_io=lock_io)
            row.update(result)
            options = []
            if is_certified(result):
                candidate = json.loads((target / "candidate/layout_candidate.json").read_text())
                candidate_clock = json.loads((target / "candidate/clock.json").read_text())
                row["node_changes"] = node_delta(current, candidate)
                options = [{**result, "candidate": candidate, "clock": candidate_clock}]
            next_state, decision = gate.select_state(best, best_metrics, best_clock, options, expanded)
            row["decision"] = decision
            if decision == "improved_retained":
                best, best_metrics, best_clock = (copy.deepcopy(next_state[k]) for k in ("candidate", "metrics", "clock"))
                best_path, selected_round = target / "candidate", number
                if policy.startswith("llm_"):
                    shadows = {}
                    changed = search.apply_positions(current, proposal["operations"])
                    for name, shadow in (
                        ("routing_only", {**proposal, "operations": [], "rationale": "Diagnostic only: model route order with unchanged gate positions."}),
                        ("placement_reference_order", {**proposal, "routing_order": search.control_order(changed), "rationale": "Diagnostic only: model gate positions with deterministic reference route order."})):
                        try:
                            diagnostic_calls += 1
                            shadows[name] = search.evaluate(current, shadow, target / name, inputs / "source.v", inputs / "normalized.v",
                                                           prepared["manifest"]["frontend"], prepared["manifest"]["configuration"], args.candidate_timeout, lock_io=lock_io)
                        except Exception as error:
                            shadows[name] = {"status": "failed", "error": str(error)}
                    save(target / "attribution.json", {"scope": "Post-acceptance diagnostic replays from the identical starting state; not an all-case ablation and never supplied to live feedback.",
                                                       "joint_metrics": copy.deepcopy(best_metrics), "diagnostics": shadows})
            current, metrics, clock = (copy.deepcopy(next_state[k]) for k in ("candidate", "metrics", "clock"))
        except Exception as error:
            row.update(status="failed", error=str(error))
            if (target / "response.json").is_file():
                try:
                    audit = json.loads((target / "response.json").read_text())
                    row.update(model=audit.get("model"), usage=audit.get("usage"), model_error=audit.get("error"))
                    if (audit.get("error") or {}).get("code") in ("provider_error", "model_unavailable", "model_configuration"):
                        consecutive_provider_failures += 1
                except (OSError, ValueError):
                    pass
        row.update(retained_metrics=copy.deepcopy(best_metrics), next_state=gate.state_key(current), elapsed_s=time.monotonic() - started)
        history.append(row)
        save(target / "result.json", row)
        print(folder.name, policy, number, row["status"], row.get("decision"), best_metrics["area_tiles"], best_metrics["qca_cells"], flush=True)
        if consecutive_provider_failures >= 3:
            break
    final = target_root / "selected"
    final.mkdir()
    # A fresh archive, never overwriting the source, records both the exact
    # selected gate graph and the corresponding mapped/certified device files.
    for name in ("layout_candidate.json", "layout.ifcn", "routed_dag.json", "clock.json", "physical.json", "interface.json", "logic.json", "device_energy_input.qca"):
        source = best_path / name
        if not source.is_file() and (best_path / ("checked_" + name)).is_file():
            source = best_path / ("checked_" + name)
        if not source.is_file():
            raise ValueError("Selected gate/device archive lacks required evidence: " + name)
        shutil.copy2(source, final / name)
    for name in ("source.v", "normalized.v"):
        shutil.copy2(inputs / name, final / name)
    record = {"initial": prepared["metrics"], "selected": best_metrics, "selected_round": selected_round,
              "selected_artifact_source": str(best_path.relative_to(folder)), "port_policy": args.port_policy,
              "round_budget": args.rounds, "rounds_completed": len(history),
              "budget_complete": len(history) == args.rounds, "model_request_attempts": requests,
              "successful_model_proposals": successes, "backend_evaluation_attempts": native_calls,
              "native_execution_reports": len(list(target_root.glob("*/candidate/layout_candidate.json"))),
              "diagnostic_backend_evaluation_attempts": diagnostic_calls,
              "outcomes": dict(Counter(r.get("decision", r["status"]) for r in history)),
              "model_errors": dict(Counter((r.get("model_error") or {}).get("code") for r in history if r.get("model_error"))),
              "final_node_changes": node_delta(initial, best), "selected_hashes": {p.name: sha(p) for p in final.iterdir()},
              "source_and_DAG_unchanged": True, "rounds": history}
    save(target_root / "summary.json", record)
    return {k: v for k, v in record.items() if k != "rounds"}


def aggregate(rows, policies):
    completed = [r for r in rows if r.get("status") == "completed"]
    result = {"registered_cases": len(rows), "eligible_cases": sum(r.get("eligible", False) for r in rows),
              "completed_cases": len(completed), "policies": {}}
    paired = [r for r in completed if all(r["policies"][p]["budget_complete"] for p in policies)]
    result["paired_budget_complete_cases"] = len(paired)
    result["paired_budget_complete_policies"] = {}
    for policy in policies:
        reports = [r["policies"][policy] for r in completed]
        result["policies"][policy] = {
            "evaluated_cases": sum(r["native_execution_reports"] > 0 for r in reports),
            "improved_cases": sum(search.pareto(r["initial"], r["selected"]) for r in reports),
            "mean_area_reduction_pct_all_eligible": sum(100 * (1 - r["selected"]["area_tiles"] / r["initial"]["area_tiles"]) for r in reports) / len(reports) if reports and len(reports) == result["eligible_cases"] else None,
            "mean_qca_reduction_pct_all_eligible": sum(100 * (1 - r["selected"]["qca_cells"] / r["initial"]["qca_cells"]) for r in reports) / len(reports) if reports and len(reports) == result["eligible_cases"] else None,
            "total_qca_cells_saved": sum(r["initial"]["qca_cells"] - r["selected"]["qca_cells"] for r in reports),
            "model_request_attempts": sum(r["model_request_attempts"] for r in reports),
            "successful_model_proposals": sum(r["successful_model_proposals"] for r in reports),
            "backend_evaluation_attempts": sum(r["backend_evaluation_attempts"] for r in reports),
            "native_execution_reports": sum(r["native_execution_reports"] for r in reports),
            "diagnostic_backend_evaluation_attempts": sum(r["diagnostic_backend_evaluation_attempts"] for r in reports),
            "incomplete_budgets": sum(not r["budget_complete"] for r in reports),
        }
        matched = [r["policies"][policy] for r in paired]
        result["paired_budget_complete_policies"][policy] = {
            "mean_area_reduction_pct": sum(100 * (1 - r["selected"]["area_tiles"] / r["initial"]["area_tiles"]) for r in matched) / len(matched) if matched else None,
            "mean_qca_reduction_pct": sum(100 * (1 - r["selected"]["qca_cells"] / r["initial"]["qca_cells"]) for r in matched) / len(matched) if matched else None,
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cases", nargs="+")
    parser.add_argument("--rounds", type=int, default=8)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--policies", nargs="+", choices=POLICIES, default=["deterministic_gate", "llm_gate_placement"])
    parser.add_argument("--port-policy", choices=("fixed", "movable"), default="fixed")
    parser.add_argument("--vision", action="store_true")
    parser.add_argument("--guidance", choices=("none", "geometry"), default="geometry")
    parser.add_argument("--candidate-timeout", type=int, default=20)
    parser.add_argument("--model-timeout", type=int, default=60)
    parser.add_argument("--provider")
    parser.add_argument("--model-id")
    args = parser.parse_args()
    if not 1 <= args.rounds <= 32 or not 1 <= args.workers <= 2 or not 1 <= args.candidate_timeout <= 120 or not 1 <= args.model_timeout <= 120:
        parser.error("rounds 1..32, workers 1..2, timeouts 1..120 seconds")
    if bool(args.provider) != bool(args.model_id) or len(args.policies) != len(set(args.policies)):
        parser.error("provider/model-id must be paired; policies must be unique")
    model = {"provider": args.provider, "modelId": args.model_id} if args.provider else None
    frozen = ROOT / "experiments/layout_llm_full"
    protocol = json.loads((frozen / "protocol.json").read_text())
    index = json.loads((frozen / "index.json").read_text())
    if index["protocol_sha256"] != sha(frozen / "protocol.json") or json.loads((frozen / "audit.json").read_text())["index_sha256"] != sha(frozen / "index.json"):
        raise ValueError("Frozen TOY/MAJ corpus hashes do not match")
    known = {c["id"] for c in protocol["cases"]}
    if args.cases and (not set(args.cases) <= known or len(args.cases) != len(set(args.cases))):
        parser.error("cases must be unique registered TOY/MAJ IDs")
    cases = [c for c in protocol["cases"] if args.cases is None or c["id"] in args.cases]
    node = choose_node(ROOT / "engine")
    if any(p.startswith("llm_") for p in args.policies):
        model = resolve_model(node, model)
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    entries, prepared = [], {}
    watched = {str(frozen / name): sha(frozen / name) for name in ("protocol.json", "index.json", "audit.json")}
    for ordinal, case in enumerate(cases, 1):
        selection = index["selection"][case["id"]]
        entry = {"case_id": case["id"], "ordinal": ordinal, "eligible": False, "status": "unavailable", "reasons": selection["reasons"]}
        if selection["status"] == "selected":
            entry["folder"] = f"c{ordinal:02d}_{case['group']}_{Path(case['id']).stem}"
            folder = out / entry["folder"]
            folder.mkdir()
            try:
                bundle = prepare_baseline(ROOT / "engine/output/pi-runs" / selection["run_id"], folder / "inputs")
                if sha(folder / "inputs/source.v") != case["source_sha256"] or sha(folder / "inputs/normalized.v") != case["normalized_sha256"]:
                    raise ValueError("Baseline source differs from frozen circuit")
                prepared[case["id"]] = bundle
                watched.update(bundle["source_artifacts"])
                entry.update(status="pending", eligible=True, reasons=[], initial=bundle["metrics"])
            except Exception as error:
                entry["reasons"] = [str(error)]
        entries.append(entry)
    files = [Path(__file__), Path(__file__).with_name("run_study.py"), ROOT / "integrations/pi/layout-proposer.mjs",
             *sorted((ROOT / "engine/scripts").glob("*.py")), ROOT / "engine/src/app/ifcn_layout_edit.cpp",
             ROOT / "engine/include/autopr/graph/circuitGraph.cpp"]
    implementation = {str(p): sha(p) for p in files}
    for path in files:
        destination = out / "implementation" / path.relative_to(ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    binaries = {str(ROOT / "engine/build" / name): sha(ROOT / "engine/build" / name)
                for name in ("ifcn_layout_edit", "ifcn_energy_analysis", "ifcn_mapping_metrics")}
    save(out / "protocol.json", {"schema": "ifcn.gate_direct_study.v1", "created_at": datetime.now(timezone.utc).isoformat(),
         "case_entries": entries, "arguments": vars(args), "model": model, "model_selection": "explicit" if args.provider else "existing_Pi_default_resolved_once_and_frozen",
         "search_contract": "One direct model-authored gate action or deterministic control per round. The deterministic pool uses disclosed geometry-only ranking without native evaluations. No hidden model retry or routing-order retry. All policies use the same proposal/native budgets and validators; post-acceptance diagnostic evaluations are separately counted and excluded from live feedback.",
         "exploration": "Only certified states within 10% of both retained objectives. Best result only accepts Pareto gains; temporary exploratory regressions are never final gains.",
         "port_policy": args.port_policy, "gate_contract": "Fixed logical DAG and port identities; internal gate relocation mandatory; coordinates and route priority are optimization variables. Gate-level rerouting precedes device mapping and full implemented certificates.",
         "limits": "Irregular-clock combinational baselines only; unavailable circuits remain in coverage. Numerical device dynamics and power are not recomputed by this study.",
         "source_hashes": watched, "implementation_hashes": implementation, "binary_hashes": binaries})
    results = {e["case_id"]: copy.deepcopy(e) for e in entries}
    def persist():
        rows = [results[e["case_id"]] for e in entries]
        save(out / "summary.json", {"aggregate": aggregate(rows, args.policies), "cases": rows})
    persist()
    def run_case(entry):
        folder = out / entry["folder"]
        order = args.policies if entry["ordinal"] % 2 else list(reversed(args.policies))
        reports = {policy: run_policy(folder, policy, prepared[entry["case_id"]], args, node, model) for policy in order}
        row = {**entry, "status": "completed", "policy_order": order, "policies": reports}
        save(folder / "summary.json", row)
        return row
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(run_case, e): e for e in entries if e["eligible"]}
        for future in as_completed(futures):
            entry = futures[future]
            try:
                results[entry["case_id"]] = future.result()
            except Exception as error:
                results[entry["case_id"]] = {**entry, "status": "execution_failed", "error": str(error)}
            persist()
    audit = {"completed_at": datetime.now(timezone.utc).isoformat(),
             "original_artifacts_unchanged": all(Path(p).is_file() and sha(p) == digest for p, digest in watched.items()),
             "implementation_unchanged": all(sha(p) == digest for p, digest in {**implementation, **binaries}.items()),
             "artifact_hashes": {str(p.relative_to(out)): sha(p) for p in out.rglob("*") if p.is_file()}}
    save(out / "audit.json", audit)
    if not audit["original_artifacts_unchanged"] or not audit["implementation_unchanged"]:
        raise ValueError("Original inputs or execution implementation changed during the study")
    print("COMPLETED", out, flush=True)


if __name__ == "__main__":
    main()
