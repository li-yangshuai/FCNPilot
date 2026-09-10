#!/usr/bin/env python3
"""Read-only independent audit of the completed TOY/MAJ full study.

This command never submits or resumes a design/model job. It reads terminal
slots, rechecks their evidence, and writes only audit/comparison/archive outputs
in this study. --self-test uses temporary offline fixtures only.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import csv
import fcntl
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]
ENGINE = REPOSITORY / "engine"
sys.path.insert(0, str(ENGINE / "scripts"))
from ifcn_agent_clock_validation import read_clock_layout, validate_clock_arrivals
from verify_routed_logic import verify_bytes
from ifcn_layout_optimization import assert_requested_moves, validate_proposal
from ifcn_agent_layout_validation import export_native_ifcn

LOCKED_PROTOCOL_SHA256 = "7d448ec9d07c33eef1453063e551c2fb13c7b27c4221390901972695dc45014e"
ACTIVE = {"pending", "submitting", "submitted", "running", "created", "queued", "cancelling",
          "ambiguous_submission", "watchdog_active"}
TERMINAL = {"completed", "completed_with_warnings", "failed", "cancelled", "interrupted",
            "unsupported", "invalid_baseline", "invalid_campaign", "unavailable", "size_not_eligible", "submission_failed"}
ROUND_TERMINAL = {"accepted", "rejected", "failed", "cancelled"}
CHECKS = {"ordered_route_continuity", "source_site_isolation", "layer_transition_columns",
          "route_site_coverage", "gate_connection_ports"}
SCOPE = ("Read-only source/DAG Boolean re-evaluation, actual IFCN clock-zone arrival and area, "
         "QCA counts, recorded physical-certificate coverage and content-hash bindings. "
         "No electrical waveform, device settling-time, hardware or power benefit is measured.")


class AuditError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise AuditError(message)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def safe_file(base, relative):
    """Manifest paths never authorize reading outside their run or via symlinks."""
    base, relative = Path(base), Path(relative)
    require(not relative.is_absolute() and ".." not in relative.parts, f"Unsafe artifact path: {relative}")
    current = base
    require(not base.is_symlink(), f"Symlinked base: {base}")
    for part in relative.parts:
        current = current / part
        require(not current.is_symlink(), f"Symlinked artifact: {current}")
    resolved = current.resolve()
    require(resolved.is_relative_to(base.resolve()), f"Artifact escapes its directory: {relative}")
    require(resolved.is_file(), f"Missing artifact: {relative}")
    return resolved


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def positive(value):
    return finite(value) and value > 0


def csv_file(path, rows):
    columns = list(dict.fromkeys(key for row in rows for key in row))
    with Path(path).open("w", newline="") as stream:
        writer = csv.DictWriter(stream, columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, ensure_ascii=False, sort_keys=True)
                             if isinstance(value, (dict, list, tuple)) else value
                             for key, value in row.items()})


def mean(values):
    values = [value for value in values if finite(value)]
    return statistics.fmean(values) if values else None


def reduction(before, after):
    return 100 * (before - after) / before if positive(before) and finite(after) else None


def strictly_better(candidate, incumbent):
    return (candidate["area_tiles"] <= incumbent["area_tiles"]
            and candidate["qca_cells"] <= incumbent["qca_cells"] and candidate != incumbent)


def canonical_cases(protocol):
    chosen = {}
    for case in protocol["cases"]:
        chosen.setdefault(case["source_sha256"], case["id"])
    return chosen


def model_audit(directory, expected_model=None):
    """A saved request is evidence of an allocated request, not of billed tokens."""
    request_file, response_file = directory / "request.json", directory / "response.json"
    result = {"request_recorded": request_file.is_file(), "response_recorded": response_file.is_file(),
              "audit_status": "no_request", "usage_known": False, "reported_total_tokens": None,
              "model_latency_ms": None, "operations": None}
    if not result["request_recorded"]:
        return result
    request_file = safe_file(directory, "request.json")
    result["request_sha256"] = digest(request_file)
    result["audit_status"] = "missing_response"
    if not response_file.is_file():
        return result
    response_file = safe_file(directory, "response.json")
    result["response_sha256"] = digest(response_file)
    try:
        response = load(response_file)
        require(isinstance(response, dict), "Model audit must be a JSON object")
    except (ValueError, UnicodeError):
        result["audit_status"] = "partial_response"
        return result
    result.update(audit_status=response.get("status", "unknown"), model=response.get("model"),
                  error=response.get("error"), model_latency_ms=response.get("latency_ms"),
                  raw_usage=response.get("usage"))
    if expected_model and response.get("model"):
        require(response["model"] == expected_model, "Actual model/provider differs from the locked protocol")
    usage = response.get("usage")
    total = usage.get("totalTokens") if isinstance(usage, dict) else None
    known = finite(total) and total >= 0 and (response.get("status") == "ok" or total > 0)
    result.update(usage_known=known, reported_total_tokens=total if known else None)
    proposal = response.get("proposal")
    if isinstance(proposal, dict) and isinstance(proposal.get("operations"), list):
        result["operations"] = proposal["operations"]
    return result


class Verifier:
    def __init__(self, runs):
        self.runs = Path(runs)
        self.cache = {}
        self.design_cache = {}
        self.logic_cache = {}

    def run(self, run_id, source_hash):
        require(isinstance(run_id, str) and re.fullmatch(r"[0-9a-f]{32}", run_id), "Invalid run ID")
        if run_id in self.cache:
            record = self.cache[run_id]
            require(record["source_sha256"] == source_hash, "One run was assigned to different source identities")
            return record
        directory = self.runs / run_id
        manifest_file = safe_file(directory, "manifest.json")
        manifest = load(manifest_file)
        require(manifest.get("run_id") == run_id, "Run manifest ID differs from its slot")
        lock_file = directory / "run.lock"
        if lock_file.exists():
            with lock_file.open("rb") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise AuditError(f"Run {run_id} still has a live worker lock") from None
                fcntl.flock(lock, fcntl.LOCK_UN)
        require(manifest.get("status") not in ACTIVE or lock_file.is_file(),
                f"Run {run_id} has an active status without a verifiable idle lock")
        artifacts = manifest.get("artifacts")
        require(isinstance(artifacts, dict), "Run has no artifact registry")
        for name, item in artifacts.items():
            file = safe_file(directory, item["path"])
            require(file.stat().st_size == item["bytes"], f"Artifact size mismatch: {run_id}/{name}")
            require(digest(file) == item["sha256"], f"Artifact hash mismatch: {run_id}/{name}")
        require("source.v" in artifacts, f"Run {run_id} has no registered original source")
        source = safe_file(directory, artifacts["source.v"]["path"])
        require(digest(source) == source_hash, f"Run {run_id} source differs from the protocol")
        record = {"run_id": run_id, "directory": directory, "manifest": manifest,
                  "manifest_sha256": digest(manifest_file), "source_sha256": source_hash,
                  "verified_artifacts": len(artifacts)}
        self.cache[run_id] = record
        return record

    def artifact(self, run, name):
        artifacts = run["manifest"]["artifacts"]
        require(name in artifacts, f"Unregistered proof artifact: {run['run_id']}/{name}")
        return safe_file(run["directory"], artifacts[name]["path"])

    def design(self, run, *, prefix=None):
        """Re-evaluate either the selected layout or one accepted/rejected round."""
        cache_key = (run["run_id"], prefix)
        if cache_key in self.design_cache:
            return self.design_cache[cache_key]
        names = {name: (f"{prefix}/{name}" if prefix else name)
                 for name in ("layout.ifcn", "routed_dag.json", "physical.json", "logic.json")}
        qca_name = f"{prefix}/device_energy_input.qca" if prefix else (
            "device.qca" if "device.qca" in run["manifest"]["artifacts"] else "validated_device.qca")
        files = {name: self.artifact(run, key) for name, key in names.items()}
        qca = self.artifact(run, qca_name)
        physical = load(files["physical.json"])
        require(physical.get("schema") == "ifcn.qca.physical_routes.v1"
                and physical.get("passed") is True and CHECKS.issubset(physical.get("checks", [])),
                "Physical certificate is failed or lacks required route/port checks")
        require(physical.get("ifcn_sha256") == digest(files["layout.ifcn"]), "IFCN certificate binding mismatch")
        require(physical.get("qca_sha256") == digest(qca), "QCA certificate binding mismatch")
        qca_text = qca.read_text()
        cells = qca_text.count("[TYPE:QCADCell]")
        require(cells > 0 and physical.get("cell_count") == cells, "Actual QCA count disagrees with physical certificate")
        require(all(type(physical.get(k)) is int and physical[k] > 0 for k in ("net_count", "route_count", "cell_count")),
                "Physical certificate has an empty network")
        terminals = Counter(re.findall(r"(?m)^cell_function=(QCAD_CELL_INPUT|QCAD_CELL_OUTPUT)\s*$", qca_text))
        frontend = run["manifest"]["frontend"]
        require(terminals["QCAD_CELL_INPUT"] == len(frontend["inputs"])
                and terminals["QCAD_CELL_OUTPUT"] == len(frontend["outputs"]), "Actual QCA terminal count mismatch")
        dag = load(files["routed_dag.json"])
        clock = validate_clock_arrivals(files["layout.ifcn"].read_text(), dag)
        require(clock["passed"], "Recomputed cycle-zero clock arrivals fail")
        source = self.artifact(run, "source.v")
        logic_key = (digest(source), digest(files["routed_dag.json"]))
        if logic_key not in self.logic_cache:
            self.logic_cache[logic_key] = verify_bytes(source.read_bytes(), files["routed_dag.json"].read_bytes(), max_inputs=11)
        logic = self.logic_cache[logic_key]
        require(logic.get("status") == "equivalent" and logic.get("vectors_checked") == logic.get("expected_vector_count"),
                "Recomputed source/DAG equivalence fails or is unsupported/incomplete")
        require(terminals["QCAD_CELL_INPUT"] == len(logic["input_ports"])
                and terminals["QCAD_CELL_OUTPUT"] == len(logic["output_ports"]), "QCA terminals disagree with original source declarations")
        require(load(files["logic.json"]).get("status") == "equivalent", "Recorded logic certificate is not exhaustive equivalence")
        nodes, routes, _ = read_clock_layout(files["layout.ifcn"].read_text())
        positions = {node["position"] for node in nodes.values()} | {p for path in routes.values() for p in path}
        xs, ys = zip(*positions)
        width, height = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        metrics = {"area_tiles": width * height, "qca_cells": cells}
        if prefix is None:
            recorded = run["manifest"]["metrics"]
            require(recorded["pnr"]["area_tiles"] == metrics["area_tiles"], "PNR area differs from actual routed IFCN bounding box")
            require(recorded["mapping"]["cell_count"] == cells, "Mapped metric differs from actual QCA count")
        result = {"metrics": metrics, "width": width, "height": height,
                  "ifcn_sha256": physical["ifcn_sha256"], "qca_sha256": physical["qca_sha256"],
                  "routed_dag_sha256": logic_key[1], "source_sha256": logic_key[0],
                  "clock_recomputed": True, "logic_recomputed": True,
                  "vectors_checked": logic.get("vectors_checked"), "physical_bindings_verified": True,
                  "terminal_counts_verified": True}
        self.design_cache[cache_key] = result
        return result

    def campaign(self, run, baseline, slot, protocol):
        manifest = run["manifest"]
        require(manifest.get("optimization", {}).get("source_run_id") == baseline["run_id"], "Campaign was not started from the paired baseline")
        settings = manifest["optimization"]
        require(settings.get("policy") == slot["policy"] and settings.get("seed") == slot["seed"], "Campaign policy/seed mismatch")
        require(settings.get("rounds") == protocol["rounds_per_campaign"], "Campaign round budget mismatch")
        require(settings.get("candidate_timeout_s") == protocol["candidate_timeout_s"]
                and settings.get("model_timeout_s") == protocol["model_timeout_s"], "Campaign timeout budget mismatch")
        for key in ("algorithm", "clock_scheme"):
            require(manifest["parameters"][key] == baseline["manifest"]["metrics"]["pnr"][key], "Campaign changed the paired algorithm/clock family")
        base_design = self.design(baseline)
        for name, expected in (("baseline/layout.ifcn", base_design["ifcn_sha256"]),
                               ("baseline/device.qca", base_design["qca_sha256"]),
                               ("baseline/routed_dag.json", base_design["routed_dag_sha256"])):
            require(digest(self.artifact(run, name)) == expected, "Campaign baseline copy differs from its paired source")
        campaign = load(self.artifact(run, "campaign.json"))
        require(campaign.get("policy") == slot["policy"], "Campaign ledger policy mismatch")
        require(campaign["baseline"]["metrics"] == base_design["metrics"], "Campaign baseline metrics mismatch")
        require(campaign["baseline"].get("source_run_id") == baseline["run_id"], "Campaign ledger baseline ID mismatch")
        rows = campaign.get("rounds", [])
        require([row.get("id") for row in rows] == list(range(1, len(rows) + 1)), "Round IDs are missing, repeated, or reordered")
        require(len(rows) <= protocol["rounds_per_campaign"], "Campaign exceeds the allocated round budget")
        incumbent, selected_round = campaign["baseline"], None
        audited = []
        expected_model = {"provider": protocol["model"]["provider"], "modelId": protocol["model"]["model_id"]}
        for row in rows:
            raw_status = row.get("status")
            interrupted = raw_status in {"proposing", "evaluating"} and slot.get("status") not in {"completed", "completed_with_warnings"}
            require(raw_status in ROUND_TERMINAL or interrupted, "A completed campaign has an unfinished or unknown round")
            require(row.get("start") == incumbent, "Round started from an unrecorded or policy-shared incumbent")
            prefix = f"rounds/{row['id']:02d}"
            folder = run["directory"] / prefix
            model = model_audit(folder, expected_model) if slot["policy"] == "llm" else {"request_recorded": False, "audit_status": "not_applicable", "usage_known": False}
            operations = row.get("proposal", {}).get("operations", model.get("operations"))
            action = json_hash(operations) if isinstance(operations, list) else None
            start_file = self.artifact(run, incumbent["candidate_artifact"])
            state_action = json_hash([digest(start_file), operations]) if action else None
            entry = {"round": row["id"], "status": "interrupted" if interrupted else row["status"], "raw_status": raw_status, "operations": operations,
                     "operations_sha256": action, "state_action_sha256": state_action,
                     "elapsed_s": row.get("elapsed_s"), "failure": row.get("acceptance"), "model": model}
            if row["status"] in ("accepted", "rejected"):
                candidate = row["execution"]["candidate"]
                before_candidate = load(start_file)
                after_candidate = load(self.artifact(run, candidate["candidate_artifact"]))
                proposal = load(self.artifact(run, f"{prefix}/proposal.json"))
                validate_proposal(proposal, before_candidate, allow_noop=slot["policy"] == "noop")
                require(proposal["operations"] == operations, "Executed proposal disagrees with recorded operations")
                if slot["policy"] == "llm":
                    require(model["audit_status"] == "ok" and model["operations"] == operations,
                            "An accepted/evaluated LLM edit was not the audited model proposal")
                assert_requested_moves(proposal, before_candidate, after_candidate)
                with tempfile.TemporaryDirectory(prefix="fcn-full-audit-binding-") as temporary:
                    exported = Path(temporary) / "candidate.ifcn"
                    export_native_ifcn(after_candidate, exported, manifest["parameters"]["algorithm"])
                    require(read_clock_layout(exported.read_text()) == read_clock_layout(self.artifact(run, f"{prefix}/layout.ifcn").read_text()),
                            "Executed native snapshot differs from its certified IFCN geometry/phases")
                proof = self.design(run, prefix=prefix)
                require(candidate["metrics"] == proof["metrics"], "Round candidate metrics differ from actual exported design")
                improve = strictly_better(proof["metrics"], incumbent["metrics"])
                require((row["status"] == "accepted") == improve, "Recorded decision violates the hard Pareto rule")
                entry["certificate"] = proof
                if improve:
                    incumbent, selected_round = candidate, row["id"]
            audited.append(entry)
        require(campaign["selected"] == incumbent and campaign.get("selected_round") == selected_round,
                "Failed/rejected round polluted the selected incumbent")
        selected = self.design(run)
        require(selected["metrics"] == incumbent["metrics"], "Final selected metrics disagree with the campaign ledger")
        require(digest(self.artifact(run, incumbent["layout_artifact"])) == selected["ifcn_sha256"],
                "Selected manifest IFCN is not the ledger's selected layout")
        if selected_round is None:
            require(selected["qca_sha256"] == base_design["qca_sha256"], "An unchanged baseline's QCA was overwritten")
        return {"baseline": base_design, "selected": selected, "selected_round": selected_round, "rounds": audited}


def native_failure_detail(record):
    result = {"classification": "recorded_failure", "worker_error": record["manifest"].get("error"), "candidates": []}
    for file in sorted(record["directory"].rglob("layout_candidate.json")):
        safe_file(record["directory"], file.relative_to(record["directory"]))
        try:
            candidate = load(file)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(candidate, dict):
            continue
        search = candidate.get("search")
        if search:
            result["candidates"].append({"path": str(file.relative_to(record["directory"])), "search": search,
                                         "error": candidate.get("error", candidate.get("native_validation_error"))})
    diagnoses = []
    for file in sorted(record["directory"].rglob("native.log")):
        safe_file(record["directory"], file.relative_to(record["directory"]))
        tail = file.read_text(errors="replace")[-4000:]
        if "No strictly legal regular-clock candidate" in tail:
            result["classification"] = "native_search_no_legal_candidate"
        diagnoses.append({"path": str(file.relative_to(record["directory"])), "tail": tail})
    result["native_diagnostics"] = diagnoses
    result["scope"] = "A bounded search without a legal candidate is not an UNSAT proof; generation/evaluation counts do not imply its whole time cap was spent."
    return result


def unverified_rounds(record, slot, protocol):
    """Recover accounting from a failed campaign without certifying its candidates."""
    directory = record["directory"]
    campaign_file = directory / "campaign.json"
    try:
        campaign = load(campaign_file) if campaign_file.is_file() else {}
    except (ValueError, UnicodeError):
        campaign = {}
    ledger = {row.get("id"): row for row in campaign.get("rounds", []) if isinstance(row, dict)}
    require(all(type(key) is int and 1 <= key <= protocol["rounds_per_campaign"] for key in ledger), "Malformed failed campaign round IDs")
    result = []
    expected = {"provider": protocol["model"]["provider"], "modelId": protocol["model"]["model_id"]}
    for number in range(1, protocol["rounds_per_campaign"] + 1):
        folder = directory / "rounds" / f"{number:02d}"
        row = ledger.get(number)
        if row is None and not folder.is_dir():
            continue
        row = row or {}
        model = model_audit(folder, expected) if slot["policy"] == "llm" else {"request_recorded": False, "audit_status": "not_applicable", "usage_known": False}
        operations = row.get("proposal", {}).get("operations", model.get("operations"))
        action = json_hash(operations) if isinstance(operations, list) else None
        raw = row.get("status")
        status = raw if raw in {"failed", "cancelled"} else "interrupted" if raw in {None, "proposing", "evaluating"} else "unverified"
        result.append({"round": number, "status": status, "raw_status": raw, "operations": operations,
                       "operations_sha256": action, "state_action_sha256": None, "elapsed_s": row.get("elapsed_s"),
                       "failure": row.get("acceptance"), "model": model, "certificate": None})
    return result


def eligibility_label(slot):
    value = slot.get("eligibility") or {}
    if value.get("eligible"):
        return "eligible"
    if ((finite(value.get("nodes")) and value["nodes"] > 50)
            or (finite(value.get("routes")) and value["routes"] > 100)):
        return "size_not_eligible"
    if finite(value.get("inputs")) and value["inputs"] > 11:
        return "input_limit_not_eligible"
    return "not_eligible"


def aggregate(protocol, native_rows, campaign_rows):
    canonical = set(canonical_cases(protocol).values())
    native = []
    for method in protocol["baselines"]:
        rows = [row for row in native_rows if row["case_id"] in canonical and row["baseline_id"] == method["id"]]
        passed = [row for row in rows if row.get("verified_success")]
        native.append({"baseline_id": method["id"], "algorithm": method["algorithm"], "clock": method["clock"],
                       "source_denominator": len(rows), "certified_successes": len(passed),
                       "success_percent": 100 * len(passed) / len(rows) if rows else None,
                       "status_counts": dict(Counter(row["status"] for row in rows)),
                       "eligibility_counts": dict(Counter(row["optimization_eligibility"] for row in rows))})
    policies = []
    for policy in protocol["policies"]:
        rows = [row for row in campaign_rows if row["case_id"] in canonical and row["policy"] == policy]
        eligible = [row for row in rows if row["paired_baseline_verified"]]
        groups = defaultdict(list)
        for row in eligible:
            groups[row["source_sha256"]].append(row)
        per_source = [{"source_sha256": key, "repetitions": len(values),
                       "area_reduction_percent": mean(v["delivered_area_reduction_percent"] for v in values),
                       "cell_reduction_percent": mean(v["delivered_cell_reduction_percent"] for v in values)}
                      for key, values in groups.items()]
        recorded = sum(row["recorded_model_requests"] for row in rows)
        unknown = sum(row["unknown_usage_requests"] for row in rows)
        policies.append({"policy": policy, "planned_slots": len(rows), "eligible_allocated_slots": len(eligible),
                         "eligible_sources": len(groups),
                         "improved_slots": sum(row["strict_improvement"] for row in eligible),
                         "improved_percent": 100 * sum(row["strict_improvement"] for row in eligible) / len(eligible) if eligible else None,
                         "mean_source_area_reduction_percent": mean(row["area_reduction_percent"] for row in per_source),
                         "mean_source_cell_reduction_percent": mean(row["cell_reduction_percent"] for row in per_source),
                         "recorded_model_requests": recorded, "unknown_usage_requests": unknown,
                         "known_reported_tokens": sum(row["known_reported_tokens"] for row in rows),
                         "total_tokens": None if unknown else sum(row["known_reported_tokens"] for row in rows),
                         "allocated_rounds": sum(row["allocated_rounds"] for row in rows),
                         "recorded_rounds": sum(row["recorded_rounds"] for row in rows),
                         "not_attempted_rounds": sum(row["not_attempted_rounds"] for row in rows),
                         "unique_operations_per_campaign_sum": sum(row["unique_operations"] for row in rows),
                         "status_counts": dict(Counter(row["status"] for row in rows)), "per_source": per_source})
    return {"native": native, "policies": policies,
            "canonical_case_ids": sorted(canonical),
            "deduplication": "First protocol-listed representation for each source SHA256, fixed before observing outcomes. All named duplicates remain in detailed tables.",
            "policy_metric": "Three repetitions averaged within each canonical eligible source, then equally weighted across sources. Failed/missing campaigns retain the certified baseline as delivered zero improvement; their candidate measurements remain unavailable.",
            "native_scope": "Descriptive configurations, grouped by clock family. June and Compact have different native hold constraints (10 tiles/30% steps versus 4 tiles), so their comparison is not a same-constraint causal test. Policy comparisons keep the exact paired backend and its rules."}


def audit_study(directory, repository, *, expected_protocol_sha=LOCKED_PROTOCOL_SHA256):
    directory, repository = Path(directory), Path(repository)
    protocol_path = safe_file(directory, "protocol.json")
    protocol, index = load(protocol_path), load(safe_file(directory, "index.json"))
    require(digest(protocol_path) == expected_protocol_sha, "Locked protocol SHA256 changed")
    require(index.get("schema") == "fcnpilot.layout_llm.full_index.v1", "Unsupported runner index schema")
    require(index.get("protocol_sha256") == expected_protocol_sha, "Runner index belongs to another protocol")
    cases = {case["id"]: case for case in protocol["cases"]}
    methods = {method["id"]: method for method in protocol["baselines"]}
    require(len(cases) == len(protocol["cases"]), "Duplicate case IDs in protocol")
    expected_baselines = {(case, method) for case in cases for method in methods}
    expected_campaigns = {(case, policy, repetition) for case in cases for policy in protocol["policies"]
                          for repetition in range(1, protocol["repetitions"] + 1)}
    baseline_slots, campaign_slots = index["baselines"], index["campaigns"]
    require(len(baseline_slots) == len(expected_baselines)
            and {(row["case_id"], row["baseline_id"]) for row in baseline_slots} == expected_baselines,
            "Baseline index does not cover every protocol case/method exactly once")
    require(len(campaign_slots) == len(expected_campaigns)
            and {(row["case_id"], row["policy"], row["repetition"]) for row in campaign_slots} == expected_campaigns,
            "Campaign index does not cover every case/policy/repetition exactly once")
    all_slots = baseline_slots + campaign_slots
    require(len({row["key"] for row in all_slots}) == len(all_slots), "Duplicate durable slot keys")
    require(all(row["status"] in TERMINAL for row in all_slots),
            "Study still has pending, active, ambiguous, or unknown slots; reconcile them before finalizing")
    for row in all_slots:
        require(row["source_sha256"] == cases[row["case_id"]]["source_sha256"], "Slot/source identity mismatch")
    for case in cases.values():
        require(digest(safe_file(directory, case["source"])) == case["source_sha256"], "Frozen input source hash changed")
        require(index.get("source_sha256", {}).get(case["id"]) == case["source_sha256"], "Runner source freeze differs from protocol")
    require(index.get("inventory_sha256") == digest(safe_file(directory, "inventory.json")), "Frozen inventory changed")
    for name, expected in index.get("core_sha256", {}).items():
        require(digest(safe_file(repository, name)) == expected, f"Frozen core changed during study: {name}")
    inventory = load(safe_file(directory, "inventory.json"))
    function_groups = {case: group["id"] for group in inventory["function_classes"] for case in group["case_ids"]}
    require(set(function_groups) == set(cases), "Function-group inventory does not exactly cover the original corpus")
    canonical = canonical_cases(protocol)
    verifier = Verifier(repository / "engine/output/pi-runs")
    errors, native_rows, campaign_rows, round_rows = [], [], [], []
    baseline_records, verified_baselines = {}, {}
    baselines_by_key = {row["key"]: row for row in baseline_slots}
    for slot in baseline_slots:
        case, method = cases[slot["case_id"]], methods[slot["baseline_id"]]
        row = {"slot_key": slot["key"], "case_id": case["id"], "group": case["group"],
               "source_sha256": case["source_sha256"], "function_group": function_groups[case["id"]],
               "canonical_source_row": canonical[case["source_sha256"]] == case["id"],
               "baseline_id": method["id"], "algorithm": method["algorithm"], "clock": method["clock"],
               "status": slot["status"], "run_id": slot.get("run_id"), "verified_success": False,
               "area_tiles": None, "qca_cells": None, "optimization_eligibility": eligibility_label(slot),
               "eligibility": slot.get("eligibility"), "recorded_error": slot.get("error")}
        try:
            require((slot["algorithm"], slot["clock"]) == (method["algorithm"], method["clock"]), "Baseline algorithm/clock differs from protocol")
            require(slot["seed"] == protocol["baseline_seed"], "Baseline seed differs from protocol")
            if slot.get("run_id"):
                record = verifier.run(slot["run_id"], case["source_sha256"])
                baseline_records[slot["key"]] = record
                row["worker_status"] = record["manifest"].get("status")
                row["native_failure_detail"] = native_failure_detail(record) if not slot.get("certified") else None
                if slot.get("certified"):
                    proof = verifier.design(record)
                    pnr = record["manifest"]["metrics"]["pnr"]
                    require((pnr["algorithm"], pnr["clock_scheme"]) == (method["algorithm"], method["clock"]), "Actual native result changed the locked method/clock")
                    if slot.get("eligibility", {}).get("eligible"):
                        eligibility = slot["eligibility"]
                        candidate_file = (verifier.artifact(record, "layout_candidate.json")
                                          if "layout_candidate.json" in record["manifest"]["artifacts"]
                                          else verifier.artifact(record, "layout.ifcn").parent / "layout_candidate.json")
                        candidate_file = safe_file(record["directory"], candidate_file.relative_to(record["directory"]))
                        candidate = load(candidate_file)
                        require(digest(candidate_file) == eligibility.get("native_sha256"), "Eligibility snapshot hash changed")
                        require(len(candidate["nodes"]) <= 50 and len(candidate["routes"]) <= 100
                                and len(record["manifest"]["frontend"]["inputs"]) <= 11, "Selected baseline exceeds fixed optimization support limits")
                    row.update(verified_success=True, **proof["metrics"])
                    verified_baselines[slot["key"]] = proof
                    if slot.get("metrics"):
                        for key in proof["metrics"]:
                            require(slot["metrics"].get(key) == proof["metrics"][key], "Runner baseline metric differs from verified artifact")
            else:
                require(not slot.get("certified"), "A baseline cannot be certified without a run")
        except (ValueError, KeyError, TypeError, OSError) as error:
            row.update(audit_error=str(error), verified_success=False, area_tiles=None, qca_cells=None)
            verified_baselines.pop(slot["key"], None)
            errors.append({"slot": slot["key"], "error": str(error)})
        native_rows.append(row)
    # Validate the declared first-eligible choice, independent of native area.
    for case_id in cases:
        selected = index["selection"][case_id]
        ordered = [next(row for row in baseline_slots if row["case_id"] == case_id and row["baseline_id"] == name)
                   for name in protocol["optimization_baseline_priority"]]
        expected = next((row for row in ordered if row.get("certified") and row.get("eligibility", {}).get("eligible")), None)
        require(selected.get("baseline_key") == (expected["key"] if expected else None),
                f"Baseline selection violated the prespecified first-eligible rule: {case_id}")
        require(selected.get("run_id") == (expected.get("run_id") if expected else None), "Selected baseline run ID mismatch")
    seen_campaigns = set()
    for slot in campaign_slots:
        case = cases[slot["case_id"]]
        selected = index["selection"][case["id"]]
        base_key = selected.get("baseline_key")
        base = verified_baselines.get(base_key)
        planned = protocol["rounds_per_campaign"]
        row = {"slot_key": slot["key"], "case_id": case["id"], "group": case["group"],
               "source_sha256": case["source_sha256"], "function_group": function_groups[case["id"]],
               "canonical_source_row": canonical[case["source_sha256"]] == case["id"],
               "policy": slot["policy"], "repetition": slot["repetition"], "seed": slot["seed"],
               "status": slot["status"], "run_id": slot.get("run_id"), "baseline_key": base_key,
               "baseline_run_id": selected.get("run_id"),
               "baseline_algorithm": baselines_by_key[base_key]["algorithm"] if base_key else None,
               "paired_baseline_verified": base is not None, "baseline_area": base["metrics"]["area_tiles"] if base else None,
               "baseline_cells": base["metrics"]["qca_cells"] if base else None,
               "selected_area": None, "selected_cells": None, "measured_area_reduction_percent": None,
               "measured_cell_reduction_percent": None, "delivered_area_reduction_percent": 0.0 if base else None,
               "delivered_cell_reduction_percent": 0.0 if base else None, "strict_improvement": False,
               "measurement_state": "no_campaign_measurement" if base else "baseline_unavailable",
               "allocated_rounds": planned, "recorded_rounds": 0, "not_attempted_rounds": planned,
               "accepted_rounds": 0, "rejected_rounds": 0, "failed_rounds": 0, "cancelled_rounds": 0, "interrupted_rounds": 0, "unverified_rounds": 0,
               "unique_operations": 0, "unique_state_actions": 0, "recorded_model_requests": 0,
               "unknown_usage_requests": 0, "known_reported_tokens": 0, "model_latency_ms": 0,
               "provider_error_responses": 0, "partial_responses": 0, "recorded_error": slot.get("error")}
        details = []
        try:
            require(slot["seed"] == protocol["seeds"][slot["repetition"] - 1], "Campaign repetition/seed mismatch")
            require(slot.get("baseline_key") == base_key and slot.get("baseline_run_id") == selected.get("run_id"), "Policy used a different baseline than the other paired slots")
            if slot.get("run_id"):
                require(slot["run_id"] not in seen_campaigns, "One campaign run was counted in multiple repetition/policy slots")
                seen_campaigns.add(slot["run_id"])
                record = verifier.run(slot["run_id"], case["source_sha256"])
                require(base is not None, "Campaign ran without an independently certified paired baseline")
                try:
                    proof = verifier.campaign(record, baseline_records[base_key], slot, protocol)
                except (ValueError, KeyError, TypeError, OSError) as failure:
                    if slot["status"] in {"completed", "completed_with_warnings"}:
                        raise
                    # A recorded failed/invalid campaign need not have a valid
                    # final design. Its failure, partial rounds and raw billing
                    # evidence remain visible, but cannot supply an area benefit.
                    details = unverified_rounds(record, slot, protocol)
                    row.update(measurement_state="failed_campaign_no_verified_selection", expected_failure_detail=str(failure))
                    proof = None
                if proof is None:
                    final = base["metrics"]
                else:
                    details = proof["rounds"]
                    final = proof["selected"]["metrics"]
                area, cells = reduction(row["baseline_area"], final["area_tiles"]), reduction(row["baseline_cells"], final["qca_cells"])
                if proof is not None:
                    row.update(selected_area=final["area_tiles"], selected_cells=final["qca_cells"],
                               measured_area_reduction_percent=area, measured_cell_reduction_percent=cells,
                               delivered_area_reduction_percent=area, delivered_cell_reduction_percent=cells,
                               strict_improvement=strictly_better(final, base["metrics"]), measurement_state="verified_selected_layout")
        except (ValueError, KeyError, TypeError, OSError) as error:
            row["audit_error"] = str(error)
            row.update(measurement_state="audit_failed", delivered_area_reduction_percent=None,
                       delivered_cell_reduction_percent=None, paired_baseline_verified=False)
            errors.append({"slot": slot["key"], "error": str(error)})
        row["recorded_rounds"] = len(details)
        row["not_attempted_rounds"] = planned - len(details)
        counts = Counter(item["status"] for item in details)
        for status in ("accepted", "rejected", "failed", "cancelled", "interrupted", "unverified"):
            row[status + "_rounds"] = counts[status]
        row["unique_operations"] = len({item["operations_sha256"] for item in details if item["operations_sha256"] is not None})
        row["unique_state_actions"] = len({item["state_action_sha256"] for item in details if item["state_action_sha256"] is not None})
        for number in range(1, planned + 1):
            item = next((item for item in details if item["round"] == number), None)
            model = item["model"] if item else {"request_recorded": False, "audit_status": "not_attempted", "usage_known": False}
            if model["request_recorded"]:
                row["recorded_model_requests"] += 1
                row["unknown_usage_requests"] += int(not model["usage_known"])
                row["known_reported_tokens"] += model.get("reported_total_tokens") or 0
                row["model_latency_ms"] += model.get("model_latency_ms") or 0
                row["provider_error_responses"] += int(model.get("audit_status") == "error")
                row["partial_responses"] += int(model.get("audit_status") == "partial_response")
            round_rows.append({"slot_key": slot["key"], "case_id": case["id"], "source_sha256": case["source_sha256"],
                               "policy": slot["policy"], "repetition": slot["repetition"], "round": number,
                               "run_id": slot.get("run_id"), "status": item["status"] if item else "not_attempted",
                               "campaign_status": slot["status"], "details": item, "model_audit": model})
        campaign_rows.append(row)
    native_pairs = []
    for case_id in cases:
        for family in ("irregular", "2DDWave"):
            pair = [method for method in protocol["baselines"] if method["clock"] == family]
            for a, b in zip(pair, pair[1:]):
                left = next(row for row in native_rows if row["case_id"] == case_id and row["baseline_id"] == a["id"])
                right = next(row for row in native_rows if row["case_id"] == case_id and row["baseline_id"] == b["id"])
                comparable = left["verified_success"] and right["verified_success"]
                native_pairs.append({"case_id": case_id, "source_sha256": cases[case_id]["source_sha256"],
                                     "canonical_source_row": left["canonical_source_row"], "clock_family": family,
                                     "reference": a["id"], "comparison": b["id"], "both_certified": comparable,
                                     "reference_status": left["status"], "comparison_status": right["status"],
                                     "reference_area": left["area_tiles"], "comparison_area": right["area_tiles"],
                                     "reference_cells": left["qca_cells"], "comparison_cells": right["qca_cells"],
                                     "area_reduction_percent": reduction(left["area_tiles"], right["area_tiles"]) if comparable else None,
                                     "cell_reduction_percent": reduction(left["qca_cells"], right["qca_cells"]) if comparable else None,
                                     "scope": "Descriptive native configurations; clock family alone does not equalize native route constraints."})
    policy_pairs = []
    for case_id in cases:
        for repetition in range(1, protocol["repetitions"] + 1):
            rows = {row["policy"]: row for row in campaign_rows if row["case_id"] == case_id and row["repetition"] == repetition}
            llm = rows["llm"]
            for policy, control in rows.items():
                if policy == "llm":
                    continue
                paired = llm["paired_baseline_verified"] and control["paired_baseline_verified"]
                policy_pairs.append({"case_id": case_id, "source_sha256": cases[case_id]["source_sha256"],
                                     "canonical_source_row": llm["canonical_source_row"], "repetition": repetition,
                                     "control": policy, "baseline_run_id": llm["baseline_run_id"],
                                     "baseline_algorithm": llm["baseline_algorithm"], "paired_baseline_verified": paired,
                                     "llm_status": llm["status"], "control_status": control["status"],
                                     "llm_minus_control_area_reduction_pp": llm["delivered_area_reduction_percent"] - control["delivered_area_reduction_percent"] if paired else None,
                                     "llm_minus_control_cell_reduction_pp": llm["delivered_cell_reduction_percent"] - control["delivered_cell_reduction_percent"] if paired else None})
    summary = aggregate(protocol, native_rows, campaign_rows)
    return {"schema": "fcnpilot.layout_llm.full_audit.v1", "created_at": datetime.now(timezone.utc).isoformat(),
            "passed": not errors, "errors": errors, "protocol_sha256": expected_protocol_sha,
            "index_sha256": digest(directory / "index.json"), "finalizer_sha256": digest(__file__),
            "inventory_sha256": digest(directory / "inventory.json"), "scope": SCOPE,
            "counts": {"named_cases": len(cases), "unique_source_hashes": len(canonical),
                       "fixed_port_truth_table_groups": len(set(function_groups.values())),
                       "baseline_slots": len(baseline_slots), "campaign_slots": len(campaign_slots),
                       "allocated_round_slots": len(round_rows), "distinct_runs_verified": len(verifier.cache)},
            "verified_runs": [{key: value for key, value in row.items() if key not in ("directory", "manifest")}
                              for row in verifier.cache.values()],
            "baseline_status_counts": dict(Counter(row["status"] for row in native_rows)),
            "campaign_status_counts": dict(Counter(row["status"] for row in campaign_rows)),
            "round_status_counts": dict(Counter(row["status"] for row in round_rows)),
            "native_rows": native_rows, "campaign_rows": campaign_rows, "round_rows": round_rows,
            "native_pairs": native_pairs, "policy_pairs": policy_pairs, "summary": summary}


def format_number(value, digits=2):
    return "unavailable" if value is None else f"{value:.{digits}f}"


def render_comparison(directory, protocol, audit):
    native, campaigns = audit["native_rows"], audit["campaign_rows"]
    for filename, rows in (("comparison_native.csv", native), ("comparison_campaigns.csv", campaigns),
                           ("comparison_rounds.csv", audit["round_rows"]),
                           ("comparison_native_pairs.csv", audit["native_pairs"]),
                           ("comparison_policy_pairs.csv", audit["policy_pairs"])):
        csv_file(directory / filename, rows)
    csv_file(directory / "comparison_summary.csv", [{"analysis": "native", **row} for row in audit["summary"]["native"]]
             + [{"analysis": "policy", **{key: value for key, value in row.items() if key != "per_source"}}
                for row in audit["summary"]["policies"]])
    c = audit["counts"]
    inventory = load(directory / "inventory.json")
    source_scope = []
    if inventory.get("authority"):
        source_scope.append(f"Inputs preserve the original source bytes from `{inventory['authority']}`.")
    source_scope.extend(protocol.get("source_caveats", []))
    lines = ["# TOY/MAJ full-study comparison", "",
             f"Audit passed: **{str(audit['passed']).lower()}**. {c['named_cases']} named representations; "
             f"{c['unique_source_hashes']} byte-unique sources; {c['fixed_port_truth_table_groups']} fixed-port truth-table groups.", "",
             *(["Source scope: " + " ".join(source_scope), ""] if source_scope else []),
             f"Coverage: {c['baseline_slots']} native slots, {c['campaign_slots']} policy/repetition slots, "
             f"{c['allocated_round_slots']} allocated round slots. "
             "Failures and unavailable slots remain listed. Unavailable baselines are excluded from paired improvement means; "
             "failed policy campaigns keep the certified baseline as zero delivered improvement. Unmeasured candidate metrics remain unavailable.", "",
             "Native results compare descriptive configurations within a clock family. June allows at most 10 consecutive same-phase tiles "
             "and 30% same-phase steps; Compact allows at most 4 consecutive same-phase tiles. They are not a same-constraint causal comparison. "
             "The four policy arms do share the exact same chosen backend, baseline, DAG, clock rules and candidate budget within each case.", "",
             "## Native configuration coverage", "",
             "| Configuration | Clock family | Certified / unique sources | Success rate |",
             "|---|---|---:|---:|"]
    for row in audit["summary"]["native"]:
        lines.append(f"| {row['baseline_id']} | {row['clock']} | {row['certified_successes']} / {row['source_denominator']} | {format_number(row['success_percent'])}% |")
    lines += ["", "## Paired policy outcomes", "",
              "Values average the three repetitions within each canonical source, then weight eligible sources equally. "
              "The first protocol-listed name for each source hash is canonical; no best-of-duplicate selection is used.", "",
              "| Policy | Eligible sources | Improved / eligible allocated campaigns | Mean area reduction | Mean cell reduction | Recorded model requests / unknown usage |",
              "|---|---:|---:|---:|---:|---:|"]
    for row in audit["summary"]["policies"]:
        lines.append(f"| {row['policy']} | {row['eligible_sources']} | {row['improved_slots']} / {row['eligible_allocated_slots']} | "
                     f"{format_number(row['mean_source_area_reduction_percent'])}% | {format_number(row['mean_source_cell_reduction_percent'])}% | "
                     f"{row['recorded_model_requests']} / {row['unknown_usage_requests']} |")
    lines += ["", "Recorded requests are not proof of provider billing. Raw response usage is summed only when known; "
              "missing/partial audits and provider-error zero placeholders remain unknown. "
              "No-op still reroutes and may reassign clocks; native routing uses its fixed deterministic search. "
              "The simple heuristic does not learn from failed proposals and can repeat them. CSV files report both unique operation lists "
              "and unique incumbent-plus-operation pairs. They do not count rationales as new proposals.", "",
              "## All named native rows", "",
              "Each passing entry is actual area / QCA cells; otherwise the terminal status is shown. A dagger marks a duplicate source omitted from primary aggregation.", "",
              "| Case | June | Compact | Normal | Regular GA |", "|---|---:|---:|---:|---:|"]
    canonical = set(audit["summary"]["canonical_case_ids"])
    for case in protocol["cases"]:
        columns = []
        for method in protocol["baselines"]:
            row = next(row for row in native if row["case_id"] == case["id"] and row["baseline_id"] == method["id"])
            columns.append(f"{row['area_tiles']} / {row['qca_cells']}" if row["verified_success"] else row.get("audit_error", row["status"]).replace("|", "/")[:55])
        lines.append("| " + case["id"] + (" †" if case["id"] not in canonical else "") + " | " + " | ".join(columns) + " |")
    lines += ["", "## All named paired policy means", "",
              "Each entry is delivered area reduction / cell reduction (%), averaged over the allocated repetitions. Full statuses and unique-proposal counts are in comparison_campaigns.csv.", "",
              "| Case | Paired backend | No-op | Random | Heuristic | LLM |", "|---|---|---:|---:|---:|---:|"]
    for case in protocol["cases"]:
        rows = [row for row in campaigns if row["case_id"] == case["id"]]
        algorithm = next((row["baseline_algorithm"] for row in rows if row["baseline_algorithm"]), "unavailable")
        columns = []
        for policy in protocol["policies"]:
            items = [row for row in rows if row["policy"] == policy]
            area = mean(row["delivered_area_reduction_percent"] for row in items)
            cells = mean(row["delivered_cell_reduction_percent"] for row in items)
            columns.append(f"{format_number(area)} / {format_number(cells)}")
        lines.append("| " + case["id"] + (" †" if case["id"] not in canonical else "") + " | " + algorithm + " | " + " | ".join(columns) + " |")
    lines += ["", "Three repetitions are repeated evaluations of the same circuit, not new independent circuits. "
              "Equal candidate budgets do not equalize model cost or wall time; configured concurrency is "
              f"{protocol.get('campaign_concurrency', protocol.get('execution', {}).get('concurrency', 'unspecified'))}. "
              "These are descriptive bounded results, without significance or broad-superiority claims.", "", SCOPE, ""]
    if audit["errors"]:
        lines += ["**Audit errors prevent treating this table as validated experimental evidence.**", ""]
    (directory / "comparison.md").write_text("\n".join(lines))


def render_figures(directory, audit):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "pdf.fonttype": 42})
    native = audit["summary"]["native"]
    fig, axes = plt.subplots(1, 2, figsize=(9.5, 4.3), sharey=True)
    for axis, family in zip(axes, ("irregular", "2DDWave")):
        rows = [row for row in native if row["clock"] == family]
        values = [row["success_percent"] or 0 for row in rows]
        bars = axis.bar([row["baseline_id"] for row in rows], values,
                        color=["#287C8E", "#8BB9A5"] if family == "irregular" else ["#6C73B5", "#A8ACD7"], width=.55)
        for bar, row in zip(bars, rows):
            axis.text(bar.get_x() + bar.get_width()/2, bar.get_height()+2,
                      f"{row['certified_successes']} / {row['source_denominator']}", ha="center", fontsize=10)
        axis.set_title(f"{family} native configurations")
        axis.set_ylim(0, 112)
        axis.set_yticks([0, 25, 50, 75, 100])
        axis.spines[["top", "right"]].set_visible(False)
        axis.grid(axis="y", alpha=.2)
        axis.set_axisbelow(True)
    axes[0].set_ylabel("Certified layouts (% of unique sources)")
    fig.suptitle("Native coverage of the supplied TOY/MAJ corpus", y=.98)
    fig.text(.5, .025, "Source-hash deduplicated. June and Compact retain different native hold constraints; no cross-clock winner claim.",
             ha="center", fontsize=8)
    fig.tight_layout(rect=(0, .06, 1, .92))
    for suffix in ("png", "pdf"):
        fig.savefig(directory / f"native_comparison.{suffix}", dpi=180)
    plt.close(fig)
    rows = audit["summary"]["policies"]
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.3))
    keys = ["improved_percent", "mean_source_area_reduction_percent", "mean_source_cell_reduction_percent"]
    titles = ["Strict improvement rate", "Mean area reduction", "Mean QCA-cell reduction"]
    colors = ["#A5ABB4", "#6CA6BD", "#83AA81", "#DBA351"]
    for axis, key, title in zip(axes, keys, titles):
        values = [row[key] or 0 for row in rows]
        bars = axis.bar([row["policy"] for row in rows], values, color=colors, width=.68)
        maximum = max(values + [1])
        for bar, row in zip(bars, rows):
            text = (f"{row['improved_slots']}/{row['eligible_allocated_slots']}" if key == "improved_percent"
                    else f"{row[key]:.2f}%") if row[key] is not None else "N/A"
            axis.text(bar.get_x()+bar.get_width()/2, bar.get_height()+maximum*.03, text, ha="center", fontsize=9)
        axis.set_title(title)
        axis.set_ylabel("Percent")
        axis.set_ylim(0, max(5, maximum*1.23))
        axis.spines[["top", "right"]].set_visible(False)
        axis.grid(axis="y", alpha=.2)
        axis.set_axisbelow(True)
    fig.suptitle("Policies paired on the identical certified baseline and native constraints", y=.98, fontsize=12)
    fig.text(.5, .026, "Canonical eligible sources; three repetitions per source. Failed requests retain the incumbent; unavailable baselines excluded. No significance claim.",
             ha="center", fontsize=8)
    fig.tight_layout(rect=(0, .065, 1, .92))
    for suffix in ("png", "pdf"):
        fig.savefig(directory / f"policy_comparison.{suffix}", dpi=180)
    plt.close(fig)


EXCLUDE_NAMES = {"evidence.tar.gz", "evidence.json", "evidence_inventory.json", "auth.json", "models.json",
                 "credentials.json", "credentials", "private_key", "id_rsa", "id_ed25519"}
EXCLUDE_DIRS = {"node_modules", ".git", ".venv", "__pycache__"}
SECRET_PATTERNS = [re.compile(rb"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}"),
                   re.compile(rb"\bAIza[A-Za-z0-9_-]{30,}"),
                   re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
                   re.compile(rb"(?i)authorization[\s\"':=]+Bearer [A-Za-z0-9_.-]{25,}")]


def archive_study(directory, repository, index, audit):
    """Archive only in-repository evidence; fail closed on embedded credential patterns."""
    require(audit["passed"], "Cannot label a failed audit as a verified evidence archive")
    sources, excluded = {}, []
    directory, repository = Path(directory).resolve(), Path(repository).resolve()

    def add_tree(base, prefix):
        for file in sorted(base.rglob("*")):
            require(not file.is_symlink(), f"Refusing symlink in evidence: {file}")
            relative = file.relative_to(base)
            if any(part in EXCLUDE_DIRS for part in relative.parts) or file.name.lower() in EXCLUDE_NAMES or file.name.startswith(".env"):
                if file.is_file():
                    excluded.append({"path": str(Path(prefix) / relative), "reason": "self-archive, credential/config, dependency or cache exclusion"})
                continue
            if file.is_file():
                sources[str(Path(prefix) / relative)] = file

    add_tree(directory, "study")
    run_ids = sorted({row["run_id"] for row in index["baselines"] + index["campaigns"] if row.get("run_id")})
    audited_manifests = {row["run_id"]: row["manifest_sha256"] for row in audit.get("verified_runs", [])}
    for run_id in run_ids:
        require(re.fullmatch(r"[0-9a-f]{32}", run_id), "Invalid archived run ID")
        run_directory = repository / "engine/output/pi-runs" / run_id
        require(digest(safe_file(run_directory, "manifest.json")) == audited_manifests.get(run_id), "Run changed after audit")
        manifest = load(run_directory / "manifest.json")
        for name, item in manifest["artifacts"].items():
            file = safe_file(run_directory, item["path"])
            require(file.stat().st_size == item["bytes"] and digest(file) == item["sha256"], f"Artifact changed after audit: {run_id}/{name}")
        add_tree(repository / "engine/output/pi-runs" / run_id, "engine/output/pi-runs/" + run_id)
    for name, expected in index.get("core_sha256", {}).items():
        source = safe_file(repository, name)
        require(digest(source) == expected, f"Frozen implementation changed before archive: {name}")
        sources["implementation_snapshot/" + name] = source
    inventory = []
    for member, file in sorted(sources.items()):
        require(file.resolve().is_relative_to(repository), "Archive tried to include outside-repository content")
        require(not Path(member).is_absolute() and ".." not in Path(member).parts, "Unsafe archive member")
        data = file.read_bytes()
        if b"\x00" not in data[:8192]:
            require(not any(pattern.search(data) for pattern in SECRET_PATTERNS),
                    f"Possible embedded credential: refusing archive member {member}; no secret value is printed")
        inventory.append({"path": member, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    inventory_file = directory / "evidence_inventory.json"
    write(inventory_file, {"schema": "fcnpilot.layout_llm.full_evidence_inventory.v1", "files": inventory,
                           "excluded": excluded, "credential_scan": "Known credential/config files excluded; token/private-key literal patterns rejected in text content."})
    sources["study/evidence_inventory.json"] = inventory_file
    archive = directory / "evidence.tar.gz"
    with tarfile.open(archive, "w:gz", compresslevel=6) as output:
        for member, file in sorted(sources.items()):
            output.add(file, arcname=member, recursive=False)
    expected = {item["path"]: item for item in inventory}
    expected["study/evidence_inventory.json"] = {"bytes": inventory_file.stat().st_size, "sha256": digest(inventory_file)}
    with tarfile.open(archive, "r:gz") as output:
        members = output.getmembers()
        require(len(members) == len(expected) and {member.name for member in members} == set(expected), "Archive membership mismatch")
        for member in members:
            require(member.isfile() and not member.name.startswith("/") and ".." not in Path(member.name).parts, "Unsafe archived entry")
            data = output.extractfile(member).read()
            require(len(data) == expected[member.name]["bytes"]
                    and hashlib.sha256(data).hexdigest() == expected[member.name]["sha256"], "Archived content mismatch")
    result = {"schema": "fcnpilot.layout_llm.full_evidence.v1", "archive": archive.name,
              "bytes": archive.stat().st_size, "sha256": digest(archive), "files": len(expected),
              "inventory_sha256": digest(inventory_file), "audit_sha256": digest(directory / "audit.json"),
              "protocol_sha256": audit["protocol_sha256"], "finalizer_sha256": digest(__file__),
              "run_ids": run_ids, "archive_members_verified": True, "original_runs_unchanged": True}
    write(directory / "evidence.json", result)
    return result


def self_test():
    """Temporary minimal artifacts exercise audit contracts without a model/backend."""
    import copy
    import unittest

    def fixture(root):
        run_id = "1" * 32
        run = root / run_id
        run.mkdir(parents=True)
        source = "module t(a,y); input a; output y; assign y=~a; endmodule\n"
        (run / "source.v").write_text(source)
        (run / "layout.ifcn").write_text(
            "#nodes info\n0,a,input,(0,0);\n1,y,not,(1,0);\n#nodes info\n"
            "#paths info\n(0,1):(0,0),(1,0);\n#paths info\n"
            "#phase map\n(0,0):0;\n(1,0):1;\n#phase map\n")
        write(run / "routed_dag.json", {"schema": "ifcn.dag.v1", "nodes": [
            {"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False},
            {"id": 1, "name": "y", "type": "not", "is_input": False, "is_output": True}],
            "edges": [[0, 1]], "topological_order": [0, 1], "input_count": 1, "output_count": 1})
        (run / "device.qca").write_text("[TYPE:QCADCell]\ncell_function=QCAD_CELL_INPUT\n"
                                      "[TYPE:QCADCell]\ncell_function=QCAD_CELL_OUTPUT\n")
        write(run / "logic.json", {"status": "equivalent"})
        write(run / "layout_candidate.json", {"nodes": [{"id": 0}, {"id": 1}], "edges": [[0, 1]]})
        write(run / "physical.json", {"schema": "ifcn.qca.physical_routes.v1", "passed": True,
              "checks": sorted(CHECKS), "cell_count": 2, "net_count": 1, "route_count": 1,
              "qca_sha256": digest(run / "device.qca"), "ifcn_sha256": digest(run / "layout.ifcn")})
        manifest = {"run_id": run_id, "status": "completed", "artifacts": {},
                    "frontend": {"inputs": ["a"], "outputs": ["y"]},
                    "metrics": {"pnr": {"algorithm": "compact", "clock_scheme": "irregular", "area_tiles": 2},
                                "mapping": {"cell_count": 2}}}
        register(run, manifest)
        return run, manifest

    def register(directory, manifest):
        for file in directory.rglob("*"):
            if file.is_file() and file.name != "manifest.json":
                relative = str(file.relative_to(directory))
                manifest["artifacts"][relative] = {"path": relative, "sha256": digest(file), "bytes": file.stat().st_size}
        write(directory / "manifest.json", manifest)

    class OfflineAuditTests(unittest.TestCase):
        def test_real_clock_logic_count_and_area_recheck(self):
            with tempfile.TemporaryDirectory() as tmp:
                runs = Path(tmp)
                run, _ = fixture(runs)
                verifier = Verifier(runs)
                record = verifier.run(run.name, digest(run / "source.v"))
                proof = verifier.design(record)
                self.assertEqual(proof["metrics"], {"area_tiles": 2, "qca_cells": 2})
                self.assertEqual(proof["vectors_checked"], 2)
                self.assertTrue(proof["clock_recomputed"])

        def test_registered_tampering_and_symlink_escape_are_rejected(self):
            with tempfile.TemporaryDirectory() as tmp:
                runs = Path(tmp)
                run, _ = fixture(runs)
                (run / "device.qca").write_text("changed")
                with self.assertRaisesRegex(AuditError, "size mismatch"):
                    Verifier(runs).run(run.name, digest(run / "source.v"))
                (run / "external").symlink_to(Path(tmp))
                with self.assertRaises(AuditError):
                    safe_file(run, "external/file")
                with self.assertRaises(AuditError):
                    safe_file(run, "../outside")

        def test_failed_runs_still_verify_all_registered_artifacts(self):
            with tempfile.TemporaryDirectory() as tmp:
                run, manifest = fixture(Path(tmp))
                manifest["status"] = "failed"
                write(run / "manifest.json", manifest)
                record = Verifier(Path(tmp)).run(run.name, digest(run / "source.v"))
                self.assertEqual(record["manifest"]["status"], "failed")
                self.assertGreater(record["verified_artifacts"], 5)

        def test_forged_physical_schema_is_not_a_certificate(self):
            with tempfile.TemporaryDirectory() as tmp:
                runs = Path(tmp)
                run, manifest = fixture(runs)
                physical = load(run / "physical.json")
                physical["schema"] = "unrelated.v1"
                write(run / "physical.json", physical)
                register(run, manifest)
                verifier = Verifier(runs)
                with self.assertRaisesRegex(AuditError, "Physical certificate"):
                    verifier.design(verifier.run(run.name, digest(run / "source.v")))

        def test_partial_and_error_zero_usage_are_unknown_not_free(self):
            with tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp)
                write(folder / "request.json", {"request_id": "offline"})
                (folder / "response.json").write_text('{"response":')
                self.assertEqual(model_audit(folder)["audit_status"], "partial_response")
                write(folder / "response.json", {"status": "error", "usage": {"totalTokens": 0}})
                self.assertFalse(model_audit(folder)["usage_known"])
                write(folder / "response.json", {"status": "error", "usage": {"totalTokens": 7}})
                self.assertEqual(model_audit(folder)["reported_total_tokens"], 7)
                (folder / "request.json").unlink()
                self.assertFalse(model_audit(folder)["request_recorded"])

        def test_failed_round_keeps_paired_baseline_and_cannot_mutate_selected(self):
            with tempfile.TemporaryDirectory() as tmp:
                runs = Path(tmp)
                old, original = fixture(runs)
                run = runs / ("2" * 32)
                (run / "baseline").mkdir(parents=True)
                for file in old.iterdir():
                    if file.name != "manifest.json":
                        (run / "baseline" / file.name).write_bytes(file.read_bytes())
                (run / "source.v").write_bytes((old / "source.v").read_bytes())
                manifest = copy.deepcopy(original)
                manifest.update(run_id=run.name, artifacts={}, parameters={"algorithm": "compact", "clock_scheme": "irregular"},
                                optimization={"source_run_id": old.name, "policy": "noop", "seed": 1,
                                              "rounds": 1, "candidate_timeout_s": 20, "model_timeout_s": 60})
                baseline = {"source_run_id": old.name, "layout_artifact": "baseline/layout.ifcn",
                            "candidate_artifact": "baseline/layout_candidate.json", "metrics": {"area_tiles": 2, "qca_cells": 2}}
                campaign = {"policy": "noop", "baseline": baseline, "selected": copy.deepcopy(baseline),
                            "selected_round": None, "rounds": [{"id": 1, "status": "failed", "start": copy.deepcopy(baseline),
                                                                "acceptance": {"reasons": ["controlled offline failure"]}}]}
                write(run / "campaign.json", campaign)
                register(run, manifest)
                for name in ("layout.ifcn", "routed_dag.json", "device.qca", "physical.json", "logic.json"):
                    manifest["artifacts"][name] = manifest["artifacts"]["baseline/" + name]
                write(run / "manifest.json", manifest)
                slot = {"policy": "noop", "seed": 1}
                protocol = {"rounds_per_campaign": 1, "candidate_timeout_s": 20, "model_timeout_s": 60,
                            "model": {"provider": "offline", "model_id": "fake"}}
                verifier = Verifier(runs)
                before = verifier.run(old.name, digest(old / "source.v"))
                current = verifier.run(run.name, digest(run / "source.v"))
                proof = verifier.campaign(current, before, slot, protocol)
                self.assertEqual(proof["selected"]["metrics"], baseline["metrics"])
                campaign["selected"]["metrics"]["area_tiles"] = 1
                write(run / "campaign.json", campaign)
                register(run, manifest)
                verifier = Verifier(runs)
                with self.assertRaisesRegex(AuditError, "polluted"):
                    verifier.campaign(verifier.run(run.name, digest(run / "source.v")),
                                      verifier.run(old.name, digest(old / "source.v")), slot, protocol)

        def test_canonical_hash_selection_never_chooses_best_duplicate(self):
            protocol = {"cases": [{"id": "first", "source_sha256": "same"},
                                   {"id": "duplicate", "source_sha256": "same"}],
                        "baselines": [{"id": "compact", "algorithm": "compact", "clock": "irregular"}], "policies": []}
            native = [{"case_id": "first", "baseline_id": "compact", "verified_success": False, "status": "failed", "optimization_eligibility": "not_eligible"},
                      {"case_id": "duplicate", "baseline_id": "compact", "verified_success": True, "status": "completed", "optimization_eligibility": "eligible"}]
            result = aggregate(protocol, native, [])
            self.assertEqual(result["native"][0]["source_denominator"], 1)
            self.assertEqual(result["native"][0]["certified_successes"], 0)

        def test_complete_unavailable_slot_coverage_and_duplicate_slot_rejection(self):
            with tempfile.TemporaryDirectory() as tmp:
                repository = Path(tmp)
                study = repository / "study"
                study.mkdir()
                (study / "source.v").write_text("offline original source")
                source_hash = digest(study / "source.v")
                case = {"id": "TOY/fixture.v", "group": "TOY", "source": "source.v", "source_sha256": source_hash}
                methods = [{"id": "june", "algorithm": "june_random", "clock": "irregular"},
                           {"id": "compact", "algorithm": "compact", "clock": "irregular"},
                           {"id": "normal", "algorithm": "normal_2ddwave", "clock": "2DDWave"},
                           {"id": "regular_ga", "algorithm": "regular_clock_ga", "clock": "2DDWave"}]
                protocol = {"cases": [case], "baselines": methods, "policies": ["noop", "random", "heuristic", "llm"],
                            "repetitions": 3, "seeds": [1, 2, 3], "baseline_seed": 1, "rounds_per_campaign": 3,
                            "optimization_baseline_priority": ["june", "compact"], "model": {"provider": "offline", "model_id": "fake"}}
                write(study / "protocol.json", protocol)
                write(study / "inventory.json", {"function_classes": [{"id": "offline-function", "case_ids": [case["id"]]}]})
                frozen = digest(study / "protocol.json")
                index = {"schema": "fcnpilot.layout_llm.full_index.v1", "protocol_sha256": frozen,
                         "source_sha256": {case["id"]: source_hash}, "core_sha256": {},
                         "inventory_sha256": digest(study / "inventory.json"), "baselines": [], "campaigns": [],
                         "selection": {case["id"]: {"baseline_key": None, "run_id": None}}}
                for method in methods:
                    index["baselines"].append({"key": "b-" + method["id"], "case_id": case["id"], "source_sha256": source_hash,
                        "baseline_id": method["id"], "algorithm": method["algorithm"], "clock": method["clock"], "seed": 1,
                        "status": "failed", "certified": False, "eligibility": {"eligible": False}})
                for policy in protocol["policies"]:
                    for repetition in [1, 2, 3]:
                        index["campaigns"].append({"key": f"c-{policy}-{repetition}", "case_id": case["id"], "source_sha256": source_hash,
                            "policy": policy, "repetition": repetition, "seed": repetition, "status": "unavailable",
                            "baseline_key": None, "baseline_run_id": None})
                write(study / "index.json", index)
                audit = audit_study(study, repository, expected_protocol_sha=frozen)
                self.assertTrue(audit["passed"])
                self.assertEqual(audit["counts"]["baseline_slots"], 4)
                self.assertEqual(audit["counts"]["campaign_slots"], 12)
                self.assertEqual(audit["round_status_counts"], {"not_attempted": 36})
                self.assertTrue(all(row["selected_area"] is None for row in audit["campaign_rows"]))
                render_comparison(study, protocol, audit)
                render_figures(study, audit)
                for prefix in ("native_comparison", "policy_comparison"):
                    self.assertTrue((study / f"{prefix}.png").read_bytes().startswith(b"\x89PNG"))
                    self.assertTrue((study / f"{prefix}.pdf").read_bytes().startswith(b"%PDF"))
                index["campaigns"][-1] = index["campaigns"][0]
                write(study / "index.json", index)
                with self.assertRaisesRegex(AuditError, "exactly once"):
                    audit_study(study, repository, expected_protocol_sha=frozen)

        def test_interrupted_raw_accounting_does_not_certify_or_drop_provider_usage(self):
            with tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                folder = directory / "rounds/01"
                folder.mkdir(parents=True)
                write(directory / "campaign.json", {"rounds": [{"id": 1, "status": "evaluating"}]})
                write(folder / "request.json", {"request_id": "offline"})
                write(folder / "response.json", {"status": "error", "usage": {"totalTokens": 17}})
                rows = unverified_rounds({"directory": directory}, {"policy": "llm"},
                                         {"rounds_per_campaign": 3, "model": {"provider": "offline", "model_id": "fake"}})
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["status"], "interrupted")
                self.assertEqual(rows[0]["model"]["reported_total_tokens"], 17)
                self.assertIsNone(rows[0]["certificate"])

        def test_archive_excludes_credentials_and_rejects_embedded_token_literals(self):
            with tempfile.TemporaryDirectory() as tmp:
                repository = Path(tmp)
                study = repository / "study"
                study.mkdir()
                write(study / "audit.json", {"passed": True})
                write(study / "auth.json", {"excluded": "never archive this file"})
                (study / "input.v").write_text("offline evidence")
                index = {"baselines": [], "campaigns": [], "core_sha256": {}}
                audit = {"passed": True, "protocol_sha256": "fixture", "verified_runs": []}
                result = archive_study(study, repository, index, audit)
                self.assertTrue(result["archive_members_verified"])
                with tarfile.open(study / "evidence.tar.gz", "r:gz") as archive:
                    self.assertNotIn("study/auth.json", archive.getnames())
                (study / "unsafe.txt").write_text("sk-" + "x" * 40)
                with self.assertRaisesRegex(AuditError, "Possible embedded credential"):
                    archive_study(study, repository, index, audit)

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(OfflineAuditTests))
    return 0 if result.wasSuccessful() else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Only temporary offline audit fixtures; no study outputs")
    parser.add_argument("--finalize", action="store_true", help="Audit the fully terminal study, then emit figures and evidence archive")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.finalize:
        parser.error("Pass --finalize only after all native and policy slots have finished, or --self-test")
    try:
        audit = audit_study(HERE, REPOSITORY)
        write(HERE / "audit.json", audit)
        render_comparison(HERE, load(HERE / "protocol.json"), audit)
        require(audit["passed"], f"Independent audit found {len(audit['errors'])} evidence errors; see audit.json")
        render_figures(HERE, audit)
        evidence = archive_study(HERE, REPOSITORY, load(HERE / "index.json"), audit)
        print(json.dumps({"passed": True, "counts": audit["counts"], "archive": evidence}, indent=2))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("Independent finalization stopped: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
