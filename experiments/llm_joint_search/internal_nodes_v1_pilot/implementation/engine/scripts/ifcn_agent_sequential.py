"""State-preserving RTL/SeqIR adapter for the native cyclic layout flow.

The register-cut DAG is an intermediate representation only: native P&R must
restore every distance-one state boundary before a layout is accepted.
"""
import html
import json
import os
from pathlib import Path
import re
import shutil
import time

from yosys_json_to_seqir import import_yosys_json, build_legacy_cut_artifacts


def find_yosys(root):
    configured = os.environ.get("IFCN_YOSYS")
    if configured:
        return str(Path(configured).expanduser().resolve())
    system = shutil.which("yosys")
    return system or str(Path(root) / "build/tools/yosys-local/usr/bin/yosys")


def yosys_environment(executable):
    prefix = Path(executable).parent.parent
    env = {}
    if prefix.name != "usr":
        return env
    libraries = [prefix / "lib", prefix / "lib64", *sorted((prefix / "lib").glob("*-linux-gnu"))]
    env["PATH"] = str(prefix / "bin") + os.pathsep + os.environ.get("PATH", "")
    env["LD_LIBRARY_PATH"] = os.pathsep.join([str(p) for p in libraries if p.is_dir()] + [os.environ.get("LD_LIBRARY_PATH", "")])
    if (prefix / "share/yosys").is_dir():
        env["YOSYS_DATDIR"] = str(prefix / "share/yosys")
    tcl = sorted(prefix.glob("share/tcltk/tcl*/init.tcl"), reverse=True)
    if tcl:
        env["TCL_LIBRARY"] = str(tcl[0].parent)
    return env


def capabilities(config):
    ready = lambda name: bool(config.get(name)) and Path(config[name]).is_file() and os.access(config[name], os.X_OK)
    return {
        "supported": True, "available": ready("yosys_binary") and ready("sequential_pnr_binary"),
        "status": "integrated_layout_candidate", "algorithm": "sequential_cyclic",
        "input": "Single-clock positive-edge RTL, lowered by Yosys to supported Boolean cells and DFFs; state Q outputs; reject latches/asynchronous state/multiple clocks/unsupported cells.",
        "stages": ["parse", "pnr", "map", "simulate", "energy"], "default_until": "map",
        "physical_state_signoff": "not_characterized",
        "geometry_search": {"max_candidates":64, "order":"ascending_native_rank", "budget":"shared_pnr_timeout", "retry_on":"fixed_geometry_clock_unsat_only"},
        "simulation_scope": "Explicitly requested numerical-model exploration only, not storage or RTL waveform validation",
        "checks": {"yosys": ready("yosys_binary"), "cyclic_pnr": ready("sequential_pnr_binary")},
    }


def validate_source_ports(seqir):
    if len(seqir["clock_domains"]) != 1:
        raise ValueError("Sequential cyclic P&R currently requires exactly one clock domain.")
    states = {register["q"] for register in seqir["registers"]}
    outputs = {bit for port in seqir["ports"] if port["direction"] == "output" for bit in port["bits"]}
    if not outputs or not outputs.issubset(states):
        raise ValueError("Sequential cyclic export currently supports outputs directly observing register Q; separate combinational output cones are not exported. No output was silently removed.")


def validate_native_report(report, state_manifest):
    expected = {(item["data_event"], item["q_event"], 1) for item in state_manifest["state_boundaries"]}
    actual = {(item["data_event"], item["q_event"], item["iteration_distance"]) for item in report.get("state_boundaries", [])}
    if not expected or actual != expected or report.get("state_boundary_count") != len(expected):
        raise ValueError("Native sequential P&R did not preserve the complete state boundary map.")
    if (report.get("status") != "layout_candidate" or report.get("mapping_mode") != "sequential"
            or report.get("feedback_routes", 0) < len(expected) or report.get("directed_cycle_present") is not True
            or report.get("mapping_drc") is not True or report.get("tile_phase_drc") is not True):
        raise ValueError("Sequential P&R failed feedback topology, mapping or clock constraints.")
    if report.get("physical_state_signoff") != "not_characterized":
        raise ValueError("Unexpected sequential physical validation contract.")


def render_layout_svg(source, target):
    """Render actual IFCN routes/tiles; dashed paths are iteration-distance one."""
    text = Path(source).read_text()
    nodes = [(int(i), name.strip(), kind.strip(), int(x), int(y)) for i, name, kind, x, y in re.findall(
        r"^\s*(\d+),\s*([^,]+),\s*([^,]+),\s*\((-?\d+),\s*(-?\d+)\);", text, re.M)]
    phases = {(int(x), int(y)): int(p) for x, y, p in re.findall(r"^\((-?\d+),\s*(-?\d+)\):\s*(\d+);", text, re.M)}
    routes = []
    distance = 0
    for line in text.splitlines():
        if line.startswith("#iteration_distance="):
            distance = int(line.split("=", 1)[1])
        elif re.match(r"^\(\d+,\s*\d+\):", line):
            points = [(int(x), int(y)) for x, y in re.findall(r"\((-?\d+),\s*(-?\d+)\)", line.split(":", 1)[1])]
            if points:
                routes.append((distance, points))
    if not nodes or not phases or not routes:
        raise ValueError("Sequential IFCN lacks node/route/phase geometry for preview.")
    coords = set(phases) | {(n[3], n[4]) for n in nodes}
    min_x, min_y = min(x for x, y in coords), min(y for x, y in coords)
    max_x, max_y = max(x for x, y in coords), max(y for x, y in coords)
    xy = lambda x, y: ((x - min_x) * 58 + 55, (y - min_y) * 58 + 70)
    width, height = max(340, (max_x-min_x+1)*58+80), max(240, (max_y-min_y+1)*58+140)
    colors = ["#60c9a2", "#99b5ed", "#bba2e1", "#eac568"]
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}">',
           '<rect width="100%" height="100%" fill="#f8fafc"/>',
           '<text x="20" y="26" font-family="sans-serif" font-size="15" fill="#17314c">Sequential feedback layout candidate</text>']
    for (x, y), phase in sorted(phases.items()):
        px, py = xy(x, y)
        svg.append(f'<rect x="{px-23}" y="{py-23}" width="46" height="46" rx="6" fill="{colors[phase%4]}" opacity=".45"/>')
        svg.append(f'<text x="{px-18}" y="{py-12}" font-family="sans-serif" font-size="9" fill="#475569">{phase}</text>')
    for dist, points in routes:
        points_attr = " ".join(f"{a},{b}" for a,b in (xy(x,y) for x,y in points))
        dash = ' stroke-dasharray="5 3"' if dist else ""
        svg.append(f'<polyline points="{points_attr}" fill="none" stroke="{("#dc6b32" if dist else "#285a88")}" stroke-width="3"{dash}/>')
    for _, name, kind, x, y in nodes:
        px, py = xy(x,y)
        svg.append(f'<circle cx="{px}" cy="{py}" r="13" fill="#ffffff" stroke="#285a88" stroke-width="2"/>')
        svg.append(f'<text x="{px}" y="{py+4}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#17314c">{html.escape(kind[:3])}</text>')
        svg.append(f'<text x="{px}" y="{py+29}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#17314c">{html.escape(name)}</text>')
    svg.extend([f'<text x="20" y="{height-28}" font-family="sans-serif" font-size="11" fill="#475569">Dashed: feedback across one state iteration</text>',
                f'<text x="20" y="{height-12}" font-family="sans-serif" font-size="11" fill="#475569">State device not characterized; tile phases shown</text>', '</svg>'])
    Path(target).write_text("\n".join(svg))



def run_cyclic_candidates(api, directory, path, manifest, boundaries, normalized):
    """Reuse ranked native geometries; an UNSAT geometry is not an UNSAT circuit."""
    params, config = manifest["parameters"], manifest["configuration"]
    attempts = []
    report_path = directory / "geometry_attempts.json"
    deadline = time.monotonic() + params["timeout_s"]
    search = {"schema":"ifcn.sequential-geometry-search.v1", "policy":"ascending_native_rank_first_feasible",
              "max_candidates":64, "timeout_s":params["timeout_s"], "selected_rank":None, "attempts":attempts,
              "scope":"Bounded existing geometry candidates under shared time budget; no global feasibility or optimality proof"}
    try:
        for rank in range(64):
            if api.STOP or (path / "cancel.request").exists():
                raise InterruptedError("Cancellation requested.")
            remaining = deadline - time.monotonic()
            if remaining < 1:
                attempts.append({"geometry_rank":rank,"status":"budget_exhausted"})
                raise TimeoutError("Sequential geometry search exhausted the shared P&R time budget.")
            candidate = directory / f"geometry_{rank:02d}"
            candidate.mkdir()
            attempt = {"geometry_rank":rank,"status":"running"}
            attempts.append(attempt)
            command = [config["sequential_pnr_binary"], normalized, candidate / "layout.ifcn",
                       *boundaries["ifcn_sequential_pnr"]["argv"], "--ii", params["ii_candidates"],
                       "--geometry-rank", rank, "--tex", candidate / "layout.tex"]
            try:
                api.execute(command, path, "pnr", manifest, timeout_s=remaining)
            except RuntimeError as exc:
                # execute includes a bounded log tail; only classify its LAST
                # native diagnostic, never an earlier candidate's UNSAT line.
                diagnostic = re.sub(r"^pnr command exited with \d+\. ", "", str(exc).strip().splitlines()[-1], count=1)
                attempt["reason"] = diagnostic
                if diagnostic.startswith("ifcn_sequential_cyclic_pnr failed: global cyclic phase/epoch solve UNSAT:"):
                    attempt["status"] = "clock_unsat"
                    continue
                if re.fullmatch(r"ifcn_sequential_cyclic_pnr failed: --geometry-rank \d+ is unavailable; only \d+ distinct DRC-valid candidates were found", diagnostic):
                    attempt["status"] = "candidate_unavailable"
                    raise ValueError("No clock-feasible layout among the available ranked native geometries; see geometry_attempts.json.") from exc
                attempt["status"] = "failed"
                raise
            except Exception as exc:
                attempt.update(status="cancelled" if isinstance(exc, InterruptedError) else "failed", reason=str(exc))
                raise
            try:
                report = json.loads((candidate / "layout.ifcn.json").read_text())
                validate_native_report(report, boundaries)
                for filename in ("layout.ifcn", "layout.ifcn.json", "layout.tex"):
                    shutil.copyfile(candidate / filename, directory / filename)
            except Exception as exc:
                attempt.update(status="failed", reason=str(exc))
                raise
            attempt["status"] = "selected"
            search["selected_rank"] = rank
            manifest["metrics"].setdefault("sequential", {})["geometry_search"] = {
                "selected_rank":rank,"attempted_candidates":len(attempts),"max_candidates":64}
            return
        raise ValueError("No clock-feasible layout in the first 64 ranked native geometries; this does not prove the circuit infeasible. See geometry_attempts.json.")
    finally:
        api.write_json(report_path, search)
        api.register_artifact(path, manifest, "geometry_attempts.json", report_path)

def run_stage(api, step, directory, path, manifest):
    config, params = manifest["configuration"], manifest["parameters"]
    get = lambda name: api.artifact_path(path, manifest["artifacts"][name])
    add = lambda name, file: api.register_artifact(path, manifest, name, directory / file)
    run = lambda command, **kwargs: api.execute(command, path, step, manifest, **kwargs)
    if step == "parse":
        from ifcn_sequential_validation import verify_next_state
        if not capabilities(config)["available"]:
            raise ValueError("Sequential flow requires Yosys and ifcn_sequential_cyclic_pnr; run setup or set IFCN_YOSYS.")
        quote = lambda p: json.dumps(str(p))
        script = directory / "synthesize.ys"
        script.write_text(";\n".join([f"read_verilog -sv {quote(get('source.v'))}",
            "hierarchy -check -auto-top", "proc", "flatten", "opt", "dffunmap", "techmap", "abc -g AND,OR", "clean",
            f"write_json {quote(directory/'yosys.json')}"]) + ";\n")
        run([config["yosys_binary"], "-s", script], env_extra=yosys_environment(config["yosys_binary"]))
        add("yosys.json", "yosys.json")
        seqir = import_yosys_json(json.loads(get("yosys.json").read_text()))
        api.write_json(directory / "seqir.json", seqir)
        add("seqir.json", "seqir.json")
        validate_source_ports(seqir)
        cut = build_legacy_cut_artifacts(seqir, compact_names=True)
        (directory / "normalized.v").write_text(cut.verilog)
        api.write_json(directory / "state_manifest.json", cut.state_manifest)
        add("normalized.v", "normalized.v")
        add("state_manifest.json", "state_manifest.json")
        run([config["python"], config["backend"], "parse", "--input", get("normalized.v"), "--output", directory,
             "--seed", params["seed"], "--budget", min(240, params["timeout_s"]), "--preserve-output-boundaries"])
        add("dag.json", "dag.json"); add("dag.dot", "dag.dot")
        dag = json.loads(get("dag.json").read_text())
        verification = verify_next_state(seqir, cut.state_manifest, dag)
        api.write_json(directory / "sequential_validation.json", verification)
        add("sequential_validation.json", "sequential_validation.json")
        if verification["status"] not in {"equivalent", "not_performed"}:
            raise ValueError("SeqIR/cut-DAG one-step state validation failed: " + str(verification))
        if verification["status"] == "not_performed":
            manifest.setdefault("warnings", []).append({"code":"state_transition_not_exhaustive", "stage":"parse", "message":"State + input bits exceed bounded one-step exhaustive validation."})
        manifest["frontend"] = {"module":seqir["module"], "design_type":"sequential", "register_bits":len(seqir["registers"]),
            "inputs":[p["id"] for p in seqir["ports"] if p["direction"]=="input"],
            "outputs":[p["id"] for p in seqir["ports"] if p["direction"]=="output"], "frontend":"yosys-seqir-v0"}
        manifest["metrics"]["dag"] = {"gate_nodes":verification["gate_nodes"], "input_count":dag["input_count"], "output_count":dag["output_count"], "scope":"state-cut combinational cone"}
        manifest["metrics"]["sequential"] = {"register_bits":len(seqir["registers"]), "clock_domains":len(seqir["clock_domains"]), "state_transition":verification}
        manifest["validation"]["sequential"] = {"state_transition":verification["status"], "scope":verification["scope"],
            "rtl_equivalence":"not_independently_proven", "physical_state_signoff":"not_characterized"}
        manifest["validation"]["sequential_equivalence"] = verification["status"]
    elif step == "pnr":
        boundaries = json.loads(get("state_manifest.json").read_text())
        run_cyclic_candidates(api, directory, path, manifest, boundaries, get("normalized.v"))
        report = json.loads((directory / "layout.ifcn.json").read_text())
        add("sequential_pnr.json", "layout.ifcn.json")
        validate_native_report(report, boundaries)
        add("layout.ifcn", "layout.ifcn"); add("pnr/layout.tex", "layout.tex")
        render_layout_svg(directory / "layout.ifcn", directory / "layout.svg")
        add("pnr/layout.svg", "layout.svg")
        manifest["metrics"]["sequential"].update(report)
        pnr = {**report, "algorithm":"sequential_cyclic", "clock_scheme":"irregular", "phase_count":4,
            "width":report["bbox_width"], "height":report["bbox_height"], "area_tiles":report["bbox_area"],
            "layout_legal":True, "clock_legal":True, "failed_edge_count":0,
            "validation":{"passed":True,"scope":report["validation_scope"]}}
        api.write_json(directory / "pnr.json", pnr); add("pnr.json", "pnr.json")
        manifest["metrics"]["pnr"] = pnr
        manifest["validation"]["sequential"].update({"feedback_topology":"preserved", "tile_phase_drc":True,
            "physical_state_signoff":report["physical_state_signoff"]})
        manifest.setdefault("warnings", []).append({"code":"state_device_uncharacterized", "stage":"pnr",
            "message":"Feedback topology and tile phase/epoch constraints passed; state device is not characterized. This is a layout candidate, not storage or RTL waveform signoff."})
    elif step == "map":
        run([config["mapping_binary"], get("layout.ifcn"), "--no-io-contraction"])
        run([config["energy_binary"], get("layout.ifcn"), directory / "device", "--qca-only"])
        qca = directory / "device_energy_input.qca"
        count = qca.read_text().count("[TYPE:QCADCell]")
        if count <= 0 or count != manifest["metrics"]["sequential"]["mapped_qca_cells"]:
            raise ValueError("Sequential QCA cell count does not match the validated native mapping.")
        add("device.qca", "device_energy_input.qca")
        manifest["metrics"]["mapping"] = {"cell_count":count, "io_contraction":False, "mapping_mode":"sequential"}
        manifest["validation"]["device_terminal_counts"] = "not_compared_to_rtl_ports_state_nodes_are_internal"
