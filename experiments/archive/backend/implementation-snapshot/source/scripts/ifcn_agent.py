#!/usr/bin/env python3
"""Durable, JSON-only process adapter for Pi. No GUI or LLM dependency."""
import argparse
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from ifcn_agent_frontend import normalize_verilog

ROOT = Path(__file__).resolve().parents[1]
STAGES = ("parse", "pnr", "map", "simulate", "energy")
ALGORITHMS = ("normal_2ddwave", "compact", "june_random")
SCHEMA = "ifcn.pi.run.v1"
STOP = False


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def configuration():
    build = Path(os.environ.get("IFCN_BUILD_DIR", str(ROOT / "build-release"))).resolve()
    return {"root": str(ROOT), "build_dir": str(build),
            "python": os.environ.get("IFCN_PYTHON", str(ROOT / "include/gcn_rl_layout/myenv/bin/python")),
            "backend": str(ROOT / "scripts/ifcn_agent_backend.py"),
            "energy_binary": str(build / "ifcn_energy_analysis"),
            "simulation_binary": str(build / "ifcn_physical_benchmark"),
            "mapping_binary": str(build / "ifcn_mapping_metrics"),
            "native_pnr_binary": os.environ.get("IFCN_NATIVE_PNR", str(build / "ifcn_combinational_pnr"))}


def algorithm_capabilities(config):
    native = Path(config.get("native_pnr_binary", ""))
    python = Path(config["python"])
    python_ready = python.is_file() and os.access(python, os.X_OK)
    native_ready = python_ready and native.is_file() and os.access(native, os.X_OK)
    return [
        {"id": "normal_2ddwave", "available": python_ready,
         "clock_scheme": "2DDWave", "seed_control": "exposed",
         "description": "Graphviz/sifting placement, fixed four-phase 2DDWave routing and compaction"},
        {"id": "compact", "available": native_ready,
         "clock_scheme": "irregular", "seed_control": "not_exposed_by_native_algorithm",
         "description": "Native Compact Graph with bounded adaptive expansion and compaction"},
        {"id": "june_random", "available": native_ready,
         "clock_scheme": "irregular", "seed_control": "not_exposed_by_native_algorithm",
         "description": "Native Graphviz placement, four-direction routing and post-route phase assignment"}]


def doctor(deep=False):
    config = configuration()
    checks = {key: Path(config[key]).is_file() and os.access(config[key], os.X_OK)
              for key in ("python", "energy_binary", "simulation_binary", "mapping_binary")}
    report = {"schema": "ifcn.pi.capabilities.v1", "configuration": config, "checks": checks,
              "stages": list(STAGES), "phase_count": 4,
              "algorithms": algorithm_capabilities(config), "default_algorithm": "normal_2ddwave",
              "auto_policy": {"order": list(ALGORITHMS), "stop": "first validated layout",
                              "budget": "shared P&R timeout, divided among remaining available attempts",
                              "optimizes_area": False},
              "experimental_backends": {"genetic": "not_integrated", "gcn_ppo": "not_integrated", "memory_policy": "not_integrated"},
              "combinational": {"supported": True, "input": "Single-module scalar assign netlist; ~ & | ^ and parentheses; ANSI/non-ANSI scalar ports"},
              "sequential": {"supported": False, "status": "reserved", "reference": str(ROOT / "handoff.md")},
              "functional_signoff": "not_provided", "deep_probe": "not_requested"}
    if deep and checks["python"]:
        with tempfile.TemporaryDirectory(prefix="ifcn-probe-") as tmp:
            env = backend_environment(Path(tmp))
            try:
                probe = subprocess.run([config["python"], config["backend"], "probe", "--output", tmp],
                                       capture_output=True, text=True, timeout=60, env=env)
                checks["python_imports"] = probe.returncode == 0 and "IFCN_BACKEND_READY" in probe.stdout
                report["deep_probe"] = (probe.stdout + probe.stderr)[-3000:]
            except (OSError, subprocess.TimeoutExpired) as exc:
                checks["python_imports"] = False
                report["deep_probe"] = str(exc)
    report["ready"] = all(checks.values())
    return report


def run_path(base, run_id):
    if not re.fullmatch(r"[0-9a-f]{32}", run_id):
        raise ValueError("Invalid run id.")
    path = (base / run_id).resolve()
    if path.parent != base.resolve():
        raise ValueError("Run path escapes the run directory.")
    return path


def load_run(path):
    value = json.loads((path / "manifest.json").read_text())
    if value.get("schema") != SCHEMA:
        raise ValueError("Unsupported run manifest schema.")
    return value


def lock_run(path):
    fd = os.open(path / "run.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise ValueError("This run is already active.")
    return fd


def artifact_path(path, artifact):
    target = (path / artifact["path"]).resolve()
    if not target.is_relative_to(path.resolve()):
        raise ValueError("Artifact path escapes the run directory.")
    return target


def verify_artifacts(path, manifest):
    for key, artifact in manifest["artifacts"].items():
        target = artifact_path(path, artifact)
        if not target.is_file() or digest(target) != artifact["sha256"]:
            raise ValueError(f"Artifact changed or missing: {key}; start a new run.")


def backend_environment(path):
    env = os.environ.copy()
    env.update(MPLBACKEND="Agg", MPLCONFIGDIR=str(path / "matplotlib"),
               IFCN_GCN_RL_PARSE_MODE="compact", IFCN_GRAPHVIZ_TIMEOUT="60",
               IFCN_SIFT_TIMEOUT="20", IFCN_SIFT_EVALUATIONS="200000")
    return env


def tail(path, limit=3000):
    if not path.is_file():
        return ""
    with path.open("rb") as stream:
        stream.seek(max(0, path.stat().st_size - limit))
        return stream.read(limit).decode("utf-8", errors="replace")


def status(path):
    manifest = load_run(path)
    active = False
    try:
        fd = lock_run(path)
        os.close(fd)
    except ValueError:
        active = True
    manifest["active"] = active
    if manifest["status"] in {"queued", "running"} and not active:
        manifest["status"] = "interrupted"
        manifest["error"] = "Worker is no longer active; inspect logs and resume."
    if manifest.get("current_stage"):
        entry = manifest["stages"].get(manifest["current_stage"], {})
        if entry.get("log"):
            manifest["log_tail"] = tail(artifact_path(path, {"path": entry["log"]}))
    manifest["run_directory"] = str(path)
    return manifest


def start_worker(path, until):
    fd = lock_run(path)
    try:
        manifest = load_run(path)
        verify_artifacts(path, manifest)
        manifest.update(status="queued", requested_until=until, error=None, updated_at=now())
        write_json(path / "manifest.json", manifest)
        (path / "cancel.request").unlink(missing_ok=True)
        with (path / "worker.log").open("ab") as stream:
            # Transfer the same flock open-file description to the detached worker.
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--runs-dir", str(path.parent),
                              "worker", manifest["run_id"], "--lock-fd", str(fd)],
                             stdin=subprocess.DEVNULL, stdout=stream, stderr=stream,
                             start_new_session=True, pass_fds=(fd,))
    finally:
        os.close(fd)
    return status(path)


def create_run(args, base):
    source = Path(args.input).resolve()
    if not source.is_file():
        raise ValueError(f"Input file not found: {source}")
    if source.stat().st_size > 2_000_000:
        raise ValueError("Input exceeds the first-version 2 MB limit.")
    original = source.read_bytes()
    normalized, frontend = normalize_verilog(original.decode("utf-8-sig"))
    config = configuration()
    base.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    path = run_path(base, run_id)
    path.mkdir(mode=0o700)
    (path / "source.v").write_bytes(original)
    (path / "normalized.v").write_text(normalized)
    manifest = {"schema": SCHEMA, "run_id": run_id, "created_at": now(), "updated_at": now(),
                "status": "created", "current_stage": None, "source": str(source),
                "configuration": config, "frontend": frontend,
                "parameters": {"seed": args.seed, "timeout_s": args.timeout, "model": args.model,
                               "algorithm": args.algorithm,
                               "samples": args.samples, "energy_profile": args.energy_profile},
                "stages": {}, "artifacts": {}, "metrics": {},
                "validation": {"rtl_equivalence": "not_performed", "physical_function": "not_verified",
                               "simulation_comparison": "baseline_vs_accelerated_only",
                               "energy": "model_estimate; not a power signoff"}}
    for name in ("source.v", "normalized.v"):
        register_artifact(path, manifest, name, path / name)
    if args.vectors:
        vector_source = Path(args.vectors).resolve()
        if not vector_source.is_file():
            raise ValueError("Vector table not found.")
        (path / "vectors.vt").write_bytes(vector_source.read_bytes())
        register_artifact(path, manifest, "vectors.vt", path / "vectors.vt")
    write_json(path / "manifest.json", manifest)
    return start_worker(path, args.until)


def register_artifact(path, manifest, name, target):
    target = target.resolve()
    if not target.is_file() or target.stat().st_size == 0:
        raise ValueError(f"Expected nonempty artifact missing: {target}")
    manifest["artifacts"][name] = {"path": str(target.relative_to(path)),
                                   "bytes": target.stat().st_size, "sha256": digest(target)}


def execute(command, path, step, manifest, timeout_s=None):
    entry = manifest["stages"][step]
    entry.setdefault("commands", []).append([str(arg) for arg in command])
    write_json(path / "manifest.json", manifest)
    log_path = path / entry["log"]
    with log_path.open("ab") as log:
        env = backend_environment(path)
        if manifest["configuration"].get("build_dir"):
            env["IFCN_BUILD_DIR"] = manifest["configuration"]["build_dir"]
        if manifest["configuration"].get("mapping_binary"):
            env["IFCN_MAPPING_METRICS_EXE"] = manifest["configuration"]["mapping_binary"]
        if manifest["configuration"].get("native_pnr_binary"):
            env["IFCN_NATIVE_PNR"] = manifest["configuration"]["native_pnr_binary"]
        child = subprocess.Popen([str(arg) for arg in command], cwd=path, env=env,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        begin = time.monotonic()
        try:
            while child.poll() is None:
                if STOP or (path / "cancel.request").exists():
                    raise InterruptedError("Cancellation requested.")
                if time.monotonic() - begin > (timeout_s or manifest["parameters"]["timeout_s"]):
                    raise TimeoutError(f"{step} exceeded the per-command timeout.")
                time.sleep(0.15)
        finally:
            # Also close any descendant left by an exited native/backend process.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
            # Waiting for the direct child does not wait for grandchildren. A
            # backend may exit while a descendant ignores SIGTERM; the group
            # must be closed on success, failure, timeout, and cancellation.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if child.returncode:
            raise RuntimeError(f"{step} command exited with {child.returncode}. {tail(log_path, 1400)}")


def check_pnr(summary):
    clock_ok = (summary.get("clock_legal") is True and summary.get("validation", {}).get("passed") is True
                if "clock_legal" in summary else summary.get("clock_template_ok") is True)
    if summary.get("layout_legal") is not True or summary.get("failed_edge_count") != 0 or not clock_ok:
        raise ValueError("P&R legality check failed; no downstream stage will run.")


def run_pnr(directory, path, manifest):
    config, params = manifest["configuration"], manifest["parameters"]
    requested = params.get("algorithm", "normal_2ddwave")
    available = {item["id"]: item["available"] for item in algorithm_capabilities(config)}
    candidates = list(ALGORITHMS) if requested == "auto" else [requested]
    attempts = []
    eligible = [name for name in candidates if available.get(name)]
    for name in candidates:
        if name not in eligible:
            attempts.append({"algorithm": name, "status": "unavailable", "reason": "Required backend executable is unavailable"})
    deadline = time.monotonic() + params["timeout_s"]
    selected = None
    try:
        for index, algorithm in enumerate(eligible):
            if STOP or (path / "cancel.request").exists():
                raise InterruptedError("Cancellation requested.")
            remaining = deadline - time.monotonic()
            if remaining < 1:
                attempts.append({"algorithm": algorithm, "status": "budget_exhausted"})
                continue
            budget = max(1, int(remaining / (len(eligible) - index)))
            target = directory / f"{index + 1:02d}_{algorithm}"
            target.mkdir()
            attempt = {"algorithm": algorithm, "status": "running", "budget_s": budget,
                       "started_at": now(), "directory": str(target.relative_to(path))}
            attempts.append(attempt)
            begin = time.monotonic()
            try:
                execute([config["python"], config["backend"], "pnr", "--input",
                         artifact_path(path, manifest["artifacts"]["normalized.v"]), "--output", target,
                         "--algorithm", algorithm, "--seed", params["seed"], "--budget", min(240, max(1, budget - 2))],
                        path, "pnr", manifest, timeout_s=budget)
                summary = json.loads((target / "pnr.json").read_text())
                check_pnr(summary)
                if summary.get("algorithm", algorithm) != algorithm:
                    raise ValueError("P&R reported a different algorithm than requested.")
                for name, file in (("layout.ifcn", Path(summary["ifcn"])),
                                   ("pnr.json", target / "pnr.json"), ("routed_dag.json", target / "routed_dag.json")):
                    register_artifact(path, manifest, name, file)
                for file in sorted(target.iterdir()):
                    if file.is_file() and file.suffix in {".svg", ".tex"}:
                        register_artifact(path, manifest, f"pnr/{file.name}", file)
                manifest["metrics"]["pnr"] = summary
                attempt["status"] = "completed"
                selected = algorithm
                break
            except InterruptedError:
                attempt["status"] = "cancelled"
                raise
            except Exception as exc:
                attempt.update(status="failed", error=str(exc))
                if requested != "auto":
                    raise
            finally:
                attempt["elapsed_s"] = round(time.monotonic() - begin, 3)
                summary_file = target / "pnr.json"
                if summary_file.is_file() and summary_file.stat().st_size:
                    register_artifact(path, manifest, f"pnr_attempts/{index + 1:02d}_{algorithm}.json", summary_file)
        if selected is None:
            raise RuntimeError("No algorithm produced a validated layout; inspect pnr_attempts.json and stage log.")
    finally:
        report = {"requested_algorithm": requested, "selected_algorithm": selected,
                  "policy": "first validated result; no area-optimality claim", "attempts": attempts}
        write_json(directory / "pnr_attempts.json", report)
        register_artifact(path, manifest, "pnr_attempts.json", directory / "pnr_attempts.json")
        manifest["metrics"]["algorithm_selection"] = report


def energy_summary(report, period):
    values = {}
    text = report.read_text()
    section = text.split("[ENERGY_ANALYSIS]", 1)[-1].split("[#ENERGY_ANALYSIS]", 1)[0]
    for line in section.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    if values.get("available", "").lower() not in {"true", "1"}:
        raise ValueError("Energy engine reports no available result.")
    result = {}
    for key in ("cycle_count", "total_bath_eV", "average_bath_eV", "total_bath_clock_eV", "average_bath_clock_eV", "total_error_eV"):
        number = float(values[key])
        if not math.isfinite(number):
            raise ValueError(f"Non-finite energy result: {key}")
        result[key] = number
    if result["cycle_count"] <= 0:
        raise ValueError("Energy engine evaluated no complete cycles.")
    result["average_bath_clock_power_W"] = result["average_bath_clock_eV"] * 1.602176634e-19 / period
    result["power_definition"] = "signed mean (bath + clock) energy per counted cycle / clock period; not total chip power"
    result["clock_period_s"] = period
    cycle_section = text.split("[PER_CYCLE]", 1)[1].split("[#PER_CYCLE]", 1)[0].strip()
    cycle_values = [float(row["E_bath_eV"]) for row in csv.DictReader(cycle_section.splitlines())]
    if len(cycle_values) != int(result["cycle_count"]) or not all(math.isfinite(x) for x in cycle_values):
        raise ValueError("Incomplete or non-finite per-cycle energy values.")
    valid = result["average_bath_eV"] >= 0 and all(x >= 0 for x in cycle_values)
    result["numerical_status"] = "nonnegative_bath_energy" if valid else "invalid_negative_bath_energy"
    result["time_step_convergence"] = "not_tested"
    result["average_dissipated_power_W"] = result["average_bath_eV"] * 1.602176634e-19 / period if valid else None
    result["dissipated_power_definition"] = "mean bath energy per counted cycle / clock period; model estimate; requires time-step convergence and functional validation"
    return result


def run_stage(step, directory, path, manifest):
    config, params = manifest["configuration"], manifest["parameters"]
    artifacts = manifest["artifacts"]
    get = lambda name: artifact_path(path, artifacts[name])
    run = lambda command: execute(command, path, step, manifest)
    add = lambda name, filename: register_artifact(path, manifest, name, directory / filename)
    vectors = ["--vectors", get("vectors.vt")] if "vectors.vt" in artifacts else []
    if step == "parse":
        run([config["python"], config["backend"], step, "--input", get("normalized.v"),
             "--output", directory, "--seed", params["seed"], "--budget", min(240, params["timeout_s"])])
        add("dag.json", "dag.json")
        add("dag.dot", "dag.dot")
        manifest["metrics"]["dag"] = {k: v for k, v in json.loads(get("dag.json").read_text()).items() if k in ("input_count", "output_count")}
    elif step == "pnr":
        run_pnr(directory, path, manifest)
    elif step == "map":
        run([config["mapping_binary"], get("layout.ifcn"), "--no-io-contraction"])
        run([config["energy_binary"], get("layout.ifcn"), directory / "device", "--qca-only"])
        add("device.qca", "device_energy_input.qca")
        manifest["metrics"]["mapping"] = {"cell_count": get("device.qca").read_text().count("[TYPE:QCADCell]"),
                                             "io_contraction": False}
    elif step == "simulate":
        run([config["simulation_binary"], get("device.qca"), "--model", params["model"],
             "--repetitions", 1, "--warmup", 0, "--samples", params["samples"],
             "--require-equivalent", "--json", directory / "simulation.json",
             "--output-prefix", directory / "simulation", *vectors])
        add("simulation.json", "simulation.json")
        comparison = json.loads(get("simulation.json").read_text())
        records = comparison.get("comparisons", [])
        if not records or any(record.get("accuracy", {}).get("comparable") is not True
                              or record["accuracy"].get("output_samples", 0) <= 0
                              or record["accuracy"].get("max_absolute_error") != 0 for record in records):
            raise ValueError("Simulation comparison is incomplete or not exactly equivalent.")
        manifest["metrics"]["simulation"] = [{"model": record["model"],
                                                "max_absolute_error": record["accuracy"]["max_absolute_error"],
                                                "output_samples": record["accuracy"]["output_samples"],
                                                "max_iteration_samples": record.get("work", {}).get("max_iteration_samples")}
                                               for record in records]
        limit_hits = sum(record.get("max_iteration_samples") or 0 for record in manifest["metrics"]["simulation"])
        manifest["validation"]["simulation_iteration_limit_samples"] = limit_hits
        if limit_hits:
            manifest.setdefault("warnings", []).append({"code": "simulation_iteration_limit", "stage": "simulate",
                "message": f"{limit_hits} samples reached the solver iteration limit; engine agreement does not establish convergence."})
        for target in sorted(directory.glob("*.rst")):
            register_artifact(path, manifest, f"simulation/{target.name}", target)
    elif step == "energy":
        options = ["--fast"] if params["energy_profile"] == "preview" else []
        run([config["energy_binary"], get("device.qca"), directory / "analysis", "--waveform", *options, *vectors])
        metrics = energy_summary(directory / "analysis_energy.txt", 1e-11)
        metrics["profile"] = params["energy_profile"]
        metrics["time_step_s"] = 2e-15 if options else 1e-17
        write_json(directory / "energy.json", metrics)
        add("energy.json", "energy.json")
        add("energy.txt", "analysis_energy.txt")
        add("energy.rst", "analysis_energy.rst")
        manifest["metrics"]["energy"] = metrics
        manifest["validation"]["energy_numerics"] = metrics["numerical_status"]


def result_report(path, manifest):
    """A source-linked result for reporting; it does not upgrade the underlying validation."""
    sources = {name: {**artifact, "absolute_path": str(artifact_path(path, artifact))}
               for name, artifact in manifest["artifacts"].items() if name != "result.json"}
    report = {"schema": "ifcn.pi.result.v1", "run_id": manifest["run_id"],
              "status": manifest["status"], "requested_until": manifest.get("requested_until"),
              "error": manifest.get("error"), "parameters": manifest["parameters"],
              "completed_stages": [name for name, item in manifest["stages"].items() if item["status"] == "completed"],
              "metrics": manifest["metrics"], "validation": manifest["validation"],
              "warnings": manifest.get("warnings", []), "sources": sources,
              "metric_sources": {"dag": "dag.json", "pnr": "pnr.json", "algorithm_selection": "pnr_attempts.json",
                                 "mapping.cell_count": "device.qca (counted by backend)",
                                 "simulation": "simulation.json", "energy": "energy.json"},
              "reporting_rule": "Attribute metrics to the backend and the listed source. A listed file is not evidence that the LLM read it. Numerical engine agreement is not RTL/device functional equivalence or converged power."}
    write_json(path / "result.json", report)
    register_artifact(path, manifest, "result.json", path / "result.json")


def worker(path, fd):
    global STOP
    def stop(_number, _frame):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    manifest = load_run(path)
    manifest.update(status="running", worker_pid=os.getpid(), updated_at=now())
    write_json(path / "manifest.json", manifest)
    try:
        verify_artifacts(path, manifest)
        for step in STAGES[:STAGES.index(manifest["requested_until"]) + 1]:
            if STOP or (path / "cancel.request").exists():
                raise InterruptedError("Cancellation requested.")
            previous = manifest["stages"].get(step, {})
            if previous.get("status") == "completed":
                continue
            attempt = previous.get("attempt", 0) + 1
            directory = path / f"{STAGES.index(step) + 1:02d}_{step}_{attempt}"
            directory.mkdir()
            manifest["current_stage"] = step
            manifest["stages"][step] = {"status": "running", "started_at": now(), "attempt": attempt,
                                         "log": str((directory / "stage.log").relative_to(path))}
            write_json(path / "manifest.json", manifest)
            run_stage(step, directory, path, manifest)
            manifest["stages"][step].update(status="completed", completed_at=now())
            manifest["updated_at"] = now()
            write_json(path / "manifest.json", manifest)
        warning = (manifest["metrics"].get("energy", {}).get("numerical_status") == "invalid_negative_bath_energy"
                   or bool(manifest.get("warnings")))
        manifest.update(status="completed_with_warnings" if warning else "completed", error=None)
    except Exception as exc:
        manifest["status"] = "cancelled" if isinstance(exc, InterruptedError) else "failed"
        manifest["error"] = str(exc)
        if manifest.get("current_stage") and manifest["stages"][manifest["current_stage"]].get("status") == "running":
            manifest["stages"][manifest["current_stage"]].update(status=manifest["status"], error=str(exc))
    finally:
        manifest["updated_at"] = now()
        result_report(path, manifest)
        write_json(path / "manifest.json", manifest)
        os.close(fd)


def positive(value):
    number = int(value)
    if not 1 <= number <= 86400:
        raise argparse.ArgumentTypeError("Value must be in 1..86400.")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-dir", default=os.environ.get("IFCN_RUNS_DIR", str(ROOT / "output/pi-runs")))
    commands = parser.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("doctor")
    probe.add_argument("--deep", action="store_true")
    start = commands.add_parser("start")
    start.add_argument("input")
    start.add_argument("--until", choices=STAGES, default="energy")
    start.add_argument("--seed", type=int, default=1)
    start.add_argument("--algorithm", choices=(*ALGORITHMS, "auto"), default="normal_2ddwave")
    start.add_argument("--timeout", type=positive, default=600)
    start.add_argument("--samples", type=positive, default=512)
    start.add_argument("--model", choices=["bistable", "coherence", "both"], default="bistable")
    start.add_argument("--energy-profile", choices=["preview", "standard"], default="standard")
    start.add_argument("--vectors")
    for name in ("status", "cancel", "resume", "read", "worker"):
        cmd = commands.add_parser(name)
        cmd.add_argument("run_id")
        if name == "resume":
            cmd.add_argument("--until", choices=STAGES, default="energy")
        elif name == "read":
            cmd.add_argument("artifact")
        elif name == "worker":
            cmd.add_argument("--lock-fd", type=int, required=True)
    args = parser.parse_args()
    base = Path(args.runs_dir).resolve()
    try:
        if args.command == "doctor":
            result = doctor(args.deep)
        elif args.command == "start":
            result = create_run(args, base)
        else:
            path = run_path(base, args.run_id)
            if args.command == "worker":
                worker(path, args.lock_fd)
                return
            if args.command == "resume":
                result = start_worker(path, args.until)
            elif args.command == "cancel":
                result = status(path)
                if result["active"]:
                    (path / "cancel.request").touch()
                result["cancel_requested"] = result["active"]
            elif args.command == "read":
                manifest = load_run(path)
                artifact = manifest["artifacts"].get(args.artifact)
                if not artifact:
                    raise ValueError("Unknown artifact; use status to list available artifacts.")
                target = artifact_path(path, artifact)
                if digest(target) != artifact["sha256"]:
                    raise ValueError("Artifact hash mismatch.")
                result = {"artifact": args.artifact, "path": str(target), "bytes": target.stat().st_size,
                          "sha256": artifact["sha256"], "hash_verified": True,
                          "content": target.read_bytes()[:24000].decode("utf-8", errors="replace"),
                          "truncated": target.stat().st_size > 24000}
            else:
                result = status(path)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
