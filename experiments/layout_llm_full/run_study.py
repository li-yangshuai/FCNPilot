#!/usr/bin/env python3
"""Resumable frozen TOY/MAJ study. Submission is at most once; no model retries.

--check validates the plan without writing an index or starting any process.
Stages submit fresh baselines, submit paired campaigns, or only summarize evidence.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib
import io
import json
import math
import os
from pathlib import Path
import random
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RUN_ID = re.compile(r"^[a-f0-9]{32}$")
ACTIVE = {"created", "pending", "queued", "running", "cancelling"}
TERMINAL = {"completed", "completed_with_warnings", "failed", "cancelled", "interrupted", "unsupported", "invalid_baseline", "invalid_campaign", "unavailable", "submission_failed"}
CERTIFICATES = {"clock_arrival": "cycle_zero_at_template_phase_passed", "physical_routes": "source_isolation_and_ordered_paths_passed", "rtl_equivalence": "exhaustive_scalar_source_vs_routed_dag", "device_terminal_counts": "match_source_declarations"}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def obj(value):
    return value if isinstance(value, dict) else {}


def numeric(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def safe_json(path):
    try:
        data = json.loads(Path(path).read_text())
        return (data, None) if isinstance(data, dict) else ({}, "JSON is not an object")
    except (OSError, ValueError) as error:
        return {}, str(error)


def atomic_text(path, text):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with temporary.open("w") as stream:
        stream.write(text); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save(path, value):
    atomic_text(path, json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


@contextmanager
def study_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".runner.lock").open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another runner owns this study lock; no submissions made") from None
        stream.seek(0); stream.truncate(); stream.write(f"pid={os.getpid()} started={now()}\n"); stream.flush()
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def inside(root, relative):
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise ValueError(f"Path escapes expected root: {relative}")
    return candidate


def load_core(engine):
    scripts = str(engine / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    return importlib.import_module("ifcn_agent"), importlib.import_module("ifcn_layout_optimization")


def core_files(root):
    files = set()
    for folder in ("engine/scripts", "engine/python", "engine/build/python", "engine/src", "engine/include"):
        files.update(path for path in (root / folder).rglob("*") if path.is_file() and path.suffix in {".py", ".cpp", ".h", ".hpp", ".c", ".cc", ".so"} and "__pycache__" not in path.parts)
    files.update(root / name for name in ("integrations/pi/layout-proposer.mjs", "engine/CMakeLists.txt", "experiments/layout_llm_full/run_study.py"))
    files.update(root / "engine/build" / name for name in ("ifcn_combinational_pnr", "ifcn_regular_clock_pnr", "ifcn_layout_edit", "ifcn_mapping_metrics", "ifcn_energy_analysis"))
    return sorted(files)


def freeze_values(root, directory, protocol):
    sources = {case["id"]: digest(inside(directory, case["source"])) for case in protocol["cases"]}
    for case in protocol["cases"]:
        if sources[case["id"]] != case["source_sha256"]:
            raise ValueError(f"Frozen source differs: {case['id']}")
    inventory = directory / "inventory.json"
    environment = {key: value for key, value in os.environ.items() if (key.startswith("IFCN_") or key in {"OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS"}) and not any(secret in key.upper() for secret in ("KEY", "TOKEN", "SECRET", "PASSWORD"))}
    return {"protocol_sha256": digest(directory / "protocol.json"), "runner_sha256": digest(Path(__file__)),
            "core_sha256": {str(path.relative_to(root)): digest(path) for path in core_files(root)},
            "source_sha256": sources, "inventory_sha256": digest(inventory) if inventory.is_file() else None,
            "environment": environment}


def planned_index(protocol):
    if protocol.get("schema") != "fcnpilot.layout_llm.full_protocol.v1":
        raise ValueError("Unexpected protocol schema")
    cases = protocol["cases"]; baselines = protocol["baselines"]; policies = protocol["policies"]
    if len({case["id"] for case in cases}) != len(cases) or len({base["id"] for base in baselines}) != len(baselines):
        raise ValueError("Case or baseline IDs repeat")
    if len(policies) != len(set(policies)) or set(policies) != {"llm", "noop", "random", "heuristic"}:
        raise ValueError("Exactly four prespecified policies are required")
    if len(protocol["seeds"]) != protocol["repetitions"] or not 1 <= protocol["campaign_concurrency"] <= 2:
        raise ValueError("Repetition seeds or concurrency are invalid")
    if set(protocol["optimization_baseline_priority"]) - {base["id"] for base in baselines}:
        raise ValueError("Unknown optimization baseline priority")
    index = {"schema": "fcnpilot.layout_llm.full_index.v1", "created_at": now(), "updated_at": now(), "baselines": [], "campaigns": [], "selection": {}}
    rotated = list(policies); random.Random(protocol["policy_order_seed"]).shuffle(rotated)
    for case_number, case in enumerate(cases, 1):
        for base in baselines:
            index["baselines"].append({"key": f"b{case_number:04d}-{base['id']}", "row": len(index["baselines"]) + 1, "case_id": case["id"], "source_sha256": case["source_sha256"], "baseline_id": base["id"], "algorithm": base["algorithm"], "clock": base["clock"], "seed": protocol.get("baseline_seed", 1), "status": "pending", "run_id": None, "certified": False, "eligibility": {"eligible": False, "reasons": ["baseline not evaluated"]}})
        for repeat, seed in enumerate(protocol["seeds"], 1):
            offset = ((case_number - 1) * protocol["repetitions"] + repeat - 1) % len(rotated)
            ordered = rotated[offset:] + rotated[:offset]
            for policy in ordered:
                index["campaigns"].append({"key": f"c{case_number:04d}-{policy}-r{repeat}", "row": len(index["campaigns"]) + 1, "case_id": case["id"], "source_sha256": case["source_sha256"], "policy": policy, "repetition": repeat, "seed": seed, "block_policy_order": ordered, "baseline_key": None, "baseline_run_id": None, "run_id": None, "status": "pending"})
        index["selection"][case["id"]] = {"status": "pending", "baseline_key": None, "run_id": None, "reasons": []}
    groups = defaultdict(list)
    for case in cases:
        groups[case["source_sha256"]].append(case["id"])
    index["source_groups"] = [{"source_sha256": sha, "case_ids": names} for sha, names in groups.items()]
    index["settings"] = {"concurrency": protocol["campaign_concurrency"], "policy_schedule": "seeded initial permutation, cyclic rotation within each case-repeat block; queue order recorded per slot", "submission_timeout_s": 30, "poll_interval_s": 2,
        "baseline_watchdog_s": protocol["baseline_timeout_s"] + 90,
        "campaign_watchdog_s": protocol["rounds_per_campaign"] * (protocol["candidate_timeout_s"] + protocol["model_timeout_s"] + 10) + 60,
        "cancel_grace_s": max(protocol["candidate_timeout_s"], protocol["model_timeout_s"]) + 30}
    for field, value in (("maximum_baseline_submissions", len(index["baselines"])), ("maximum_campaign_submissions", len(index["campaigns"])), ("maximum_candidate_rounds", len(index["campaigns"]) * protocol["rounds_per_campaign"]), ("maximum_model_calls", len(cases) * protocol["repetitions"] * protocol["rounds_per_campaign"])):
        if protocol.get(field, value) != value:
            raise ValueError(f"Protocol count does not match planned slots: {field}")
    return index


class AmbiguousSubmission(RuntimeError):
    pass


class Study:
    def __init__(self, directory=HERE, root=ROOT, enforce_freeze=True):
        self.directory = Path(directory).resolve(); self.root = Path(root).resolve()
        self.engine = self.root / "engine"; self.runs = self.engine / "output/pi-runs"
        self.python = self.engine / ".venv/bin/python"; self.cli = self.engine / "scripts/ifcn_agent.py"
        self.protocol = json.loads((self.directory / "protocol.json").read_text())
        self.cases = {case["id"]: case for case in self.protocol["cases"]}
        self.path = self.directory / "index.json"; self.mutex = threading.RLock(); self.stop = threading.Event()
        self.api = self.optimization = None
        plan = planned_index(self.protocol)
        self.index = json.loads(self.path.read_text()) if self.path.exists() else plan
        current = freeze_values(self.root, self.directory, self.protocol)
        self.freeze_errors = []
        if self.path.exists():
            for key, value in current.items():
                if self.index.get(key) != value:
                    self.freeze_errors.append(key)
            if self.freeze_errors and enforce_freeze:
                raise RuntimeError(f"Frozen study values changed: {self.freeze_errors}; no new submissions allowed")
            fields = ("key", "row", "case_id", "source_sha256", "seed", "baseline_id", "algorithm", "clock", "policy", "repetition", "block_policy_order")
            if [[j.get(k) for k in fields] for j in self.index["baselines"] + self.index["campaigns"]] != [[j.get(k) for k in fields] for j in plan["baselines"] + plan["campaigns"]]:
                raise RuntimeError("Index slots no longer match the frozen protocol")
        else:
            self.index.update(current)
            inventory, _ = safe_json(self.directory / "inventory.json")
            self.index["function_classes"] = inventory.get("function_classes", [])
            self.index["runtime"] = {"python": str(self.python), "python_sha256": digest(self.python), "driver_python": sys.version, "run_root": str(self.runs)}

    def persist(self):
        with self.mutex:
            self.index["updated_at"] = now(); save(self.path, self.index)

    def update(self, job, **values):
        with self.mutex:
            job.update(values); self.persist()

    def verify_freeze(self):
        for key, value in freeze_values(self.root, self.directory, self.protocol).items():
            if self.index.get(key) != value:
                self.stop.set()
                raise RuntimeError(f"Frozen study value changed: {key}")

    def core(self):
        with self.mutex:
            if self.api is None:
                self.api, self.optimization = load_core(self.engine)
        return self.api, self.optimization

    def run_directory(self, run_id):
        if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
            raise ValueError("Invalid run ID")
        return self.runs / run_id

    def artifacts(self, run_id, verify=True):
        directory = self.run_directory(run_id); manifest = json.loads((directory / "manifest.json").read_text())
        if manifest.get("run_id") != run_id:
            raise ValueError("Manifest/run ID mismatch")
        paths = {}
        for name, entry in obj(manifest.get("artifacts")).items():
            target = inside(directory, entry["path"])
            if verify and (not target.is_file() or target.stat().st_size != entry["bytes"] or digest(target) != entry["sha256"]):
                raise ValueError("Artifact integrity failure: " + name)
            paths[name] = target
        return manifest, paths

    def certify(self, job):
        api, optimization = self.core()
        manifest, files = self.artifacts(job["run_id"])
        if manifest.get("status") not in {"completed", "completed_with_warnings"}:
            raise ValueError(manifest.get("error") or "baseline did not complete")
        if digest(files["source.v"]) != job["source_sha256"]:
            raise ValueError("Baseline source differs from protocol source SHA")
        expected_normalized = self.cases[job["case_id"]].get("normalized_sha256")
        if expected_normalized and digest(files["normalized.v"]) != expected_normalized:
            raise ValueError("Normalized source differs from protocol SHA")
        pnr = obj(obj(manifest.get("metrics")).get("pnr"))
        if (pnr.get("algorithm"), pnr.get("clock_scheme")) != (job["algorithm"], job["clock"]):
            raise ValueError("Backend changed the declared algorithm or clock family")
        if manifest.get("design_type") != "combinational" or any(obj(manifest.get("validation")).get(key) != value for key, value in CERTIFICATES.items()):
            raise ValueError("Current combinational certificates are missing")
        logic = api.audit_case(files["source.v"], files["routed_dag.json"], max_inputs=11)
        if logic.get("status") != "equivalent" or logic.get("equivalent") is not True:
            raise ValueError("Independent source/DAG validation failed: " + str(logic.get("reason") or logic.get("status")))
        if logic.get("vectors_checked") != logic.get("expected_vector_count"):
            raise ValueError("Exhaustive source/DAG audit was incomplete")
        dag = json.loads(files["routed_dag.json"].read_text())
        clock = optimization.validate_clock_arrivals(files["layout.ifcn"].read_text(), dag)
        physical = json.loads(files["physical.json"].read_text())
        qca = files.get("device.qca", files.get("validated_device.qca"))
        if clock.get("passed") is not True or physical.get("passed") is not True or qca is None:
            raise ValueError("Baseline clock/physical verification did not pass")
        if physical.get("ifcn_sha256") != digest(files["layout.ifcn"]) or physical.get("qca_sha256") != digest(qca):
            raise ValueError("Physical certificate is not bound to actual IFCN and QCA")
        required = {"ordered_route_continuity", "source_site_isolation", "layer_transition_columns", "route_site_coverage", "gate_connection_ports"}
        if physical.get("schema") != "ifcn.qca.physical_routes.v1" or not required.issubset(physical.get("checks", [])):
            raise ValueError("Physical certificate is missing required checks")
        if any(not isinstance(physical.get(key), int) or isinstance(physical.get(key), bool) or physical[key] <= 0 for key in ("net_count", "route_count", "cell_count")):
            raise ValueError("Physical certificate has an empty or malformed routed network")
        qca_text = qca.read_text()
        terminals = re.findall(r"(?m)^cell_function=(QCAD_CELL_INPUT|QCAD_CELL_OUTPUT)\s*$", qca_text)
        if terminals.count("QCAD_CELL_INPUT") != len(logic["input_ports"]) or terminals.count("QCAD_CELL_OUTPUT") != len(logic["output_ports"]):
            raise ValueError("Actual QCA terminal counts differ from source declarations")
        actual_cells = qca_text.count("[TYPE:QCADCell]")
        if physical.get("cell_count") != actual_cells:
            raise ValueError("Reported cells differ from actual QCA cells")
        certificate = {"manifest_sha256": digest(self.run_directory(job["run_id"]) / "manifest.json"), "source_sha256": job["source_sha256"], "ifcn_sha256": digest(files["layout.ifcn"]), "qca_sha256": digest(qca), "artifacts_verified": len(files), "routed_dag_sha256": digest(files["routed_dag.json"]), "vectors_checked": logic["vectors_checked"], "input_count": len(logic["input_ports"]), "output_count": len(logic["output_ports"])}
        eligibility = {"eligible": False, "reasons": []}
        try:
            if job["algorithm"] not in {"compact", "june_random"} or job["clock"] != "irregular":
                raise ValueError("outside the irregular placement-edit family")
            candidate_file = files.get("layout_candidate.json", files["layout.ifcn"].parent / "layout_candidate.json")
            if not candidate_file.resolve().is_relative_to(self.run_directory(job["run_id"]).resolve()):
                raise ValueError("Native snapshot is outside its run")
            candidate = json.loads(candidate_file.read_text())
            optimization.assert_graph_identity(candidate, dag)
            eligibility.update(nodes=len(candidate.get("nodes", [])), routes=len(candidate.get("routes", [])), inputs=len(logic["input_ports"]), native_sha256=digest(candidate_file))
            if eligibility["nodes"] > 50 or eligibility["routes"] > 100 or eligibility["inputs"] > 11:
                raise ValueError("size_not_eligible: requires at most 50 nodes, 100 routes, 11 inputs")
            with tempfile.TemporaryDirectory(prefix="fcn-study-binding-") as temporary:
                exported = Path(temporary) / "candidate.ifcn"
                optimization.export_native_ifcn(candidate, exported, job["algorithm"])
                if optimization.read_clock_layout(exported.read_text()) != optimization.read_clock_layout(files["layout.ifcn"].read_text()):
                    raise ValueError("Native snapshot differs from certified serialized geometry/phases")
            if not (self.engine / "build/ifcn_layout_edit").is_file():
                raise ValueError("Native edit executable is missing")
            eligibility["eligible"] = True
        except (OSError, ValueError, KeyError, TypeError) as error:
            eligibility["reasons"] = [str(error)]
        return {"certified": True, "metrics": {"area_tiles": pnr.get("area_tiles"), "qca_cells": actual_cells}, "certificate": certificate, "eligibility": eligibility}

    def log_directory(self, job):
        path = self.directory / "submission_logs" / job["key"]
        path.mkdir(parents=True, exist_ok=True)
        return path

    def run_ids(self):
        return sorted(path.name for path in self.runs.iterdir() if path.is_dir() and RUN_ID.fullmatch(path.name)) if self.runs.exists() else []

    def matches(self, job, manifest):
        if obj(obj(manifest.get("artifacts")).get("source.v")).get("sha256") != job["source_sha256"]:
            return False
        parameters = obj(manifest.get("parameters")); optimization = obj(manifest.get("optimization"))
        if "policy" in job:
            return (optimization.get("source_run_id"), optimization.get("policy"), optimization.get("seed"), optimization.get("rounds")) == (job["baseline_run_id"], job["policy"], job["seed"], self.protocol["rounds_per_campaign"])
        return not optimization and (parameters.get("algorithm"), parameters.get("clock_scheme"), parameters.get("seed")) == (job["algorithm"], job["clock"], job["seed"]) and manifest.get("source") == str(inside(self.directory, self.cases[job["case_id"]]["source"]))

    def recover(self, job):
        logs = self.log_directory(job)
        before, error = safe_json(logs / "before_runs.json")
        if error:
            raise AmbiguousSubmission(f"{job['key']} (row {job['row']}): missing pre-submission inventory; do not retry")
        known = set(before.get("run_ids", [])); matches = []
        for run_id in set(self.run_ids()) - known:
            manifest, _ = safe_json(self.run_directory(run_id) / "manifest.json")
            if self.matches(job, manifest):
                matches.append(run_id)
        if len(matches) != 1:
            self.update(job, status="ambiguous_submission", error=f"Could not uniquely bind submission ({len(matches)} matching new runs); manual review required")
            self.stop.set()
            raise AmbiguousSubmission(f"{job['key']} (row {job['row']}): {len(matches)} matching runs; stopped without resubmission")
        self.update(job, run_id=matches[0], status="submitted", recovered_from_directory_diff=True)
        return matches[0]

    def arguments(self, job):
        if "policy" not in job:
            return ["start", str(inside(self.directory, self.cases[job["case_id"]]["source"])), "--design-type", "combinational", "--algorithm", job["algorithm"], "--clock", job["clock"], "--until", self.protocol.get("baseline_until", "map"), "--timeout", self.protocol["baseline_timeout_s"], "--seed", job["seed"]]
        return ["optimize", job["baseline_run_id"], "--policy", job["policy"], "--seed", job["seed"], "--rounds", self.protocol["rounds_per_campaign"], "--candidate-timeout", self.protocol["candidate_timeout_s"], "--model-timeout", self.protocol["model_timeout_s"], "--provider", self.protocol["model"]["provider"], "--model-id", self.protocol["model"]["model_id"]]

    def submit(self, job):
        if self.stop.is_set():
            return None
        logs = self.log_directory(job)
        save(logs / "before_runs.json", {"at": now(), "run_ids": self.run_ids()})
        command = [str(self.python), str(self.cli), "--runs-dir", str(self.runs), *map(str, self.arguments(job))]
        save(logs / "command.json", {"at": now(), "command": command, "exit_code": None})
        self.update(job, status="submitting", submitted_at=now(), submitted_epoch=time.time(), submission_log=str(logs.relative_to(self.directory)))
        failure = None; returncode = None; process = None
        with (logs / "stdout.txt").open("w") as stdout, (logs / "stderr.txt").open("w") as stderr:
            try:
                process = subprocess.Popen(command, cwd=self.root, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
                self.update(job, launcher_pid=process.pid)
                try:
                    returncode = process.wait(timeout=self.index["settings"]["submission_timeout_s"])
                except subprocess.TimeoutExpired:
                    process.kill(); returncode = process.wait(); failure = "submission_timeout: worker may already exist"
            except OSError as error:
                failure = str(error)
                if process is not None:
                    self.stop.set()
                    self.update(job, status="ambiguous_submission", error="Launcher started before local I/O failure: " + failure)
                    raise AmbiguousSubmission(f"{job['key']} row {job['row']}: launcher may have started a worker; recover without retry") from error
                self.update(job, status="submission_failed", error=failure)
                save(logs / "command.json", {"at": now(), "command": command, "exit_code": returncode, "error": failure, "process_started": False})
                return None
        data, parse_error = safe_json(logs / "stdout.txt")
        save(logs / "command.json", {"at": now(), "command": command, "exit_code": returncode, "error": failure or parse_error, "process_started": True})
        self.update(job, submission_exit_code=returncode, submission_error=failure or parse_error)
        run_id = data.get("run_id")
        if returncode == 0 and isinstance(run_id, str) and RUN_ID.fullmatch(run_id):
            manifest, _ = safe_json(self.run_directory(run_id) / "manifest.json")
            if self.matches(job, manifest):
                self.update(job, status="submitted", run_id=run_id)
                return run_id
        # Never launch again after a timeout, nonzero exit, or damaged response.
        return self.recover(job)

    def cancel(self, job):
        logs = self.log_directory(job); command = [str(self.python), str(self.cli), "--runs-dir", str(self.runs), "cancel", job["run_id"]]
        try:
            result = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=20)
            data = {"at": now(), "command": command, "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
        except (OSError, subprocess.SubprocessError) as error:
            data = {"at": now(), "command": command, "exit_code": None, "error": str(error)}
        save(logs / "cancel.json", data)
        self.update(job, cancel_requested_at=now(), cancel_epoch=time.time())

    def wait(self, job):
        api, _ = self.core(); phase = "campaign" if "policy" in job else "baseline"
        deadline = job.get("submitted_epoch", time.time()) + self.index["settings"][phase + "_watchdog_s"]
        last = None
        while True:
            if self.stop.is_set():
                return None
            try:
                state = api.status(self.run_directory(job["run_id"]))
            except (OSError, ValueError) as error:
                state = {"status": "unknown", "active": True, "error": str(error)}
            signature = (state.get("status"), state.get("current_stage"), state.get("active"))
            if signature != last:
                self.update(job, last_state={"at": now(), "status": signature[0], "stage": signature[1], "active": signature[2], "error": state.get("error")})
                print(job["key"], job["run_id"], *signature, flush=True); last = signature
            if not state.get("active") and state.get("status") in ACTIVE and time.time() > job.get("submitted_epoch", time.time()) + 10:
                state = dict(state, status="interrupted", error="Submission has no active worker; recorded without relaunch")
            if not state.get("active") and state.get("status") not in ACTIVE:
                save(self.log_directory(job) / "terminal_status.json", state)
                return state
            if time.time() > deadline:
                if not job.get("cancel_epoch"):
                    self.cancel(job)
                elif time.time() > job["cancel_epoch"] + self.index["settings"]["cancel_grace_s"]:
                    self.update(job, status="watchdog_active", error="Worker remains active after watchdog cancellation; no new jobs started")
                    self.stop.set(); return None
            self.stop.wait(self.index["settings"]["poll_interval_s"])

    def worker(self, job):
        if self.stop.is_set() or job["status"] in TERMINAL:
            return
        self.verify_freeze()
        if not job.get("run_id"):
            if job["status"] in {"submitting", "ambiguous_submission"}:
                self.recover(job)
            elif "policy" in job:
                baseline = next(base for base in self.index["baselines"] if base["key"] == job["baseline_key"])
                current = self.certify(baseline)
                if current["certificate"] != baseline["certificate"] or current["eligibility"] != baseline["eligibility"]:
                    raise RuntimeError("Selected baseline changed after certification: " + baseline["key"])
                self.submit(job)
            else:
                self.submit(job)
        if not job.get("run_id"):
            return
        state = self.wait(job)
        if state is None:
            return
        self.verify_freeze()
        values = {"status": state.get("status", "failed"), "worker_status": state.get("status"), "finished_at": now(), "error": state.get("error"), "worker_log": str(self.run_directory(job["run_id"]) / "worker.log")}
        if "policy" not in job:
            if state.get("status") in {"completed", "completed_with_warnings"}:
                try:
                    values.update(self.certify(job))
                except (OSError, ValueError, KeyError, TypeError) as error:
                    values.update(status="invalid_baseline", certified=False, error=str(error), eligibility={"eligible": False, "reasons": [str(error)]})
            else:
                message = str(state.get("error") or "baseline did not complete")
                values["eligibility"] = {"eligible": False, "reasons": [message]}
                if "unsupported" in message.lower() or "not supported" in message.lower():
                    values["status"] = "unsupported"
                metrics = obj(state.get("metrics")); pnr = obj(metrics.get("pnr"))
                values["metrics"] = {"area_tiles": pnr.get("area_tiles"), "qca_cells": obj(metrics.get("mapping")).get("cell_count")}
        elif state.get("status") in {"completed", "completed_with_warnings"}:
            try:
                manifest, files = self.artifacts(job["run_id"])
                if not self.matches(job, manifest) or "campaign.json" not in files:
                    raise ValueError("Campaign identity/evidence differs from the submitted slot")
                campaign = json.loads(files["campaign.json"].read_text())
                if campaign.get("schema") != "ifcn.layout_optimization.v1" or campaign.get("policy") != job["policy"]:
                    raise ValueError("Campaign schema/policy mismatch")
                values["certificate"] = {"manifest_sha256": digest(self.run_directory(job["run_id"]) / "manifest.json"), "campaign_sha256": digest(files["campaign.json"]), "artifacts_verified": len(files)}
            except (OSError, ValueError, KeyError, TypeError) as error:
                values.update(status="invalid_campaign", error=str(error))
        self.update(job, **values)

    def execute_stage(self, stage):
        jobs = self.index[stage]
        candidates = [job for job in jobs if job["status"] not in TERMINAL]
        # Reattach known workers before consuming slots with new submissions.
        candidates.sort(key=lambda job: (0 if job.get("run_id") or job["status"] in {"submitting", "ambiguous_submission"} else 1, job["row"]))
        failures = []
        with ThreadPoolExecutor(max_workers=self.index["settings"]["concurrency"]) as pool:
            futures = {pool.submit(self.worker, job): job for job in candidates}
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as error:
                    job = futures[future]; self.stop.set()
                    self.update(job, monitor_error=str(error))
                    failures.append(f"{job['key']} row {job['row']}: {error}")
        self.persist()
        if failures:
            raise RuntimeError("Stopped without retry: " + "; ".join(failures))

    def select_baselines(self):
        if any(job["status"] not in TERMINAL for job in self.index["baselines"]):
            raise RuntimeError("Baseline stage is incomplete or has an ambiguous/active submission")
        for case_id in self.cases:
            choices = {base["baseline_id"]: base for base in self.index["baselines"] if base["case_id"] == case_id}
            selected = None; reasons = []
            for name in self.protocol["optimization_baseline_priority"]:
                baseline = choices[name]
                if baseline.get("certified") and obj(baseline.get("eligibility")).get("eligible") is True:
                    selected = baseline; break
                reasons.extend(f"{name}: {reason}" for reason in obj(baseline.get("eligibility")).get("reasons", [baseline.get("error") or baseline["status"]]))
            choice = {"status": "selected" if selected else "unavailable", "baseline_key": selected["key"] if selected else None, "run_id": selected.get("run_id") if selected else None, "baseline_id": selected["baseline_id"] if selected else None, "reasons": reasons}
            previous = self.index["selection"][case_id]
            if previous.get("status") != "pending" and previous != choice:
                raise RuntimeError("Prespecified baseline selection changed after freezing: " + case_id)
            self.index["selection"][case_id] = choice
            for job in self.index["campaigns"]:
                if job["case_id"] != case_id:
                    continue
                if job["baseline_run_id"] and job["baseline_run_id"] != choice["run_id"]:
                    raise RuntimeError("Campaign baseline changed")
                job.update(baseline_key=choice["baseline_key"], baseline_run_id=choice["run_id"])
                if selected is None:
                    job.update(status="unavailable", error="; ".join(reasons))
        self.persist()


def write_csv(path, rows):
    keys = list(dict.fromkeys(key for row in rows for key in row))
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=keys); writer.writeheader()
    for row in rows:
        writer.writerow({key: (json.dumps(value, ensure_ascii=False, sort_keys=True) if isinstance(value, (dict, list)) else value) for key, value in row.items()})
    atomic_text(path, stream.getvalue())


def audit_usage(audit, attempted):
    """Only a successful audit or positive provider-reported tokens establish usage.

    Error placeholders containing all zeros do not establish a free request.
    Untouched round slots have no request and do not enter the unknown-usage count.
    """
    usage = obj(audit.get("usage")); total = numeric(usage.get("totalTokens"))
    known = audit.get("status") == "ok" or (total is not None and total > 0)
    valid = known and total is not None and total >= 0
    return {"total_tokens": total if valid else None, "usage_unknown": bool(attempted and not valid),
            "latency_ms": numeric(audit.get("latency_ms")),
            "provider": obj(audit.get("model")).get("provider"), "model_id": obj(audit.get("model")).get("modelId")}


def metrics(snapshot):
    raw = obj(obj(snapshot).get("metrics"))
    return {"area_tiles": numeric(raw.get("area_tiles")), "qca_cells": numeric(raw.get("qca_cells"))}


def reduction(before, after):
    before, after = numeric(before), numeric(after)
    return (before - after) / before if before is not None and before > 0 and after is not None else None


def mean(values):
    values = [number for value in values if (number := numeric(value)) is not None]
    return sum(values) / len(values) if values else None


def summarize(study):
    """Read current evidence, preserving all planned slots and unknown values."""
    index, protocol = study.index, study.protocol
    group_for = {name: group["id"] for group in index.get("function_classes", []) for name in group.get("case_ids", [])}
    copies = {group["source_sha256"]: group["case_ids"] for group in index["source_groups"]}
    bases = {job["key"]: job for job in index["baselines"]}
    baseline_rows, campaign_rows, round_rows = [], [], []
    for job in index["baselines"]:
        size = obj(job.get("metrics")); eligibility = obj(job.get("eligibility"))
        baseline_rows.append({key: job.get(key) for key in ("key", "row", "case_id", "source_sha256", "baseline_id", "algorithm", "clock", "seed", "status", "worker_status", "run_id", "certified", "submission_exit_code", "submission_error", "error", "monitor_error", "submission_log", "worker_log")} | {
            "function_class": group_for.get(job["case_id"]), "duplicate_source_ids": [name for name in copies[job["source_sha256"]] if name != job["case_id"]],
            "area_tiles": numeric(size.get("area_tiles")), "qca_cells": numeric(size.get("qca_cells")),
            "optimization_eligible": eligibility.get("eligible") is True, "eligibility_reasons": eligibility.get("reasons", []),
            "nodes": eligibility.get("nodes"), "routes": eligibility.get("routes"), "inputs": eligibility.get("inputs"),
            "selected_for_optimization": obj(index["selection"].get(job["case_id"])).get("baseline_key") == job["key"],
            "certificate": job.get("certificate")})
    for job in index["campaigns"]:
        baseline = bases.get(job.get("baseline_key"), {})
        directory = study.run_directory(job["run_id"]) if job.get("run_id") else None
        manifest, manifest_error = safe_json(directory / "manifest.json") if directory else ({}, None)
        campaign, campaign_error = {}, None
        if directory:
            entry = obj(obj(manifest.get("artifacts")).get("campaign.json"))
            try:
                campaign_path = inside(directory, entry.get("path", "campaign.json"))
                campaign, campaign_error = safe_json(campaign_path)
                if campaign_path.exists() and entry and (digest(campaign_path) != entry.get("sha256") or campaign_path.stat().st_size != entry.get("bytes")):
                    campaign_error = "Campaign registered hash/size mismatch"; campaign = {}
            except (OSError, TypeError, ValueError) as error:
                campaign_error = str(error)
        records = {row["id"]: row for row in campaign.get("rounds", []) if isinstance(row, dict) and isinstance(row.get("id"), int)}
        recorded_baseline = metrics(campaign.get("baseline")); before = obj(baseline.get("metrics"))
        if not any(value is not None for value in recorded_baseline.values()):
            recorded_baseline = {"area_tiles": numeric(before.get("area_tiles")), "qca_cells": numeric(before.get("qca_cells"))}
        selected = metrics(campaign.get("selected"))
        proposals, attempted, accepted, rejected, failed, known_tokens, unknown_usage, requested = set(), 0, 0, 0, 0, [], 0, 0
        errors = [error for error in (manifest_error, campaign_error) if error]
        for round_id in range(1, protocol["rounds_per_campaign"] + 1):
            row = obj(records.get(round_id)); proposal = obj(row.get("proposal")); execution = obj(row.get("execution")); acceptance = obj(row.get("acceptance"))
            round_dir = directory / "rounds" / f"{round_id:02d}" if directory else None
            response_path = round_dir / "response.json" if round_dir else None
            request_path = round_dir / "request.json" if round_dir else None
            request_present = bool(request_path and request_path.is_file())
            response_present = bool(response_path and response_path.is_file())
            audit, audit_error = safe_json(response_path) if response_present else ({}, None)
            actual = bool(row or request_present or response_present or (round_dir and (round_dir / "proposal.json").is_file()))
            attempted += int(actual)
            model_attempted = job["policy"] == "llm" and actual
            requested += int(request_present)
            usage = audit_usage(audit, model_attempted)
            unknown_usage += int(usage["usage_unknown"])
            if usage["total_tokens"] is not None:
                known_tokens.append(usage["total_tokens"])
            operations = proposal.get("operations")
            if isinstance(operations, list):
                canonical = json.dumps(operations, sort_keys=True, separators=(",", ":"))
                proposal_hash = hashlib.sha256(canonical.encode()).hexdigest(); proposals.add(proposal_hash)
            else:
                proposal_hash = None
            decision = acceptance.get("status")
            accepted += int(decision == "accepted"); rejected += int(decision == "rejected")
            failed += int(decision in {"failed", "cancelled"})
            start, candidate = metrics(row.get("start")), metrics(execution.get("candidate"))
            round_rows.append({"campaign_key": job["key"], "campaign_row": job["row"], "case_id": job["case_id"], "source_sha256": job["source_sha256"] , "function_class": group_for.get(job["case_id"]),
                "policy": job["policy"], "repetition": job["repetition"], "seed": job["seed"], "run_id": job.get("run_id"), "baseline_run_id": job.get("baseline_run_id"), "round": round_id,
                "planned": True, "attempted": actual, "round_recorded": bool(row), "status": row.get("status", "evidence_without_round_record" if actual else "not_run"), "campaign_status": job["status"],
                "acceptance": decision, "reasons": acceptance.get("reasons"), "proposal_source": proposal.get("source"), "proposal_hash": proposal_hash, "operations": operations,
                "actual_moves": execution.get("actual_moves"), "rerouted_edges": execution.get("rerouted_edges"), "automatic_changes": execution.get("automatic_changes"),
                "start_area_tiles": start["area_tiles"], "start_qca_cells": start["qca_cells"], "candidate_area_tiles": candidate["area_tiles"], "candidate_qca_cells": candidate["qca_cells"],
                "candidate_validation": obj(execution.get("candidate")).get("validation"), "elapsed_s": numeric(row.get("elapsed_s")),
                "request_artifact": str(request_path) if request_present else None, "response_artifact": str(response_path) if response_present else None,
                "request_recorded": request_present, "response_status": audit.get("status"), "response_error": audit_error or audit.get("error"),
                "total_tokens": usage["total_tokens"], "usage_unknown": usage["usage_unknown"], "latency_ms": usage["latency_ms"],
                "provider": usage["provider"], "model_id": usage["model_id"], "execution_logs": execution.get("logs")})
        validation = obj(obj(campaign.get("selected")).get("validation"))
        final_usable = job["status"] in {"completed", "completed_with_warnings"} and bool(job.get("certificate")) and not errors and validation.get("clock_arrival") is True and validation.get("physical_routes") is True and validation.get("rtl_equivalence") == "exhaustive_scalar_source_vs_routed_dag"
        area_change = reduction(recorded_baseline["area_tiles"], selected["area_tiles"]) if final_usable else None
        cells_change = reduction(recorded_baseline["qca_cells"], selected["qca_cells"]) if final_usable else None
        campaign_rows.append({key: job.get(key) for key in ("key", "row", "case_id", "source_sha256", "policy", "repetition", "seed", "block_policy_order", "status", "worker_status", "run_id", "baseline_key", "baseline_run_id", "submission_exit_code", "submission_error", "error", "monitor_error", "submission_log", "worker_log")} | {
            "function_class": group_for.get(job["case_id"]), "duplicate_source_ids": [name for name in copies[job["source_sha256"]] if name != job["case_id"]], "baseline_algorithm": baseline.get("algorithm"),
            "planned_rounds": protocol["rounds_per_campaign"], "actual_rounds": attempted, "not_run_rounds": protocol["rounds_per_campaign"] - attempted, "recorded_rounds": len(records),
            "accepted_rounds": accepted, "rejected_rounds": rejected, "failed_rounds": failed, "unique_proposal_count": len(proposals),
            "model_requests_recorded": requested, "model_usage_unknown_rounds": unknown_usage, "model_tokens_known_sum": sum(known_tokens) if known_tokens else None,
            "model_tokens_complete_sum": sum(known_tokens) if known_tokens and unknown_usage == 0 else None,
            "baseline_area_tiles": recorded_baseline["area_tiles"], "baseline_qca_cells": recorded_baseline["qca_cells"], "selected_area_tiles": selected["area_tiles"], "selected_qca_cells": selected["qca_cells"],
            "selected_round": campaign.get("selected_round"), "selected_validation": validation, "final_usable": final_usable,
            "area_reduction_fraction": area_change, "qca_reduction_fraction": cells_change,
            "pareto_improved": (area_change is not None and cells_change is not None and area_change >= 0 and cells_change >= 0 and (area_change > 0 or cells_change > 0)) if final_usable else None,
            "evidence_errors": errors, "certificate": job.get("certificate")})
    source_policy_rows = []
    for group in index["source_groups"]:
        for policy in protocol["policies"]:
            rows = [row for row in campaign_rows if row["case_id"] == group["case_ids"][0] and row["policy"] == policy]
            # The first protocol representation is fixed before observing results.
            # Duplicate representations stay in raw rows, never influence primary means.
            source_policy_rows.append({"source_sha256": group["source_sha256"], "case_ids": group["case_ids"], "canonical_case_id": group["case_ids"][0], "policy": policy,
                "planned_campaigns": len(rows), "usable_campaigns": sum(row["final_usable"] for row in rows),
                "mean_area_reduction_fraction": mean(row["area_reduction_fraction"] for row in rows),
                "mean_qca_reduction_fraction": mean(row["qca_reduction_fraction"] for row in rows)})
    aggregate = []
    for policy in protocol["policies"]:
        rows = [row for row in campaign_rows if row["policy"] == policy]
        unique = [row for row in source_policy_rows if row["policy"] == policy]
        aggregate.append({"policy": policy, "case_denominator": len(protocol["cases"]), "byte_unique_source_denominator": len(index["source_groups"]),
            "planned_campaigns": len(rows), "status_counts": dict(Counter(row["status"] for row in rows)), "usable_campaigns": sum(row["final_usable"] for row in rows),
            "usable_byte_unique_sources": sum(row["usable_campaigns"] > 0 for row in unique),
            "planned_rounds": sum(row["planned_rounds"] for row in rows), "actual_rounds": sum(row["actual_rounds"] for row in rows), "not_run_rounds": sum(row["not_run_rounds"] for row in rows),
            "model_requests_recorded": sum(row["model_requests_recorded"] for row in rows), "model_usage_unknown_rounds": sum(row["model_usage_unknown_rounds"] for row in rows),
            "model_tokens_known_sum": sum(values) if (values := [row["model_tokens_known_sum"] for row in rows if row["model_tokens_known_sum"] is not None]) else None,
            "mean_area_reduction_per_byte_unique_source": mean(row["mean_area_reduction_fraction"] for row in unique),
            "mean_qca_reduction_per_byte_unique_source": mean(row["mean_qca_reduction_fraction"] for row in unique)})
    output = {"schema": "fcnpilot.layout_llm.full_summary.v1", "generated_at": now(), "protocol_sha256": index.get("protocol_sha256"), "runner_sha256": index.get("runner_sha256"), "freeze_errors": study.freeze_errors,
        "case_count": len(protocol["cases"]), "byte_unique_source_count": len(index["source_groups"]), "function_class_count": len(index.get("function_classes", [])),
        "planned_baselines": len(baseline_rows), "baseline_status_counts": dict(Counter(row["status"] for row in baseline_rows)), "certified_baselines": sum(row["certified"] is True for row in baseline_rows),
        "baseline_by_algorithm": [{"baseline_id": base["id"], "case_denominator": len(protocol["cases"]), "status_counts": dict(Counter(row["status"] for row in baseline_rows if row["baseline_id"] == base["id"])), "certified": sum(row["certified"] is True for row in baseline_rows if row["baseline_id"] == base["id"])} for base in protocol["baselines"]],
        "selected_case_count": sum(choice.get("status") == "selected" for choice in index["selection"].values()),
        "planned_campaigns": len(campaign_rows), "campaign_status_counts": dict(Counter(row["status"] for row in campaign_rows)),
        "planned_rounds": len(round_rows), "actual_rounds": sum(row["attempted"] for row in round_rows), "not_run_rounds": sum(not row["attempted"] for row in round_rows),
        "policies": aggregate, "source_groups": index["source_groups"], "source_policy_aggregates": source_policy_rows, "function_classes": index.get("function_classes", []), "selection": index["selection"],
        "interpretation": ["All supplied representation cases and allocated slots are retained; unavailable baselines are not evaluated optimization failures.", "Source aggregates use only the first protocol case per source SHA and give each byte-unique source equal weight; repetitions and functionally equivalent encodings do not increase the number of independent circuits.", "Means use observed usable outcomes; missing/failed observations are not zero improvements. Coverage and denominators are reported alongside means.", "LLM proposes moves; deterministic routing, phase repair, mapping and validation execute every policy. Do not attribute control gains to the LLM.", "Compare backends only within their fixed clock family. This is descriptive small-circuit evidence, not physical waveform or power signoff."]}
    write_csv(study.directory / "baseline_summary.csv", baseline_rows)
    write_csv(study.directory / "campaign_summary.csv", campaign_rows)
    write_csv(study.directory / "rounds.csv", round_rows)
    save(study.directory / "summary.json", output)
    lines = ["# Frozen full layout study", "", f"{output['case_count']} representation cases; {output['byte_unique_source_count']} byte-unique sources; {output['function_class_count']} fixed-port-order functional groups.",
        f"Baselines: {len(baseline_rows)} allocated, {output['certified_baselines']} certified. Optimization eligible cases: {output['selected_case_count']}/{output['case_count']}.",
        f"Campaigns: {len(campaign_rows)} allocated. Rounds: {len(round_rows)} allocated, {output['actual_rounds']} attempted, {output['not_run_rounds']} not run.", "", "| Policy | Campaign states | Usable sources / all sources | Attempted rounds / allocated | Mean area reduction | Mean QCA reduction | Unknown usage rounds |", "|---|---|---:|---:|---:|---:|---:|"]
    for row in aggregate:
        percent = lambda value: "not available" if value is None else f"{value * 100:.2f}%"
        lines.append(f"| {row['policy']} | {json.dumps(row['status_counts'], sort_keys=True)} | {row['usable_byte_unique_sources']}/{row['byte_unique_source_denominator']} | {row['actual_rounds']}/{row['planned_rounds']} | {percent(row['mean_area_reduction_per_byte_unique_source'])} | {percent(row['mean_qca_reduction_per_byte_unique_source'])} | {row['model_usage_unknown_rounds']} |")
    lines.extend(["", "Means summarize usable repeats of the first protocol case per byte-unique source, with missing outcomes excluded and coverage shown. See CSVs for all representations, rounds, actual moves, validation outcomes, logs and null values. Repeats and duplicate/functionally equivalent inputs are not independent circuits.", "", "Baseline selection is first eligible June, otherwise Compact. Every policy and repeat uses the same original selected baseline. Native routing and validation are deterministic; the model only proposes edits."])
    if study.freeze_errors:
        lines.extend(["", "**Frozen evidence drift detected:** " + ", ".join(study.freeze_errors)])
    atomic_text(study.directory / "summary.md", "\n".join(lines) + "\n")
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("baselines", "campaigns", "summary", "all"), default="summary")
    parser.add_argument("--check", action="store_true", help="Validate only; no lock/index/log writes and no subprocesses")
    args = parser.parse_args(argv)
    if args.check:
        study = Study()
        print(json.dumps({"check": "passed", "protocol_sha256": study.index["protocol_sha256"], "runner_sha256": study.index["runner_sha256"], "core_files": len(study.index["core_sha256"]), "cases": len(study.cases), "sources": len(study.index["source_groups"]), "function_classes": len(study.index.get("function_classes", [])), "baseline_slots": len(study.index["baselines"]), "campaign_slots": len(study.index["campaigns"]), "round_slots": len(study.index["campaigns"]) * study.protocol["rounds_per_campaign"], "index_exists": study.path.exists()}, indent=2))
        return 0
    with study_lock(HERE):
        study = Study(enforce_freeze=args.stage != "summary")
        if args.stage == "summary":
            if not study.path.exists():
                raise RuntimeError("No frozen index exists; use --check before starting baselines")
            summarize(study); return 0
        study.persist()
        def stop_requested(signum, _frame):
            study.stop.set()
            print(f"Signal {signum}: stopping new submissions; known workers remain recorded and will be reattached on resume", flush=True)
        previous = {number: signal.signal(number, stop_requested) for number in (signal.SIGTERM, signal.SIGINT)}
        result = 0
        try:
            if args.stage in {"baselines", "all"}:
                study.execute_stage("baselines")
            if study.stop.is_set():
                raise InterruptedError("Study interrupted; no submission retried")
            study.select_baselines()
            if args.stage in {"campaigns", "all"}:
                study.execute_stage("campaigns")
            if study.stop.is_set():
                raise InterruptedError("Study interrupted; resume reattaches known workers")
        except (RuntimeError, ValueError, OSError, InterruptedError) as error:
            result = 2; study.index["last_runner_error"] = {"at": now(), "stage": args.stage, "error": str(error)}
            print(str(error), file=sys.stderr, flush=True)
        finally:
            study.persist(); summarize(study)
            for number, handler in previous.items():
                signal.signal(number, handler)
        return result


if __name__ == "__main__":
    raise SystemExit(main())
