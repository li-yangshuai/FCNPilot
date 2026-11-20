"""Durable FCNPilot bridge to the separately configured iFCN research backend.

Construction and frozen-geometry repair remain separate jobs. Neither entrypoint
performs cell-level simulation or resumes the legacy mapping pipeline.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

CONDITIONS = ("path_geometry", "endpoint_window", "clock_window", "no_fanout",
              "centralized", "llm_single", "llm_independent", "llm_negotiated")


def configuration(engine_root):
    root = Path(os.environ.get("IFCN_MULTI_AGENT_ROOT", str(engine_root.parent.parent / "iFCN"))).resolve()
    return {"root": str(root), "binary": str(Path(os.environ.get("IFCN_MULTI_AGENT_BINARY",
            str(root / "build-multi-agent/ifcn_combinational_pnr"))).resolve()),
            "python": os.environ.get("IFCN_MULTI_AGENT_PYTHON", sys.executable),
            "fcnpilot_root": str(engine_root.parent)}


def capabilities(engine_root):
    config = configuration(engine_root)
    required = [Path(config["root"]) / "src/python/ifcn" / name
                for name in ("multi_agent.py", "clock_repair.py", "layout_validation.py")]
    required.append(Path(config["root"]) / "scripts/ifcn_multi_agent_model.mjs")
    binary = Path(config["binary"])
    available = (all(p.is_file() for p in required) and binary.is_file()
                 and os.access(binary, os.X_OK) and shutil.which(config["python"]) is not None)
    return {"available": available, "configuration": config,
            "actions": ["multi_agent", "clock_repair"], "max_nodes": 149,
            "default_max_model_calls": 0, "repair_conditions": list(CONDITIONS),
            "workflow": "Separate construction and frozen-geometry repair jobs; no automatic nesting",
            "artifacts": ["research-summary.json", "candidate.json", "drc.json", "logic.json", "layout.ifcn"],
            "validation": "Native checks plus independent route/global-clock and source-equivalence checks; no QCA waveform or energy signoff",
            "resume": "Not replayed; start a fresh job after interruption or failure"}


def add_commands(commands):
    for mode in ("multi_agent", "clock_repair"):
        p = commands.add_parser(mode, help="Bounded iFCN research job; offline unless model calls are explicitly enabled")
        p.add_argument("input")
        p.add_argument("--budget", type=float, default=60)
        p.add_argument("--max-model-calls", type=int, default=0)
        p.add_argument("--model-timeout", type=float, default=20)
        p.add_argument("--max-model-tokens", type=int, default=512)
        p.add_argument("--provider")
        p.add_argument("--model-id")
        p.add_argument("--z3-root")
        p.add_argument("--validation-timeout", type=float, default=30)
        if mode == "multi_agent":
            p.add_argument("--attempts", type=int, default=64)
            p.add_argument("--max-nodes", type=int, default=149)
        else:
            p.add_argument("--snapshot", required=True)
            p.add_argument("--reference")
            p.add_argument("--condition", choices=CONDITIONS, default="clock_window")
            p.add_argument("--max-evaluations", type=int, default=24)
            p.add_argument("--max-contracts", type=int, default=12)
            p.add_argument("--max-paths", type=int, default=12)
            p.add_argument("--evaluation-seconds", type=float, default=1)
            p.add_argument("--contract-seconds", type=float, default=2)


def validate_options(args):
    for name, upper in (("budget", 86400), ("model_timeout", 300), ("validation_timeout", 300),
                        ("evaluation_seconds", 120), ("contract_seconds", 120)):
        value = getattr(args, name, None)
        if value is not None and (not math.isfinite(value) or not 0 < value <= upper):
            raise ValueError(f"{name} must be positive and at most {upper}")
    for name, low, high in (("max_model_calls", 0, 64), ("max_model_tokens", 64, 4096),
                            ("attempts", 1, 4096), ("max_nodes", 1, 149),
                            ("max_evaluations", 1, 256), ("max_contracts", 1, 128), ("max_paths", 1, 64)):
        value = getattr(args, name, None)
        if value is not None and (type(value) is not int or not low <= value <= high):
            raise ValueError(f"{name} must be an integer in {low}..{high}")
    if bool(args.provider) != bool(args.model_id):
        raise ValueError("Provide both provider and model-id, or neither")
    if args.command == "clock_repair":
        uses_model = args.condition.startswith("llm_")
        if uses_model != (args.max_model_calls > 0):
            raise ValueError("LLM repair conditions require a positive explicit model-call budget; deterministic conditions require zero")


def create_run(api, args, base):
    validate_options(args)
    report = capabilities(api.ROOT)
    if not report["available"]:
        raise ValueError("Research backend unavailable; configure IFCN_MULTI_AGENT_ROOT, IFCN_MULTI_AGENT_BINARY and IFCN_MULTI_AGENT_PYTHON; inspect ifcn_capabilities")
    source = Path(args.input).resolve()
    if not source.is_file() or source.stat().st_size > 2_000_000:
        raise ValueError("Provide an existing self-contained Verilog file of at most 2 MB")
    # Freeze all supplied inputs before scheduling, including repair provenance.
    inputs = {"source.v": source}
    if args.command == "clock_repair":
        inputs["snapshot.json"] = Path(args.snapshot).resolve()
        if args.reference:
            inputs["reference.json"] = Path(args.reference).resolve()
        for name, target in inputs.items():
            if not target.is_file() or target.stat().st_size > 50_000_000:
                raise ValueError(f"Invalid research input: {name}")
        snapshot = json.loads(inputs["snapshot.json"].read_text())
        if not 1 <= len(snapshot.get("nodes", [])) <= 149:
            raise ValueError("Repair requires 1..149 nodes")
    base.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    path = api.run_path(base, run_id)
    path.mkdir(mode=0o700)
    options = {k: v for k, v in vars(args).items() if k not in ("runs_dir", "input", "snapshot", "reference", "command")}
    manifest = {"schema": api.SCHEMA, "run_id": run_id, "created_at": api.now(), "updated_at": api.now(),
                "status": "created", "current_stage": None, "source": str(source), "design_type": "combinational",
                "requested_until": args.command, "configuration": api.configuration(),
                "research": {"mode": args.command, "configuration": report["configuration"], "options": options},
                "parameters": {"algorithm": args.command, "clock_scheme": "irregular", "timeout_s": args.budget,
                               "max_model_calls": args.max_model_calls}, "stages": {}, "artifacts": {}, "metrics": {},
                "validation": {"rtl_equivalence": "not_performed", "layout_model": "not_verified",
                               "physical_function": "not_verified", "energy": "not_performed"}}
    for name, target in inputs.items():
        shutil.copyfile(target, path / name)
        api.register_artifact(path, manifest, name, path / name)
    api.write_json(path / "manifest.json", manifest)
    return api.start_worker(path, args.command)


def _qualify_repair(source, output, candidate_path, options):
    from ifcn.layout_validation import validate_candidate, dag_from_candidate, export_native_ifcn
    from ifcn.verify_logic import verify_bytes
    candidate = json.loads(candidate_path.read_text())
    drc = validate_candidate(candidate, source_crossings=False)
    write(output / "drc.json", drc)
    if not drc.get("passed"):
        return {"layout_validated": False, "qualification": "drc_rejected"}
    write(output / "routed_dag.json", dag_from_candidate(candidate, drc))
    logic = verify_bytes(source.read_bytes(), (output / "routed_dag.json").read_bytes(), max_inputs=11)
    if logic.get("reason_code") == "input_limit_exceeded":
        from ifcn.verify_sat import verify_sat_bytes
        logic = verify_sat_bytes(source.read_bytes(), (output / "routed_dag.json").read_bytes(),
                                 z3_root=options.get("z3_root"), timeout_seconds=options["validation_timeout"])
    write(output / "logic.json", logic)
    if logic.get("status") != "equivalent":
        return {"layout_validated": False, "qualification": "logic_rejected"}
    width, height = export_native_ifcn(candidate, output / "layout.ifcn", "clock-contract-repair")
    return {"layout_validated": True, "qualification": "route_clock_source_equivalence_passed",
            "area_tiles": width * height, "width": width, "height": height,
            "native_metrics": candidate.get("metrics"),
            "route_length": sum(len(route["path"]) - 1 for route in candidate["routes"])}


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def execute_search(job_path):
    job = json.loads(job_path.read_text())
    path = job_path.parent
    config, options, mode = job["configuration"], job["options"], job["mode"]
    root = Path(config["root"])
    sys.path.insert(0, str(root / "src/python"))
    source, output = path / "source.v", path / "search"
    model = f'{options["provider"]}/{options["model_id"]}' if options.get("provider") else None
    begin = time.monotonic()
    if mode == "multi_agent":
        from ifcn.multi_agent import main
        argv = ["--input", str(source), "--output-dir", str(output), "--binary", config["binary"],
                "--fcnpilot-root", config["fcnpilot_root"], "--budget", str(options["budget"]),
                "--attempts", str(options["attempts"]), "--max-nodes", str(options["max_nodes"]),
                "--max-model-calls", str(options["max_model_calls"]), "--model-timeout", str(options["model_timeout"]),
                "--max-model-tokens", str(options["max_model_tokens"]), "--logic-timeout", str(options["validation_timeout"])]
        if model:
            argv += ["--model", model]
        if options.get("z3_root"):
            argv += ["--z3-root", options["z3_root"]]
        main(argv)
        result = json.loads((output / "summary.json").read_text())
    else:
        from ifcn.clock_repair import run_clock_contract_repair
        model_config = None
        if options["max_model_calls"]:
            model_config = {"node": shutil.which("node") or "node", "adapter": str(root / "scripts/ifcn_multi_agent_model.mjs"),
                            "fcnpilot_root": config["fcnpilot_root"], "model": model,
                            "max_calls": options["max_model_calls"], "timeout_seconds": options["model_timeout"],
                            "max_tokens": options["max_model_tokens"]}
        # Source-order normalization is the same frontend used by the research workflow.
        from ifcn.frontend import normalize_verilog
        normalized, _ = normalize_verilog(source.read_text())
        (path / "normalized.v").write_text(normalized)
        result = run_clock_contract_repair(Path(config["binary"]), path / "normalized.v", path / "snapshot.json", output,
            condition=options["condition"], max_evaluations=options["max_evaluations"],
            evaluation_seconds=options["evaluation_seconds"], contract_seconds=options["contract_seconds"],
            max_contracts=options["max_contracts"], max_paths=options["max_paths"],
            reference=path / "reference.json" if (path / "reference.json").exists() else None,
            wall_seconds=options["budget"], model_config=model_config)
        result = dict(result, layout_validated=False)
        if result.get("status") == "recovered":
            selected = Path(result["selected_path"]).resolve()
            if not selected.is_relative_to(output.resolve()):
                raise ValueError("Selected repair is not a new artifact of this run")
            result.update(_qualify_repair(source, output, selected, options))
    result.update(platform_action=mode, adapter_elapsed_seconds=round(time.monotonic() - begin, 6),
                  device_waveform_signoff=False, qca_exported=False,
                  qualification_scope="Native candidate acceptance plus independent route/global-clock and source equivalence; IFCN export only")
    write(path / "research-summary.json", result)


def run_worker(api, path, fd):
    manifest = api.load_run(path)
    mode = manifest["research"]["mode"]
    start = time.monotonic()
    manifest.update(status="running", worker_pid=os.getpid(), current_stage=mode, updated_at=api.now())
    manifest["stages"][mode] = {"status": "running", "started_at": api.now(), "attempt": 1, "log": "research.log"}
    try:
        api.verify_artifacts(path, manifest)
        if api.STOP or (path / "cancel.request").exists():
            raise InterruptedError("Cancellation requested before research execution")
        job = manifest["research"]
        config, options = job["configuration"], job["options"]
        api.write_json(path / "research-job.json", job)
        api.register_artifact(path, manifest, "research-job.json", path / "research-job.json")
        api.execute([config["python"], str(Path(__file__).resolve()), "--execute", str(path / "research-job.json")],
                    path, mode, manifest, timeout_s=options["budget"] + options["validation_timeout"] + 15)
        result = json.loads((path / "research-summary.json").read_text())
        validated = result.get("layout_validated") is True
        manifest["metrics"]["research"] = result
        manifest["validation"].update(layout_model="passed" if validated else "not_validated",
                                     rtl_equivalence="equivalent" if validated else "not_proven",
                                     physical_function="not_verified", qca_mapping="native_candidate_check_only")
        manifest["stages"][mode].update(status="completed", completed_at=api.now())
        manifest.update(status="layout_candidate" if validated else "completed_with_warnings", error=None)
        if not validated:
            manifest.setdefault("warnings", []).append({"code": "no_qualified_layout", "stage": mode,
                "message": f"Research search completed with outcome {result.get('status')}; no independently qualified layout is available."})
    except Exception as exc:
        manifest.update(status="cancelled" if isinstance(exc, InterruptedError) else "failed", error=str(exc))
        manifest["stages"][mode].update(status=manifest["status"], error=str(exc))
    finally:
        # Evidence is retained on failure or cancellation, without promoting it.
        for target in sorted(path.rglob("*")):
            if (target.is_file() and target.stat().st_size and target not in {path / name for name in
                    ("manifest.json", "result.json", "worker.log", "run.lock", "cancel.request")}
                    and not target.is_symlink()):
                api.register_artifact(path, manifest, str(target.relative_to(path)), target)
        for name in ("drc.json", "logic.json", "routed_dag.json", "layout.ifcn", "candidate.json", "selected.json"):
            target = path / "search" / name
            if target.is_file():
                api.register_artifact(path, manifest, "candidate.json" if name == "selected.json" else name, target)
        manifest["research"]["elapsed_seconds"] = round(time.monotonic() - start, 6)
        manifest["updated_at"] = api.now()
        api.result_report(path, manifest)
        api.write_json(path / "manifest.json", manifest)
        os.close(fd)


def _child_main():
    # Research helpers isolate native/model subprocesses. Track those groups so
    # cancellation of the durable parent also terminates detached descendants.
    original = subprocess.Popen
    children = []
    def tracked(*args, **kwargs):
        proc = original(*args, **kwargs)
        children.append((proc, kwargs.get("start_new_session", False)))
        return proc
    def cleanup():
        for proc, isolated in reversed(children):
            try:
                if isolated:
                    os.killpg(proc.pid, signal.SIGKILL)
                elif proc.poll() is None:
                    proc.kill()
            except ProcessLookupError:
                pass
    def stop(_signal, _frame):
        cleanup()
        raise InterruptedError("Research job cancelled")
    subprocess.Popen = tracked
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        execute_search(Path(sys.argv[2]).resolve())
    finally:
        cleanup()


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--execute":
        raise SystemExit("Internal worker interface: --execute research-job.json")
    _child_main()
