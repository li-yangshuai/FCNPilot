#!/usr/bin/env python3
"""Durable, JSON-only process adapter for Pi. No GUI or LLM dependency."""
import argparse
import csv
from contextlib import ExitStack
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

from ifcn_agent_frontend import normalize_verilog
from ifcn_agent_clock_validation import clock_arrival_report
import ifcn_agent_sequential as sequential
from ifcn_algorithm_catalog import algorithm_catalog

ROOT = Path(__file__).resolve().parents[1]
from verify_routed_logic import audit_case
STAGES = ("parse", "pnr", "map", "simulate", "energy")
ALGORITHMS = ("normal_2ddwave", "compact", "june_random", "regular_clock_ga")
DEFAULT_AUTO_ALGORITHMS = ("normal_2ddwave", "compact", "june_random")
CLOCK_SCHEMES = ("2DDWave", "USE", "RES", "irregular")
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
    build = Path(os.environ.get("IFCN_BUILD_DIR", str(ROOT / "build"))).resolve()
    return {"root": str(ROOT), "build_dir": str(build),
            "python": os.environ.get("IFCN_PYTHON", str(ROOT / ".venv/bin/python") if (ROOT / ".venv/bin/python").is_file() else sys.executable),
            "backend": str(ROOT / "scripts/ifcn_agent_backend.py"),
            "energy_binary": str(build / "ifcn_energy_analysis"),
            "simulation_binary": str(build / "ifcn_physical_benchmark"),
            "mapping_binary": str(build / "ifcn_mapping_metrics"),
            "native_pnr_binary": os.environ.get("IFCN_NATIVE_PNR", str(build / "ifcn_combinational_pnr")),
            "sequential_pnr_binary": str(build / "ifcn_sequential_cyclic_pnr"),
            "regular_pnr_binary": str(build / "ifcn_regular_clock_pnr"),
            "yosys_binary": sequential.find_yosys(ROOT)}


def algorithm_capabilities(config):
    native = Path(config.get("native_pnr_binary", ""))
    regular = Path(config.get("regular_pnr_binary", ""))
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
         "description": "Native Graphviz placement, four-direction routing and post-route phase assignment"},
        {"id":"regular_clock_ga", "available":python_ready and regular.is_file() and os.access(regular, os.X_OK),
         "clock_scheme":"configurable", "clock_schemes":["2DDWave","USE","RES"], "seed_control":"exposed",
         "description":"Small-circuit placement search under a fixed supported regular clock template; hard route, clock and mapping validation"}]


def doctor(deep=False):
    config = configuration()
    algorithms = algorithm_capabilities(config)
    seq = sequential.capabilities(config)
    algorithms.append({"id":"sequential_cyclic", "available":seq["available"],
        "clock_scheme":"irregular", "design_type":"sequential", "seed_control":"not_exposed_by_native_algorithm",
        "description":"State-preserving cyclic routing with global phase/epoch constraints; uncharacterized state device"})
    checks = {key: Path(config[key]).is_file() and os.access(config[key], os.X_OK)
              for key in ("python", "energy_binary", "simulation_binary", "mapping_binary")}
    report = {"schema": "ifcn.pi.capabilities.v1", "configuration": config, "checks": checks,
              "stages": list(STAGES), "phase_count": 4,
              "algorithms": algorithms, "algorithm_catalog": algorithm_catalog(algorithms, sequential_available=seq["available"]),
              "default_algorithm": "normal_2ddwave",
              "auto_policy": {"order": list(DEFAULT_AUTO_ALGORITHMS), "respects_clock_scheme":True, "stop": "first validated layout",
                              "budget": "shared P&R timeout, divided among remaining available attempts",
                              "optimizes_area": "bounded_within_backend_nonregressing_area_and_qca_cells"},
              "experimental_backends": {"genetic": "regular_clock_ga", "gcn_ppo": "not_integrated", "memory_policy": "not_integrated"},
              "combinational": {"supported": True, "input": "Single-module scalar assign netlist; ~ & | ^ and parentheses; ANSI/non-ANSI scalar ports"},
              "sequential": seq,
              "scale_policy": {"metric":"dag_gate_nodes", "small_max":50, "medium_max":500,
                  "note":"Workspace bins count non-input logic DAG nodes, not a capacity guarantee. Sequential size uses the state-cut DAG; state bits are reported separately."},
              "functional_signoff": "not_provided", "deep_probe": "not_requested"}
    report["layout_optimization"] = {
        "available":(Path(config["build_dir"])/"ifcn_layout_edit").is_file(),
        "action":"ifcn_run optimize", "policies":["llm","noop","random","heuristic"],
        "design_type":"combinational", "algorithms":["compact","june_random"], "clock_scheme":"irregular",
        "requires":"Current cycle-zero clock, actual QCA physical-route and exhaustive source/DAG certificates",
        "limits":{"nodes":50,"routes":100,"rounds":8,"operations_per_round":3},
        "model":"Current Pi session model proposes node moves/swaps; deterministic routing and phase solving execute them",
        "acceptance":"Both gate-grid area and actual QCA cells non-increasing; at least one strict improvement after all checks",
        "artifacts":["campaign.json","environment.json","rounds/<n>/request.json","rounds/<n>/response.json"],
        "fixed_clock_and_sequential":"not_supported_by_this_experiment", "device_waveform_signoff":False}
    report["logic_validation"] = {"method": "exhaustive scalar source vs routed DAG", "max_inputs": 11,
                                  "unverifiable_small_input": "reject candidate", "larger_input": "explicitly not performed"}
    report["device_interface_validation"] = "Require declared input/output terminal counts before accepting a P&R candidate; not a waveform correctness proof"
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


def tail(path, limit=3000, start_offset=0):
    if not path.is_file():
        return ""
    with path.open("rb") as stream:
        stream.seek(max(start_offset, 0, path.stat().st_size - limit))
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
        until = until or manifest.get("requested_until") or ("map" if manifest.get("design_type") == "sequential" else "energy")
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



def resolve_design_selection(design_type, algorithm=None, clock=None):
    if clock is not None and clock not in CLOCK_SCHEMES:
        raise ValueError("Unsupported clock scheme; select 2DDWave, USE, RES or irregular.")
    if design_type == "sequential":
        if algorithm not in (None, "sequential_cyclic") or clock not in (None, "irregular"):
            raise ValueError("Sequential design requires state-aware sequential_cyclic routing and post-layout clock assignment.")
        return "sequential_cyclic", "irregular"
    if algorithm == "sequential_cyclic":
        raise ValueError("Use sequential_cyclic only for sequential design.")
    algorithm = algorithm or ("regular_clock_ga" if clock in ("USE", "RES") else "compact" if clock == "irregular" else "normal_2ddwave")
    if algorithm == "auto":
        return algorithm, clock
    allowed = {"normal_2ddwave":("2DDWave",), "compact":("irregular",), "june_random":("irregular",),
               "regular_clock_ga":("2DDWave","USE","RES")}
    if algorithm not in allowed or clock is not None and clock not in allowed[algorithm]:
        raise ValueError("Selected algorithm does not support the requested clock scheme; no silent clock fallback is allowed.")
    return algorithm, clock or allowed[algorithm][0]


def pnr_candidates(algorithm, clock=None):
    if algorithm != "auto":
        return [algorithm]
    if clock is None:
        return list(DEFAULT_AUTO_ALGORITHMS)
    return {"2DDWave":["normal_2ddwave","regular_clock_ga"], "USE":["regular_clock_ga"],
            "RES":["regular_clock_ga"], "irregular":["compact","june_random"]}[clock]

def create_run(args, base):
    source = Path(args.input).resolve()
    if not source.is_file():
        raise ValueError(f"Input file not found: {source}")
    if source.stat().st_size > 2_000_000:
        raise ValueError("Input exceeds the first-version 2 MB limit.")
    original = source.read_bytes()
    design_type = getattr(args, "design_type", "combinational")
    args.until = args.until or ("map" if design_type == "sequential" else "energy")
    args.algorithm, selected_clock = resolve_design_selection(design_type, args.algorithm, getattr(args, "clock", None))
    if design_type == "sequential":
        if re.search(r"`\s*(include|define)", original.decode("utf-8-sig")):
            raise ValueError("Sequential input must be self-contained RTL without include/define dependencies.")
        normalized, frontend = None, {"design_type":"sequential", "frontend":"pending_yosys_seqir"}
    else:
        normalized, frontend = normalize_verilog(original.decode("utf-8-sig"))
    config = configuration()
    base.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    path = run_path(base, run_id)
    path.mkdir(mode=0o700)
    (path / "source.v").write_bytes(original)
    if normalized is not None:
        (path / "normalized.v").write_text(normalized)
    manifest = {"schema": SCHEMA, "run_id": run_id, "created_at": now(), "updated_at": now(),
                "status": "created", "current_stage": None, "source": str(source), "design_type": design_type,
                "configuration": config, "frontend": frontend,
                "parameters": {"seed": args.seed, "timeout_s": args.timeout, "model": args.model,
                               "algorithm": args.algorithm, "clock_scheme":selected_clock,
                               "samples": args.samples, "energy_profile": args.energy_profile,
                               **({"ii_candidates":getattr(args, "ii_candidates", "4,8,12,16,24,32,48,64")} if design_type == "sequential" else {})},
                "stages": {}, "artifacts": {}, "metrics": {},
                "validation": {"rtl_equivalence": "not_performed", "physical_function": "not_verified",
                               "simulation_comparison": "baseline_vs_accelerated_only",
                               "energy": "model_estimate; not a power signoff"}}
    for name in (("source.v", "normalized.v") if normalized is not None else ("source.v",)):
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


def execute(command, path, step, manifest, timeout_s=None, env_extra=None, input_path=None, output_path=None):
    entry = manifest["stages"][step]
    entry.setdefault("commands", []).append([str(arg) for arg in command])
    write_json(path / "manifest.json", manifest)
    log_path = path / entry["log"]
    with ExitStack() as streams, log_path.open("ab") as log:
        # Only this process may supply a retry diagnostic. Earlier commands
        # remain in the stage log but cannot turn a silent failure into UNSAT.
        command_log_offset = log.tell()
        env = backend_environment(path)
        if env_extra:
            env.update(env_extra)
        if manifest["configuration"].get("build_dir"):
            env["IFCN_BUILD_DIR"] = manifest["configuration"]["build_dir"]
        if manifest["configuration"].get("mapping_binary"):
            env["IFCN_MAPPING_METRICS_EXE"] = manifest["configuration"]["mapping_binary"]
        if manifest["configuration"].get("native_pnr_binary"):
            env["IFCN_NATIVE_PNR"] = manifest["configuration"]["native_pnr_binary"]
        if manifest["configuration"].get("regular_pnr_binary"):
            env["IFCN_REGULAR_PNR"] = manifest["configuration"]["regular_pnr_binary"]
        input_stream = streams.enter_context(Path(input_path).open("rb")) if input_path else subprocess.DEVNULL
        output_stream = streams.enter_context(Path(output_path).open("wb")) if output_path else log
        child = subprocess.Popen([str(arg) for arg in command], cwd=path, env=env,
                                 stdin=input_stream, stdout=output_stream, stderr=log, start_new_session=True)
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
            raise RuntimeError(f"{step} command exited with {child.returncode}. {tail(log_path, 1400, start_offset=command_log_offset)}")


def check_pnr(summary):
    clock_ok = (summary.get("clock_legal") is True and summary.get("validation", {}).get("passed") is True
                if "clock_legal" in summary else summary.get("clock_template_ok") is True)
    if summary.get("layout_legal") is not True or summary.get("failed_edge_count") != 0 or not clock_ok:
        raise ValueError("P&R legality check failed; no downstream stage will run.")


def logic_report(source, dag, output):
    report = audit_case(source, dag, max_inputs=11)
    write_json(output, report)
    if report["status"] != "equivalent" and report.get("reason_code") != "input_limit_exceeded":
        raise ValueError(f"Routed logic validation {report['status']}: {report.get('reason', 'See logic.json for counterexamples')}")
    return report


def qca_interface_report(qca, frontend, output):
    content = qca.read_text()
    functions = re.findall(r"(?m)^cell_function=(QCAD_CELL_INPUT|QCAD_CELL_OUTPUT)\s*$", content)
    report = {"schema": "ifcn.qca.interface.v1", "qca_sha256": digest(qca),
              "cell_count": content.count("[TYPE:QCADCell]"),
              "expected_inputs": len(frontend["inputs"]), "expected_outputs": len(frontend["outputs"]),
              "actual_inputs": functions.count("QCAD_CELL_INPUT"), "actual_outputs": functions.count("QCAD_CELL_OUTPUT"),
              "scope": "Declared input/output terminal counts and nonempty device; not signal timing or waveform equivalence"}
    report["passed"] = (report["cell_count"] > 0 and report["actual_inputs"] == report["expected_inputs"]
                        and report["actual_outputs"] == report["expected_outputs"])
    write_json(output, report)
    if not report["passed"]:
        raise ValueError(f"QCA interface incomplete: expected {report['expected_inputs']} inputs/{report['expected_outputs']} outputs, "
                         f"got {report['actual_inputs']} inputs/{report['actual_outputs']} outputs; see interface.json.")
    return report



def physical_route_report(certificate, qca, interface, output, ifcn):
    report = {"schema":"ifcn.qca.physical_routes.v1", "passed":False, "qca_sha256":digest(qca)}
    required = {"ordered_route_continuity", "source_site_isolation", "layer_transition_columns", "route_site_coverage", "gate_connection_ports"}
    try:
        native = json.loads(Path(certificate).read_text())
        if native.get("schema") != report["schema"] or native.get("passed") is not True:
            raise ValueError("Strict physical route certificate is missing or failed")
        if not required.issubset(native.get("checks", [])):
            raise ValueError("Physical route certificate does not cover the required checks")
        if native.get("cell_count") != interface["cell_count"]:
            raise ValueError("Physical route certificate count disagrees with the actual QCA file")
        if any(not isinstance(native.get(key), int) or isinstance(native.get(key), bool) or native[key] <= 0
               for key in ("net_count", "route_count", "cell_count")):
            raise ValueError("Physical route certificate has an empty or malformed routed network")
        report.update(native)
        report["qca_sha256"] = digest(qca)
        report["ifcn_sha256"] = digest(ifcn)
    except (ValueError, TypeError, OSError) as exc:
        report["error"] = str(exc)
        report["passed"] = False
    write_json(output, report)
    if not report["passed"]:
        raise ValueError("Exported QCA failed strict physical route certification; see physical.json")
    return report


def record_logic(manifest, report):
    manifest["metrics"]["logic"] = {key: report[key] for key in
                                   ("status", "max_inputs", "vectors_checked", "expected_vector_count") if key in report}
    manifest["validation"]["rtl_equivalence"] = ("exhaustive_scalar_source_vs_routed_dag" if report["status"] == "equivalent"
                                                  else "not_performed_input_limit_exceeded")


def layout_variants(algorithm):
    if algorithm == "normal_2ddwave":
        return [("original", ["--initial-placement", "original"]), ("source_order_transposed", ["--initial-placement", "transposed"])]
    if algorithm == "june_random":
        return [("layer_redundancy_buffers", ["--topology", "layer_redundancy_buffers"]),
                ("optimized_buffers", ["--topology", "optimized_buffers"])]
    return [("default", [])]


def run_pnr(directory, path, manifest):
    config, params = manifest["configuration"], manifest["parameters"]
    requested = params.get("algorithm", "normal_2ddwave")
    available = {item["id"]: item["available"] for item in algorithm_capabilities(config)}
    candidates = pnr_candidates(requested, params.get("clock_scheme"))
    attempts = []
    eligible = [name for name in candidates if available.get(name)]
    for name in candidates:
        if name not in eligible:
            attempts.append({"algorithm": name, "status": "unavailable", "reason": "Required backend executable is unavailable"})
    deadline = time.monotonic() + params["timeout_s"]
    selected, selected_variant, incumbent = None, None, None
    try:
        for index, algorithm in enumerate(eligible):
            remaining = deadline - time.monotonic()
            budget = max(0, remaining / (len(eligible) - index))
            algorithm_deadline = time.monotonic() + budget
            for variant, flags in layout_variants(algorithm):
                if STOP or (path / "cancel.request").exists():
                    raise InterruptedError("Cancellation requested.")
                left = algorithm_deadline - time.monotonic()
                if left < 1:
                    attempts.append({"algorithm":algorithm,"variant":variant,"status":"budget_exhausted"})
                    break
                number = len(attempts) + 1
                target = directory / f"{number:02d}_{algorithm}_{variant}"
                target.mkdir()
                attempt = {"algorithm":algorithm,"variant":variant,"status":"running","budget_s":round(left,3),
                           "started_at":now(),"directory":str(target.relative_to(path))}
                attempts.append(attempt)
                begin = time.monotonic()
                try:
                    candidate_input = artifact_path(path, manifest["artifacts"]["normalized.v"])
                    if variant == "source_order_transposed":
                        normalized, _ = normalize_verilog(artifact_path(path, manifest["artifacts"]["source.v"]).read_text(), source_order=True)
                        candidate_input = target / "placement_input.v"
                        candidate_input.write_text(normalized)
                        register_artifact(path, manifest, f"pnr_attempts/{number:02d}_{algorithm}_{variant}_input.v", candidate_input)
                    execute([config["python"], config["backend"], "pnr", "--input",
                             candidate_input, "--output", target,
                             "--algorithm", algorithm, "--seed", params["seed"], "--budget", min(240,max(1,int(left)-2)),
                             *(["--clock",params["clock_scheme"]] if params.get("clock_scheme") else []), *flags],
                            path, "pnr", manifest, timeout_s=left)
                    summary = json.loads((target / "pnr.json").read_text())
                    check_pnr(summary)
                    if summary.get("algorithm", algorithm) != algorithm:
                        raise ValueError("P&R reported a different algorithm than requested.")
                    if params.get("clock_scheme") and summary.get("clock_scheme") != params["clock_scheme"]:
                        raise ValueError("P&R reported a different clock scheme than requested.")
                    logic = logic_report(artifact_path(path, manifest["artifacts"]["source.v"]),
                                         target / "routed_dag.json", target / "logic.json")
                    clock = clock_arrival_report(summary["ifcn"], target / "routed_dag.json", target / "clock.json")
                    left = algorithm_deadline - time.monotonic()
                    if left <= 0:
                        raise TimeoutError("P&R candidate exhausted its budget before interface validation.")
                    execute([config["energy_binary"], summary["ifcn"], target / "interface_check", "--qca-only"],
                            path, "pnr", manifest, timeout_s=left)
                    validated_qca = target / "interface_check_energy_input.qca"
                    interface = qca_interface_report(validated_qca, manifest["frontend"], target / "interface.json")
                    physical = physical_route_report(target / "interface_check_physical_validation.json", validated_qca, interface, target / "physical.json", Path(summary["ifcn"]))
                    area, cells = summary["area_tiles"], interface["cell_count"]
                    attempt.update(status="completed", area_tiles=area, qca_cells=cells)
                    # Preserve a fully checked incumbent. A smaller grid alone
                    # must never win at the cost of more actual device cells.
                    dominates = (incumbent is None or
                                 area <= incumbent["area"] and cells <= incumbent["cells"] and
                                 (area < incumbent["area"] or cells < incumbent["cells"]))
                    if dominates:
                        incumbent = {"area":area,"cells":cells,"summary":summary,"logic":logic,"interface":interface,
                                     "target":target,"qca":validated_qca,"attempt":attempt,"clock":clock,"physical":physical}
                        selected, selected_variant = algorithm, variant
                    else:
                        attempt["selection_reason"] = "Does not improve area and actual device count without regression"
                except InterruptedError:
                    attempt["status"] = "cancelled"
                    raise
                except Exception as exc:
                    attempt.update(status="failed", error=str(exc))
                finally:
                    attempt["elapsed_s"] = round(time.monotonic()-begin,3)
                    for report_name in ("pnr", "logic", "clock", "physical", "interface"):
                        file = target / f"{report_name}.json"
                        if file.is_file() and file.stat().st_size:
                            register_artifact(path, manifest, f"pnr_attempts/{number:02d}_{algorithm}_{variant}_{report_name}.json", file)
            if incumbent is not None:
                break
        if incumbent is None:
            raise RuntimeError("No algorithm produced a validated layout; inspect pnr_attempts.json and stage log.")
        if STOP or (path / "cancel.request").exists():
            raise InterruptedError("Cancellation requested.")
        summary, target = incumbent["summary"], incumbent["target"]
        incumbent["attempt"]["selected"] = True
        record_logic(manifest, incumbent["logic"])
        manifest["validation"]["physical_routes"] = "source_isolation_and_ordered_paths_passed"
        manifest["metrics"]["physical_routes"] = incumbent["physical"]
        manifest["validation"]["clock_arrival"] = "cycle_zero_at_template_phase_passed"
        manifest["metrics"]["clock_arrival"] = incumbent["clock"]
        manifest["validation"]["device_terminal_counts"] = "match_source_declarations"
        for name, file in (("layout.ifcn",Path(summary["ifcn"])),("pnr.json",target/"pnr.json"),
                           ("routed_dag.json",target/"routed_dag.json"),("logic.json",target/"logic.json"),
                           ("interface.json",target/"interface.json"),("clock.json",target/"clock.json"),("physical.json",target/"physical.json"),("validated_device.qca",incumbent["qca"])):
            register_artifact(path,manifest,name,file)
        if (target/"layout_candidate.json").is_file():
            register_artifact(path,manifest,"layout_candidate.json",target/"layout_candidate.json")
        for file in sorted(target.iterdir()):
            if file.is_file() and file.suffix in {".svg",".tex"}:
                register_artifact(path,manifest,f"pnr/{file.name}",file)
        manifest["metrics"]["pnr"] = summary
        manifest["metrics"]["device_interface"] = incumbent["interface"]
    except InterruptedError:
        selected, selected_variant = None, None
        raise
    finally:
        report = {"requested_algorithm":requested,"requested_clock":params.get("clock_scheme"),
                  "selected_algorithm":selected,"selected_variant":selected_variant,
                  "policy":"First validated backend; bounded variants replace the valid baseline only when area and actual QCA cell count do not increase and at least one decreases; no global optimality claim",
                  "attempts":attempts}
        write_json(directory/"pnr_attempts.json",report)
        register_artifact(path,manifest,"pnr_attempts.json",directory/"pnr_attempts.json")
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
    if manifest.get("design_type") == "sequential" and step in {"parse", "pnr", "map"}:
        return sequential.run_stage(sys.modules[__name__], step, directory, path, manifest)
    if manifest.get("design_type") != "sequential" and step in {"map", "simulate", "energy"}:
        validation = manifest.get("validation", {})
        if (validation.get("clock_arrival") != "cycle_zero_at_template_phase_passed" or
                validation.get("physical_routes") != "source_isolation_and_ordered_paths_passed"):
            raise ValueError("This run lacks current clock-arrival and physical-route certification; start a new design run before continuing downstream.")
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
        if "validated_device.qca" in artifacts:
            shutil.copyfile(get("validated_device.qca"), directory / "device_energy_input.qca")
        else:
            run([config["energy_binary"], get("layout.ifcn"), directory / "device", "--qca-only"])
        interface = qca_interface_report(directory / "device_energy_input.qca", manifest["frontend"], directory / "interface.json")
        add("interface.json", "interface.json")
        add("device.qca", "device_energy_input.qca")
        manifest["metrics"]["mapping"] = {"cell_count": interface["cell_count"],
                                             "io_contraction": False}
        manifest["metrics"]["device_interface"] = interface
        manifest["validation"]["device_terminal_counts"] = "match_source_declarations"
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
              "design_type": manifest.get("design_type", "combinational"),
              "error": manifest.get("error"), "parameters": manifest["parameters"],
              "completed_stages": [name for name, item in manifest["stages"].items() if item["status"] == "completed"],
              "metrics": manifest["metrics"], "validation": manifest["validation"],
              "warnings": manifest.get("warnings", []), "sources": sources,
              "metric_sources": {"dag": "dag.json", "pnr": "pnr.json", "algorithm_selection": "pnr_attempts.json",
                                 "logic": "logic.json", "device_interface": "interface.json",
                                  "clock_arrival": "clock.json", "physical_routes": "physical.json",
                                 "mapping.cell_count": "device.qca (counted by backend)",
                                 "simulation": "simulation.json", "energy": "energy.json",
                                  "sequential":"sequential_pnr.json", "state_transition":"sequential_validation.json"},
              "units": {"pnr.width": "gate-level tiles", "pnr.height": "gate-level tiles", "pnr.area_tiles": "gate-level tile positions",
                        "mapping.cell_count": "QCA device cells"},
              "reporting_rule": "Attribute metrics to the backend and the listed source. A listed file is not evidence that the LLM read it. Source/DAG Boolean equivalence and terminal counts do not prove device waveforms. Numerical engine agreement is not converged power."}
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
    if manifest.get("optimization") and manifest["optimization"].get("status") != "completed":
        from ifcn_layout_optimization import run_worker as optimize_worker
        return optimize_worker(sys.modules[__name__],path,fd)
    manifest.update(status="running", worker_pid=os.getpid(), updated_at=now())
    write_json(path / "manifest.json", manifest)
    try:
        verify_artifacts(path, manifest)
        # Legacy runs can resume, but their completed P&R/mapping stages do not
        # automatically satisfy the newly added correctness gates.
        if (manifest.get("design_type") != "sequential"
                and STAGES.index(manifest["requested_until"]) >= STAGES.index("pnr")
                and manifest["stages"].get("pnr", {}).get("status") == "completed"):
            get = lambda name: artifact_path(path, manifest["artifacts"][name])
            report = logic_report(get("source.v"), get("routed_dag.json"), path / "resumed_logic.json")
            register_artifact(path, manifest, "logic.json", path / "resumed_logic.json")
            record_logic(manifest, report)
            required_checks = {"clock_arrival":"cycle_zero_at_template_phase_passed",
                               "physical_routes":"source_isolation_and_ordered_paths_passed"}
            if (any(manifest.get("validation",{}).get(k) != v for k,v in required_checks.items()) or
                    not {"clock.json","physical.json"}.issubset(manifest["artifacts"])):
                raise ValueError("This historical run lacks current clock-arrival/physical-route certificates; start a new run for current design-rule validation.")
            clock = clock_arrival_report(get("layout.ifcn"),get("routed_dag.json"),path/"resumed_clock.json")
            register_artifact(path,manifest,"clock.json",path/"resumed_clock.json")
            manifest["metrics"]["clock_arrival"] = clock
            qca_name = ("device.qca" if manifest["stages"].get("map", {}).get("status") == "completed"
                        else "validated_device.qca" if "validated_device.qca" in manifest["artifacts"] else None)
            if qca_name:
                report = qca_interface_report(get(qca_name), manifest["frontend"], path / "resumed_interface.json")
                register_artifact(path, manifest, "interface.json", path / "resumed_interface.json")
                manifest["metrics"]["device_interface"] = report
                manifest["validation"]["device_terminal_counts"] = "match_source_declarations"
                physical = json.loads(get("physical.json").read_text())
                if (physical.get("qca_sha256") != digest(get(qca_name)) or
                        physical.get("ifcn_sha256") != digest(get("layout.ifcn"))):
                    raise ValueError("Physical-route certificate is not bound to the current IFCN/QCA files")
                physical = physical_route_report(get("physical.json"),get(qca_name),report,path/"resumed_physical.json",get("layout.ifcn"))
                register_artifact(path,manifest,"physical.json",path/"resumed_physical.json")
                manifest["metrics"]["physical_routes"] = physical
            elif manifest["requested_until"] == "pnr":
                raise ValueError("Legacy P&R has no device-interface evidence; resume through map to validate it, or start a new run.")
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
        result_status = "completed_with_warnings" if warning else "completed"
        if manifest.get("design_type") == "sequential" and manifest["requested_until"] in {"pnr", "map"}:
            result_status = "layout_candidate"
        manifest.update(status=result_status, error=None)
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


def ii_candidates(value):
    try:
        numbers = [int(item) for item in value.split(",")]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("II candidates must be comma-separated integers") from exc
    if not numbers or len(numbers) > 16 or any(n < 1 or n > 4096 for n in numbers):
        raise argparse.ArgumentTypeError("Provide 1..16 II candidates, each in 1..4096")
    return ",".join(str(n) for n in dict.fromkeys(numbers))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-dir", default=os.environ.get("IFCN_RUNS_DIR", str(ROOT / "output/pi-runs")))
    commands = parser.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("doctor")
    probe.add_argument("--deep", action="store_true")
    start = commands.add_parser("start")
    start.add_argument("input")
    start.add_argument("--until", choices=STAGES)
    start.add_argument("--design-type", choices=["combinational", "sequential"], default="combinational")
    start.add_argument("--ii-candidates", type=ii_candidates, default="4,8,12,16,24,32,48,64")
    start.add_argument("--seed", type=int, default=1)
    start.add_argument("--algorithm", choices=(*ALGORITHMS, "sequential_cyclic", "auto"))
    start.add_argument("--clock", choices=CLOCK_SCHEMES)
    start.add_argument("--timeout", type=positive, default=600)
    start.add_argument("--samples", type=positive, default=512)
    start.add_argument("--model", choices=["bistable", "coherence", "both"], default="bistable")
    start.add_argument("--energy-profile", choices=["preview", "standard"], default="standard")
    start.add_argument("--vectors")
    optimize = commands.add_parser("optimize")
    optimize.add_argument("run_id")
    optimize.add_argument("--policy", choices=("llm","random","noop","heuristic"), default="llm")
    optimize.add_argument("--rounds", type=int, default=3)
    optimize.add_argument("--seed", type=int, default=1)
    optimize.add_argument("--candidate-timeout", type=int, default=20)
    optimize.add_argument("--model-timeout", type=int, default=60)
    optimize.add_argument("--provider")
    optimize.add_argument("--model-id")
    optimize.add_argument("--until", choices=("map",), default="map")
    for name in ("status", "cancel", "resume", "read", "worker"):
        cmd = commands.add_parser(name)
        cmd.add_argument("run_id")
        if name == "resume":
            cmd.add_argument("--until", choices=STAGES)
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
        elif args.command == "optimize":
            from ifcn_layout_optimization import create_run as create_optimization
            result = create_optimization(sys.modules[__name__],args,base)
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
