"""Read-only import of a certified deterministic prefix for paired continuation.

Only ``deterministic_gate/selected`` is eligible.  The original study is never
modified, and a failed import never falls back to the unoptimized input.
"""
from __future__ import annotations

import copy
import hashlib
import json
import shutil
from pathlib import Path

import ifcn_agent as api
import ifcn_gate_search as gate
import ifcn_joint_search as search
from ifcn_agent_clock_validation import clock_arrival_report, read_clock_layout
from ifcn_agent_layout_validation import export_native_ifcn, validate_candidate
from ifcn_axis_compaction import routed_extent
from ifcn_layout_optimization import assert_graph_identity


_FILES = {"source.v", "normalized.v", "layout_candidate.json", "routed_dag.json",
          "layout.ifcn", "clock.json", "physical.json", "interface.json",
          "logic.json", "device_energy_input.qca"}


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read(path):
    return json.loads(Path(path).read_text())


def _action_key(start, proposal):
    # Exactly run_gate_study.action_key; rationale and operation spelling do
    # not make a repeated placement/order eligible for a second evaluation.
    data = [gate.state_key(start), search.key(search.apply_positions(start, proposal["operations"])),
            proposal["routing_order"]]
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def _measure(candidate, physical, clock):
    box = routed_extent(candidate)
    return {k: box[k] for k in ("width", "height", "area_tiles")} | {
        "qca_cells": physical["cell_count"],
        "edge_steps": sum(len(r["path"]) - 1 for r in candidate["routes"]),
        "output_arrival_ticks": {str(n["id"]): clock["arrival_tick_ranges"][str(n["id"])]
                                 for n in candidate["nodes"] if n["is_output"]}}


def _verify_selected(directory, prepared, selected_metrics, port_policy):
    candidate = _read(directory / "layout_candidate.json")
    dag = _read(directory / "routed_dag.json")
    original = prepared["baseline"]
    if (candidate.get("schema") != "ifcn.native_candidate.v1" or candidate.get("routed") is not True
            or candidate.get("algorithm") != original.get("algorithm")
            or candidate.get("algorithm") not in ("compact", "june_random")
            or candidate.get("clock_scheme", "irregular") != "irregular"):
        raise ValueError("Warm-start candidate has a different or unsupported algorithm/clock")
    assert_graph_identity(candidate, original)
    assert_graph_identity(candidate, dag)
    if port_policy == "fixed" and search._io_positions(candidate) != search._io_positions(original):
        raise ValueError("Warm-start changed the fixed PI/PO coordinates")
    validation = validate_candidate(candidate, source_crossings=candidate["algorithm"] == "june_random")
    if validation.get("passed") is not True:
        raise ValueError("Warm-start geometry failed validation: " + str(validation.get("errors")))

    phases = {(c["x"], c["y"]): c["phase"] for c in candidate["cells"]}
    holds = steps = 0
    longest = 1
    for route in candidate["routes"]:
        run = 1
        for a, b in zip(route["path"], route["path"][1:]):
            same = phases[tuple(a)] == phases[tuple(b)]
            holds += same
            steps += 1
            run = run + 1 if same else 1
            longest = max(longest, run)
    if (longest > (4 if candidate["algorithm"] == "compact" else 10)
            or candidate["algorithm"] == "june_random" and holds * 10 > steps * 3):
        raise ValueError("Warm-start violates original same-phase clock constraints")

    certificates = {name: _read(directory / (name + ".json"))
                    for name in ("clock", "physical", "interface", "logic")}
    bindings = {
        "clock": {"ifcn_sha256": "layout.ifcn", "routed_dag_sha256": "routed_dag.json"},
        "physical": {"ifcn_sha256": "layout.ifcn", "qca_sha256": "device_energy_input.qca"},
        "interface": {"qca_sha256": "device_energy_input.qca"},
        "logic": {"source_sha256": "source.v", "routed_dag_sha256": "routed_dag.json"}}
    for kind, fields in bindings.items():
        certificate = certificates[kind]
        if (certificate.get("status") != "equivalent" if kind == "logic" else certificate.get("passed") is not True):
            raise ValueError("Warm-start has a failed " + kind + " certificate")
        if any(certificate.get(field) != _sha(directory / name) for field, name in fields.items()):
            raise ValueError("Warm-start " + kind + " certificate file binding differs")

    verification = directory / "verification"
    verification.mkdir()
    export_native_ifcn(candidate, verification / "candidate.ifcn", candidate["algorithm"])
    if (read_clock_layout((verification / "candidate.ifcn").read_text())
            != read_clock_layout((directory / "layout.ifcn").read_text())):
        raise ValueError("Warm-start candidate and certified IFCN differ")
    for name in ("source.v", "normalized.v"):
        logic = api.logic_report(directory / name, directory / "routed_dag.json",
                                 verification / (name + ".logic.json"))
        if logic.get("status") != "equivalent":
            raise ValueError("Warm-start source/DAG equivalence failed for " + name)
    clock = clock_arrival_report(directory / "layout.ifcn", directory / "routed_dag.json",
                                 verification / "clock.json")
    if clock.get("passed") is not True:
        raise ValueError("Warm-start clock verification failed")
    interface = api.qca_interface_report(directory / "device_energy_input.qca", prepared["manifest"]["frontend"],
                                         verification / "interface.json")
    # Recheck the archived native physical certificate and all file bindings;
    # this does not run a router, remap devices, or simulate device dynamics.
    physical = api.physical_route_report(directory / "physical.json", directory / "device_energy_input.qca",
                                         interface, verification / "physical.json", directory / "layout.ifcn")
    if not interface.get("passed") or not physical.get("passed"):
        raise ValueError("Warm-start device verification failed")
    measured = _measure(candidate, physical, clock)
    if measured != selected_metrics:
        raise ValueError("Warm-start measured metrics differ from the archived selected metrics")
    return candidate, measured, clock


def load_seed(study_dir, case_id, prepared, destination, port_policy):
    """Return a validated deterministic seed plus its past evaluation memory.

    ``seed_artifacts`` is the new Path containing the exact selected files.
    ``seed_seen`` and ``seed_expanded`` are independent sets for each caller.
    Provenance ``source_hashes`` includes every original file read during import.
    """
    study = Path(study_dir).resolve()
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Refusing to overwrite a warm-start destination")
    if destination.resolve().is_relative_to(study):
        raise ValueError("Warm-start destination must be outside the archived study")
    if port_policy not in ("fixed", "movable"):
        raise ValueError("Unsupported warm-start port policy")
    watched = {}

    def watch(path):
        resolved = Path(path).resolve()
        if not resolved.is_relative_to(study) or not resolved.is_file():
            raise ValueError("Warm-start artifact escapes or is missing from its study")
        watched[str(resolved)] = _sha(resolved)
        return resolved

    audit_path = watch(study / "audit.json")
    audit = _read(audit_path)
    if (audit.get("original_artifacts_unchanged") is not True
            or audit.get("implementation_unchanged") is not True):
        raise ValueError("Warm-start study lacks a passing preservation audit")
    hashes = audit.get("artifact_hashes", {})

    def audited(path):
        path = watch(path)
        if hashes.get(path.relative_to(study).as_posix()) != watched[str(path)]:
            raise ValueError("Warm-start audit hash differs: " + str(path.relative_to(study)))
        return path

    protocol = _read(audited(study / "protocol.json"))
    summary = _read(audited(study / "summary.json"))
    arguments = protocol.get("arguments", {})
    if (protocol.get("schema") != "ifcn.gate_direct_study.v1"
            or arguments.get("warm_start") or arguments.get("warm_start_study")):
        raise ValueError("Warm-start requires an original deterministic prefix, without imported LLM history")
    if protocol.get("port_policy") != port_policy or arguments.get("port_policy") != port_policy:
        raise ValueError("Warm-start port policy differs from the archived experiment")
    matches = [c for c in summary.get("cases", []) if c.get("case_id") == case_id]
    registered = [c for c in protocol.get("case_entries", []) if c.get("case_id") == case_id]
    if len(matches) != 1 or len(registered) != 1:
        raise ValueError("Warm-start case is missing or duplicated")
    case, registration = matches[0], registered[0]
    if (case.get("status") != "completed" or case.get("eligible") is not True
            or case.get("folder") != registration.get("folder")):
        raise ValueError("Warm-start case has no completed eligible deterministic result")
    policy_dir = study / case["folder"] / "deterministic_gate"
    record = _read(audited(policy_dir / "summary.json"))
    if case.get("policies", {}).get("deterministic_gate") != {k: v for k, v in record.items() if k != "rounds"}:
        raise ValueError("Warm-start case and policy summaries disagree")
    if (record.get("port_policy") != port_policy or record.get("model_request_attempts") != 0
            or record.get("diagnostic_backend_evaluation_attempts") != 0 or record.get("seed_provenance")
            or record.get("budget_complete") is not True
            or record.get("round_budget") != arguments.get("rounds")
            or record.get("round_budget") != record.get("rounds_completed")
            or len(record.get("rounds", [])) != record.get("rounds_completed")):
        raise ValueError("Warm-start prefix is incomplete or contains non-deterministic evaluation history")
    if (record.get("initial") != prepared["metrics"] or case.get("initial") != prepared["metrics"]
            or registration.get("initial") != prepared["metrics"]):
        raise ValueError("Warm-start original baseline metrics differ")

    selected = policy_dir / "selected"
    selected_hashes = record.get("selected_hashes", {})
    if (set(selected_hashes) != _FILES or {p.name for p in selected.iterdir()} != _FILES):
        raise ValueError("Warm-start selected archive is incomplete or contains unexpected files")
    for name, digest in selected_hashes.items():
        path = audited(selected / name)
        if _sha(path) != digest:
            raise ValueError("Warm-start selected hash differs: " + name)
    for name in ("source.v", "normalized.v"):
        expected = prepared["manifest"].get("artifacts", {}).get(name, {}).get("sha256")
        if expected is None or selected_hashes[name] != expected:
            raise ValueError("Warm-start " + name + " differs from the original baseline source")

    history, seen, expanded = [], set(), set()
    calls = 0
    for number, row in enumerate(record["rounds"], 1):
        round_dir = policy_dir / f"{number:02d}"
        stored = _read(audited(round_dir / "result.json"))
        if (row != stored or row.get("round") != number or row.get("model") or row.get("model_proposal")
                or row.get("proposal_origin") not in (None, "deterministic_gate_geometry")):
            raise ValueError("Warm-start deterministic history is inconsistent or model-derived")
        expanded.add(row["start_state"])
        start_path = round_dir / "candidate/start.json"
        if start_path.is_file():
            start = _read(audited(start_path))
            proposal = _read(audited(round_dir / "candidate/proposal.json"))
            if gate.state_key(start) != row["start_state"] or proposal != row.get("proposal"):
                raise ValueError("Warm-start native call differs from its round history")
            assert_graph_identity(start, prepared["baseline"])
            seen.add(_action_key(start, proposal))
            calls += 1
        history.append(copy.deepcopy(row))
    if calls != record.get("backend_evaluation_attempts"):
        raise ValueError("Warm-start evaluation count differs from its archived calls")

    destination.mkdir(parents=True, exist_ok=False)
    for name in sorted(_FILES):
        shutil.copy2(selected / name, destination / name)
        if _sha(destination / name) != selected_hashes[name]:
            raise ValueError("Warm-start artifact changed while copying: " + name)
    candidate, metrics, clock = _verify_selected(destination, prepared, record["selected"], port_policy)
    if any(_sha(path) != digest for path, digest in watched.items()):
        raise ValueError("Original warm-start archive changed during verification")
    provenance = {
        "study_dir": str(study), "case_id": case_id, "policy": "deterministic_gate", "port_policy": port_policy,
        "original_initial_metrics": copy.deepcopy(record["initial"]),
        "prefix_selected_metrics": copy.deepcopy(metrics),
        "prefix_round_budget": record["round_budget"],
        "prefix_rounds_completed": record["rounds_completed"],
        "prefix_backend_evaluation_attempts": record["backend_evaluation_attempts"],
        "prefix_selected_round": record.get("selected_round"),
        "seed_state": gate.state_key(candidate), "selected_hashes": copy.deepcopy(selected_hashes),
        "source_hashes": watched,
        "verification_scope": "Archived deterministic prefix only; source/DAG and clock rechecked; audited QCA physical certificate and interface rechecked without rerouting, remapping or dynamics simulation."}
    return {"baseline": candidate, "metrics": metrics, "clock": clock, "seed_artifacts": destination,
            "seed_history": history, "seed_seen": seen, "seed_expanded": expanded,
            "seed_provenance": provenance}
