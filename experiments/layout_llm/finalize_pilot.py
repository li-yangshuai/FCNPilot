#!/usr/bin/env python3
"""Independently audit the finished pilot, draw its measured case, and archive it."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENGINE = ROOT / "engine"
RUNS = ENGINE / "output/pi-runs"
sys.path.insert(0, str(ENGINE / "scripts"))
from ifcn_agent_clock_validation import validate_clock_arrivals


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def load(path):
    return json.loads(path.read_text())


def verify_run(run_id):
    directory = RUNS / run_id
    manifest = load(directory / "manifest.json")
    assert manifest["status"] == "completed", (run_id, manifest["status"])
    for name, item in manifest["artifacts"].items():
        file = (directory / item["path"]).resolve()
        assert file.is_relative_to(directory.resolve())
        assert file.stat().st_size == item["bytes"], (run_id, name, "size")
        assert digest(file) == item["sha256"], (run_id, name, "hash")
    get = lambda name: directory / manifest["artifacts"][name]["path"]
    physical = load(get("physical.json"))
    assert physical["passed"]
    assert physical["ifcn_sha256"] == digest(get("layout.ifcn"))
    assert physical["qca_sha256"] == digest(get("device.qca"))
    assert set(("ordered_route_continuity", "source_site_isolation", "layer_transition_columns",
                "route_site_coverage", "gate_connection_ports")).issubset(physical["checks"])
    clock = validate_clock_arrivals(get("layout.ifcn").read_text(), load(get("routed_dag.json")))
    assert clock["passed"], (run_id, clock)
    actual_cells = get("device.qca").read_text().count("[TYPE:QCADCell]")
    assert physical["cell_count"] == actual_cells == manifest["metrics"]["mapping"]["cell_count"]
    return {"run_id": run_id, "verified_artifacts": len(manifest["artifacts"]),
            "clock_recomputed": True, "physical_bindings_verified": True,
            "actual_qca_cells": actual_cells, "ifcn_sha256": physical["ifcn_sha256"],
            "qca_sha256": physical["qca_sha256"], "source_sha256": digest(get("source.v"))}


def geometry(candidate):
    paths = {(row["source"], row["target"]): row["path"] for row in candidate["routes"]}
    points = {tuple(p) for path in paths.values() for p in path}
    points.update((node["x"], node["y"]) for node in candidate["nodes"])
    xs, ys = zip(*points)
    box = {"min_x": min(xs), "max_x": max(xs), "min_y": min(ys), "max_y": max(ys)}
    box["width"] = box["max_x"] - box["min_x"] + 1
    box["height"] = box["max_y"] - box["min_y"] + 1
    box["area"] = box["width"] * box["height"]
    return paths, box


def draw_case(job):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    directory = RUNS / job["run_id"]
    campaign = load(directory / "campaign.json")
    before_file = directory / campaign["baseline"]["candidate_artifact"]
    after_file = directory / campaign["selected"]["candidate_artifact"]
    before, after = load(before_file), load(after_file)
    first, oldbox = geometry(before)
    last, newbox = geometry(after)
    oldnodes = {n["id"]: n for n in before["nodes"]}
    newnodes = {n["id"]: n for n in after["nodes"]}
    changes = [{"node": i, "name": oldnodes[i]["name"], "from": [oldnodes[i]["x"], oldnodes[i]["y"]],
                "to": [newnodes[i]["x"], newnodes[i]["y"]]} for i in oldnodes
               if (oldnodes[i]["x"], oldnodes[i]["y"]) != (newnodes[i]["x"], newnodes[i]["y"])]
    route_changes = [{"source": key[0], "target": key[1], "before_steps": len(path) - 1,
                      "after_steps": len(last[key]) - 1} for key, path in first.items()]
    assert changes == [{"node": 4, "name": "w2", "from": [20, 23], "to": [21, 22]},
                       {"node": 5, "name": "~w1", "from": [22, 26], "to": [21, 25]}]
    oldsteps, newsteps = sum(len(p) - 1 for p in first.values()), sum(len(p) - 1 for p in last.values())
    assert (oldbox["area"], newbox["area"], oldsteps, newsteps) == (40, 30, 34, 30)
    assert (len(first[(4, 2)]) - 1, len(last[(4, 2)]) - 1) == (7, 9)
    assert (oldbox["min_x"], newbox["min_x"]) == (19, 20)
    cells = [campaign[key]["metrics"]["qca_cells"] for key in ("baseline", "selected")]
    assert cells == [160, 140]
    evidence = {"schema": "fcnpilot.layout_llm.case_study.v1", "run_id": job["run_id"],
                "selected_round": campaign["selected_round"], "before_file": str(before_file),
                "after_file": str(after_file), "before_sha256": digest(before_file), "after_sha256": digest(after_file),
                "baseline_box": oldbox, "selected_box": newbox, "baseline_cells": cells[0], "selected_cells": cells[1],
                "node_changes": changes, "route_step_counts": route_changes,
                "sum_route_steps_before": oldsteps, "sum_route_steps_after": newsteps,
                "interpretation": "Column x=19 disappears and total routed steps fall from 34 to 30. The w2-to-output route grows from 7 to 9 steps; improvement is not universal shortening of output wires."}
    write(HERE / "xor2_case_study.json", evidence)

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "svg.fonttype": "none", "pdf.fonttype": 42})
    fig, axes = plt.subplots(1, 2, figsize=(8.5, 7.7), sharex=True, sharey=True)
    colors = {0: "#277DA1", 1: "#43AA8B", 3: "#7656A8", 4: "#D58B2C", 5: "#AC5574"}
    for axis, candidate, box, count, steps, title in zip(axes, (before, after), (oldbox, newbox), cells,
                                                       (oldsteps, newsteps), ("Certified baseline", "LLM proposal, round 2")):
        axis.add_patch(Rectangle((box["min_x"] - .5, box["min_y"] - .5), box["width"], box["height"],
                                 facecolor="#F2F5F8", edgecolor="#526778", linewidth=1.2, zorder=0))
        source_segments = set()
        for route in candidate["routes"]:
            for a, b in zip(route["path"], route["path"][1:]):
                edge = (route["source"], tuple(a), tuple(b))
                if edge in source_segments:
                    continue
                source_segments.add(edge)
                axis.plot([a[0], b[0]], [a[1], b[1]], color=colors[route["source"]], linewidth=2.1, zorder=2)
        for node in candidate["nodes"]:
            changed = node["id"] in (4, 5)
            x, y = node["x"], node["y"]
            axis.add_patch(Rectangle((x - .39, y - .32), .78, .64,
                                     facecolor="#FFF0CB" if changed else "white",
                                     edgecolor="#C96C13" if changed else "#293544", linewidth=1.8 if changed else 1.1, zorder=4))
            label = f"{node['id']}: {node['name']}\n{node['type'].upper()}"
            axis.text(x, y, label, ha="center", va="center", fontsize=7.2, zorder=5)
        if candidate is after:
            axis.add_patch(Rectangle((18.5, 19.5), 1, 10, fill=False, edgecolor="#ADB7C1", linestyle="--", linewidth=1))
            for change in changes:
                axis.plot(*change["from"], marker="o", markersize=6, markerfacecolor="none", markeredgecolor="#C96C13", zorder=6)
                axis.annotate("", xy=change["to"], xytext=change["from"],
                              arrowprops={"arrowstyle": "->", "linestyle": "--", "color": "#C96C13", "lw": 1.5}, zorder=6)
        axis.set_title(f"{title}\n{box['width']} × {box['height']} = {box['area']} tiles  |  {count} QCA cells\n{steps} routed steps", fontsize=10.3, pad=11)
        axis.set_xlim(18.2, 23.0); axis.set_ylim(30.1, 18.9); axis.set_aspect("equal")
        axis.set_xticks(range(19, 24)); axis.set_yticks(range(20, 30))
        axis.grid(color="#DCE2E8", linewidth=.5, zorder=1)
        axis.set_xlabel("Original world-grid x")
    axes[0].set_ylabel("Original world-grid y")
    fig.suptitle("Measured XOR2 layout change from a real model proposal", fontsize=13, y=.98)
    fig.text(.5, .112, "Moved gates: w2 (20,23) → (21,22); ~w1 (22,26) → (21,25).", ha="center", va="top", fontsize=9)
    fig.text(.5, .085, "Same coordinate scale. Leftmost route column x=19 disappears; total routed steps 34 → 30.\n"
             "The w2 → output route grows 7 → 9 steps. All source logic, clock, and physical-route checks passed.",
             ha="center", va="top", fontsize=8.2, linespacing=1.5)
    fig.text(.5, .017, "Gate-grid view; colours identify source nets. This single case does not establish superiority over the full control cohort.",
             ha="center", fontsize=7.8, color="#48535F")
    fig.subplots_adjust(top=.85, bottom=.205, left=.08, right=.96, wspace=.23)
    for suffix in ("svg", "pdf", "png"):
        fig.savefig(HERE / f"xor2_llm_case_study.{suffix}", dpi=200)
    plt.close(fig)


def finish():
    cohort, baselines = load(HERE / "cohort.json"), load(HERE / "baselines.json")
    assert len(cohort["jobs"]) == 12
    assert all(job["status"] == "completed" for job in cohort["jobs"])
    assert digest(HERE / "protocol.json") == cohort["protocol_sha256"]
    assert all(digest(ROOT / path) == expected for path, expected in cohort["implementation_sha256"].items())
    run_ids = [entry["run_id"] for entry in baselines["circuits"].values()] + [job["run_id"] for job in cohort["jobs"]]
    verified = [verify_run(run_id) for run_id in run_ids]
    statuses, model_calls, reported_tokens = Counter(), [], 0
    for job in cohort["jobs"]:
        campaign = load(RUNS / job["run_id"] / "campaign.json")
        assert len(campaign["rounds"]) == 3
        for row in campaign["rounds"]:
            statuses[row["status"]] += 1
            if job["policy"] == "llm":
                folder = RUNS / job["run_id"] / "rounds" / f"{row['id']:02d}"
                request, response = load(folder / "request.json"), load(folder / "response.json")
                assert response["model"] == {"provider": "new-provider", "modelId": "qwen3-vl-plus"}
                usage = response.get("usage")
                usage_known = isinstance(usage, dict) and (response["status"] == "ok" or bool(usage.get("totalTokens")))
                reported_tokens += usage["totalTokens"] if usage_known else 0
                model_calls.append({"run_id": job["run_id"], "round": row["id"], "status": response["status"],
                                    "request_sha256": digest(folder / "request.json"), "response_sha256": digest(folder / "response.json"),
                                    "error": response.get("error"), "usage_known": usage_known, "raw_usage": usage,
                                    "latency_ms": response.get("latency_ms"), "declared_timeout_ms": request["timeout_ms"]})
    assert len(model_calls) == 9
    write(HERE / "audit.json", {"schema": "fcnpilot.layout_llm.final_audit.v1", "at": datetime.now(timezone.utc).isoformat(),
                                "verified_runs": verified, "round_status_counts": dict(statuses), "model_calls": model_calls,
                                "reported_model_tokens": reported_tokens, "model_calls_with_unknown_usage": sum(not row["usage_known"] for row in model_calls),
                                "core_implementation_unchanged": True, "model_retries": 0,
                                "scope": "Hashes, source identities, actual exported QCA counts, bound physical certificates and recomputed discrete clock arrivals; not electrical waveform or power signoff."})
    draw_case(next(job for job in cohort["jobs"] if job["circuit"] == "xor2" and job["policy"] == "llm"))
    sources = {}
    excluded = {"evidence.tar.gz", "evidence.json", "evidence_inventory.json"}
    for file in HERE.rglob("*"):
        if file.is_file() and file.name not in excluded and "__pycache__" not in file.parts:
            sources["study/" + str(file.relative_to(HERE))] = file
    for run_id in run_ids:
        for file in (RUNS / run_id).rglob("*"):
            if file.is_file():
                sources["engine/output/pi-runs/" + run_id + "/" + str(file.relative_to(RUNS / run_id))] = file
    for name in cohort["implementation_sha256"]:
        sources["implementation_snapshot/" + name] = ROOT / name
    inventory = []
    for name, file in sorted(sources.items()):
        assert not file.is_symlink(), file
        assert "node_modules" not in file.parts
        assert file.name not in {"auth.json", "models.json", ".env", "credentials.json"}, file
        inventory.append({"path": name, "bytes": file.stat().st_size, "sha256": digest(file)})
    write(HERE / "evidence_inventory.json", {"schema": "fcnpilot.layout_llm.archive_inventory.v1", "files": inventory})
    sources["study/evidence_inventory.json"] = HERE / "evidence_inventory.json"
    archive = HERE / "evidence.tar.gz"
    with tarfile.open(archive, "w:gz", compresslevel=6) as bundle:
        for name, file in sorted(sources.items()):
            bundle.add(file, arcname=name, recursive=False)
    # Read back every archive member and verify it against the independent
    # inventory. The package contains no self-reference, SDK trees or secrets.
    expected = {entry["path"]: entry for entry in inventory}
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            assert member.isfile() and not member.name.startswith("/") and ".." not in Path(member.name).parts
            if member.name in expected:
                data = bundle.extractfile(member).read()
                assert len(data) == expected[member.name]["bytes"]
                assert hashlib.sha256(data).hexdigest() == expected[member.name]["sha256"]
    write(HERE / "evidence.json", {"schema": "fcnpilot.layout_llm.evidence_bundle.v1", "archive": archive.name,
                                   "sha256": digest(archive), "bytes": archive.stat().st_size,
                                   "file_count": len(sources), "run_ids": run_ids,
                                   "protocol_sha256": cohort["protocol_sha256"], "inventory_sha256": digest(HERE / "evidence_inventory.json"),
                                   "archive_members_verified": True, "original_runs_preserved": True})
    print(json.dumps(load(HERE / "evidence.json"), indent=2))


if __name__ == "__main__":
    finish()
