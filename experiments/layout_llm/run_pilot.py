#!/usr/bin/env python3
"""Prespecified serial pilot. Never retries or replaces a submitted campaign."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

DIRECTORY = Path(__file__).resolve().parent
REPOSITORY = DIRECTORY.parents[1]
ENGINE = REPOSITORY / "engine"
RUNS = ENGINE / "output/pi-runs"
PYTHON = ENGINE / ".venv/bin/python"
CLI = ENGINE / "scripts/ifcn_agent.py"
PROTOCOL_FILE = DIRECTORY / "protocol.json"
PROTOCOL = json.loads(PROTOCOL_FILE.read_text())
ACTIVE = {"created", "queued", "running", "cancelling"}


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def command(arguments, log_name):
    result = subprocess.run([str(PYTHON), str(CLI), *map(str, arguments)],
                            cwd=REPOSITORY, text=True, capture_output=True, timeout=25)
    logs = DIRECTORY / "submission_logs"
    logs.mkdir(exist_ok=True)
    save(logs / (log_name + ".json"), {"at": now(), "arguments": list(map(str, arguments)),
                                       "exit_code": result.returncode, "stdout": result.stdout,
                                       "stderr": result.stderr})
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return json.loads(result.stdout)


def wait_run(run_id, timeout):
    deadline = time.monotonic() + timeout
    previous = None
    while True:
        result = subprocess.run([str(PYTHON), str(CLI), "status", run_id], cwd=REPOSITORY,
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        state = json.loads(result.stdout)
        status = (state.get("status"), state.get("current_stage"))
        if status != previous:
            print(run_id, *status, flush=True)
            previous = status
        if not state.get("active") and state.get("status") not in ACTIVE:
            return state
        if time.monotonic() >= deadline:
            command(["cancel", run_id], run_id + "_watchdog_cancel")
            raise TimeoutError("Predeclared campaign watchdog reached; cancelled without retry")
        time.sleep(PROTOCOL["execution"]["poll_interval_s"])


def check_baseline(run_id, expected_source):
    root = RUNS / run_id
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest["status"] != "completed":
        raise ValueError(manifest.get("error") or "baseline did not complete")
    artifacts = manifest["artifacts"]
    for name, entry in artifacts.items():
        path = (root / entry["path"]).resolve()
        if not path.is_relative_to(root.resolve()) or sha(path) != entry["sha256"]:
            raise ValueError("baseline artifact integrity failure: " + name)
    get = lambda name: root / artifacts[name]["path"]
    if sha(get("source.v")) != expected_source:
        raise ValueError("baseline source differs from the prespecified circuit")
    clock, physical = (json.loads(get(name).read_text()) for name in ("clock.json", "physical.json"))
    if not clock.get("passed") or not physical.get("passed"):
        raise ValueError("baseline is missing current passing certificates")
    if physical["ifcn_sha256"] != sha(get("layout.ifcn")) or physical["qca_sha256"] != sha(get("device.qca")):
        raise ValueError("baseline certificates do not bind the actual IFCN/QCA")
    pnr = manifest["metrics"]["pnr"]
    if (pnr["algorithm"], pnr["clock_scheme"]) != ("june_random", "irregular"):
        raise ValueError("baseline violates the locked algorithm/clock family")
    return {"area_tiles": pnr["area_tiles"], "qca_cells": physical["cell_count"],
            "source_sha256": expected_source, "ifcn_sha256": physical["ifcn_sha256"],
            "qca_sha256": physical["qca_sha256"]}


def prepare():
    path = DIRECTORY / "baselines.json"
    data = json.loads(path.read_text()) if path.exists() else {
        "protocol_sha256": sha(PROTOCOL_FILE), "created_at": now(), "circuits": {}}
    if data["protocol_sha256"] != sha(PROTOCOL_FILE):
        raise ValueError("Protocol changed after baseline preparation")
    for circuit in PROTOCOL["circuits"]:
        name = circuit["name"]
        if name in data["circuits"] and data["circuits"][name].get("status") in {"ready", "failed"}:
            continue
        entry = data["circuits"].setdefault(name, {"status": "pending"})
        if "baseline_run_id" in circuit:
            entry["run_id"] = circuit["baseline_run_id"]
        elif not entry.get("run_id"):
            if entry["status"] == "submitting":
                raise RuntimeError("Ambiguous prior submission; inspect logs before any further action")
            source = REPOSITORY / circuit["baseline_source"]
            if sha(source) != circuit["source_sha256"]:
                raise ValueError("Third baseline source changed")
            entry.update(status="submitting", started_at=now()); save(path, data)
            config = circuit["baseline_generation"]
            submitted = command(["start", source, "--algorithm", config["algorithm"], "--clock", config["clock"],
                                 "--until", config["until"], "--timeout", config["timeout_s"], "--seed", config["seed"]],
                                name + "_baseline")
            entry.update(run_id=submitted["run_id"], status="submitted"); save(path, data)
        try:
            wait_run(entry["run_id"], 110)
            entry.update(status="ready", metrics=check_baseline(entry["run_id"], circuit["source_sha256"]))
        except Exception as error:
            entry.update(status="failed", error=str(error))
        entry["finished_at"] = now(); save(path, data)
    print(json.dumps(data, ensure_ascii=False, indent=2), flush=True)


def implementation_hashes():
    files = ["engine/scripts/ifcn_agent.py", "engine/scripts/ifcn_agent_backend.py",
             "engine/scripts/ifcn_agent_frontend.py", "engine/scripts/ifcn_agent_layout_validation.py",
             "engine/scripts/ifcn_agent_clock_validation.py", "engine/scripts/ifcn_combinational_rephase.py",
             "engine/scripts/ifcn_layout_optimization.py", "integrations/pi/layout-proposer.mjs",
             "engine/build/ifcn_layout_edit", "engine/build/ifcn_energy_analysis", "engine/build/ifcn_mapping_metrics"]
    return {file: sha(REPOSITORY / file) for file in files}


def execute():
    baseline = json.loads((DIRECTORY / "baselines.json").read_text())
    path = DIRECTORY / "cohort.json"
    if path.exists():
        data = json.loads(path.read_text())
    else:
        data = {"schema": "fcnpilot.layout_llm.cohort.v1", "started_at": now(),
                "protocol_sha256": sha(PROTOCOL_FILE), "runner_sha256": sha(__file__),
                "implementation_sha256": implementation_hashes(), "jobs": []}
        for circuit in PROTOCOL["circuits"]:
            entry = baseline["circuits"][circuit["name"]]
            for policy in PROTOCOL["policies"]:
                data["jobs"].append({"circuit": circuit["name"], "policy": policy,
                                     "baseline_run_id": entry.get("run_id"), "status": "pending" if entry["status"] == "ready" else "baseline_unavailable",
                                     "baseline_error": entry.get("error")})
        save(path, data)
    if data["protocol_sha256"] != sha(PROTOCOL_FILE) or baseline["protocol_sha256"] != sha(PROTOCOL_FILE):
        raise RuntimeError("The locked protocol has changed")
    for job in data["jobs"]:
        if job["status"] in {"completed", "failed", "cancelled", "baseline_unavailable", "submission_failed"}:
            continue
        if data["implementation_sha256"] != implementation_hashes():
            raise RuntimeError("Core implementation changed during the cohort; stop and disclose, do not silently resume")
        if job["status"] == "submitting":
            raise RuntimeError("Ambiguous prior model campaign submission; inspect before any retry")
        if not job.get("run_id"):
            job.update(status="submitting", submitted_at=now()); save(path, data)
            arguments = ["optimize", job["baseline_run_id"], "--policy", job["policy"], "--rounds", PROTOCOL["rounds_per_campaign"],
                         "--candidate-timeout", PROTOCOL["candidate_timeout_s"], "--model-timeout", PROTOCOL["model_timeout_s"],
                         "--seed", PROTOCOL["seed"], "--provider", PROTOCOL["model"]["provider"], "--model-id", PROTOCOL["model"]["model_id"]]
            try:
                submitted = command(arguments, job["circuit"] + "_" + job["policy"])
            except Exception as error:
                job.update(status="submission_failed", error=str(error)); save(path, data)
                continue
            job.update(run_id=submitted["run_id"], status="submitted"); save(path, data)
        try:
            state = wait_run(job["run_id"], PROTOCOL["execution"]["campaign_watchdog_s"])
            job.update(status=state["status"], error=state.get("error"))
        except Exception as error:
            job.update(status="failed", error=str(error))
        job["finished_at"] = now(); save(path, data)
        summarize()
    data["finished_at"] = now()
    data["implementation_unchanged"] = data["implementation_sha256"] == implementation_hashes()
    save(path, data)
    summarize()


def usage_total(rounds, run_id, policy):
    values = []
    for row in rounds:
        directory = RUNS / run_id / "rounds" / f"{row['id']:02d}"
        if policy != "llm" or not (directory / "request.json").is_file():
            continue
        response = directory / "response.json"
        audit = json.loads(response.read_text()) if response.is_file() else {}
        usage = audit.get("usage")
        # SDK default zero counters after a provider error are not evidence of
        # zero billed tokens. Preserve that response but report usage unknown.
        if not isinstance(usage, dict) or (audit.get("status") != "ok" and not usage.get("totalTokens")):
            usage = None
        values.append(usage)
    if not values:
        return None
    keys = ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")
    numeric = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool)
    known = {key: sum(v[key] for v in values if isinstance(v, dict) and numeric(v.get(key))) for key in keys}
    complete = {key: all(isinstance(v, dict) and numeric(v.get(key)) for v in values) for key in keys}
    return {"calls": len(values), "reported_calls": sum(isinstance(v, dict) for v in values),
            "missing_calls": sum(not isinstance(v, dict) for v in values), "known_totals": known,
            **{key: known[key] if complete[key] else None for key in keys}}


def summarize():
    cohort_path = DIRECTORY / "cohort.json"
    if not cohort_path.exists():
        return
    data = json.loads(cohort_path.read_text())
    summaries, round_rows = [], []
    detailed = []
    for job in data["jobs"]:
        run_id = job.get("run_id")
        campaign_file = RUNS / run_id / "campaign.json" if run_id else None
        campaign = json.loads(campaign_file.read_text()) if campaign_file and campaign_file.exists() else {}
        rounds = campaign.get("rounds", [])
        start, selected = (campaign.get(key, {}).get("metrics", {}) for key in ("baseline", "selected"))
        usage = usage_total(rounds, run_id, job["policy"])
        row = {"circuit": job["circuit"], "policy": job["policy"], "run_id": run_id, "status": job["status"],
               "baseline_area": start.get("area_tiles"), "selected_area": selected.get("area_tiles"),
               "baseline_cells": start.get("qca_cells"), "selected_cells": selected.get("qca_cells"),
               "rounds": len(rounds), "accepted": sum(r["status"] == "accepted" for r in rounds),
               "rejected": sum(r["status"] == "rejected" for r in rounds), "failed": sum(r["status"] in {"failed", "cancelled"} for r in rounds),
               "input_tokens": usage["input"] if usage else None, "output_tokens": usage["output"] if usage else None,
               "total_tokens": usage["totalTokens"] if usage else None,
               "reported_total_tokens": usage["known_totals"]["totalTokens"] if usage else None,
               "usage_missing_calls": usage["missing_calls"] if usage else None}
        for name, key in (("area", "area_tiles"), ("cells", "qca_cells")):
            row[name + "_reduction_percent"] = 100 * (start[key] - selected[key]) / start[key] if start.get(key) else None
        summaries.append(row)
        detailed.append({**job, "campaign_path": str(campaign_file) if campaign_file else None,
                         "campaign_sha256": sha(campaign_file) if campaign_file and campaign_file.exists() else None,
                         "baseline": campaign.get("baseline"), "selected": campaign.get("selected"), "usage": usage, "rounds": rounds})
        for candidate in rounds:
            execution = candidate.get("execution", {}); proposal = candidate.get("proposal", {})
            metrics = execution.get("candidate", {}).get("metrics") or {}
            round_rows.append({"circuit": job["circuit"], "policy": job["policy"], "run_id": run_id, "round": candidate["id"],
                               "status": candidate["status"], "area_tiles": metrics.get("area_tiles"), "qca_cells": metrics.get("qca_cells"),
                               "elapsed_s": candidate.get("elapsed_s"), "model_latency_ms": proposal.get("latency_ms"),
                               "operations": json.dumps(proposal.get("operations"), ensure_ascii=False),
                               "actual_moves": json.dumps(execution.get("actual_moves"), ensure_ascii=False),
                               "rerouted_edges": json.dumps(execution.get("rerouted_edges"), ensure_ascii=False),
                               "automatic_changes": json.dumps(execution.get("automatic_changes"), ensure_ascii=False),
                               "acceptance_or_failure": json.dumps(candidate.get("acceptance"), ensure_ascii=False),
                               "model_usage": json.dumps(proposal.get("usage"), ensure_ascii=False)})
    save(DIRECTORY / "summary.json", {"schema": "fcnpilot.layout_llm.pilot_summary.v1", "updated_at": now(),
                                      "protocol_sha256": data["protocol_sha256"], "summaries": summaries, "campaigns": detailed})
    for filename, rows in (("summary.csv", summaries), ("rounds.csv", round_rows)):
        if rows:
            with (DIRECTORY / filename).open("w", newline="") as stream:
                writer = csv.DictWriter(stream, list(rows[0])); writer.writeheader(); writer.writerows(rows)
    lines = ["# Prespecified layout-edit pilot", "", "Three fixed circuits, four policies, one repetition and three rounds per campaign. Failures remain included; no replacement circuits or model retries.", "",
             "| Circuit | Policy | Status | Area, before → selected | Cells, before → selected | Accepted / rounds | Model tokens |", "|---|---|---|---:|---:|---:|---:|"]
    for row in summaries:
        lines.append(f"| {row['circuit']} | {row['policy']} | {row['status']} | {row['baseline_area']} → {row['selected_area']} | {row['baseline_cells']} → {row['selected_cells']} | {row['accepted']} / {row['rounds']} | {row['total_tokens'] if row['total_tokens'] is not None else str(row['reported_total_tokens']) + ' + unknown' if row['usage_missing_calls'] else 'n/a'} |")
    lines += ["", "All coordinate proposals, executed moves, rerouted edges, clock repairs, rejected candidates, and failure reasons are retained in summary.json and rounds.csv, with original run paths. Missing model usage is not treated as zero.", "",
              "These are descriptive small-circuit pilot results. Equal proposal counts and validation budgets do not mean equal model cost or wall time. Routing and phase assignment are shared executors; any model benefit must be assessed against noop, random and heuristic policies. This experiment does not establish general superiority, statistical significance, device-waveform correctness, or power signoff.", ""]
    (DIRECTORY / "summary.md").write_text("\n".join(lines))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "execute", "summarize"))
    arguments = parser.parse_args()
    {"prepare": prepare, "execute": execute, "summarize": summarize}[arguments.command]()
