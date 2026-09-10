"""Bounded, geometry-preserving clock assignment for irregular combinational layouts.

The contract is the existing four-phase tile model: a forward phase advance
costs one tick, a same-phase step costs zero, and a gate has no additional
integer tick within its own clock tile. This is not an electrical timing model.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import subprocess
import sys
import time
from collections import defaultdict

from ifcn_agent_layout_validation import validate_candidate


LIMITS = {"nodes": 256, "routes": 128, "occurrences": 4096, "steps": 8192}


def _geometry_digest(candidate):
    data = {key: candidate.get(key) for key in ("nodes", "edges", "routes", "layers")}
    data["cell_positions"] = sorted((c["x"], c["y"]) for c in candidate["cells"])
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _solve(model, deadline):
    """Isolate HiGHS so wall-clock timeout includes import and presolve."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"status": "unknown", "reason": "wall_clock_timeout"}
    payload = json.dumps(model)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"status": "unknown", "reason": "wall_clock_timeout"}
    child = subprocess.Popen([sys.executable, __file__, "--solve-milp"], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        try:
            stdout, stderr = child.communicate(payload, timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate()
            return {"status": "unknown", "reason": "wall_clock_timeout"}
        if time.monotonic() >= deadline:
            return {"status": "unknown", "reason": "wall_clock_timeout"}
        if child.returncode:
            return {"status": "unknown", "reason": "solver_process_failed", "exit_code": child.returncode}
        try:
            return json.loads(stdout)
        except (ValueError, TypeError):
            return {"status": "unknown", "reason": "invalid_solver_response"}
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()


def _milp_worker():
    import numpy as np
    from scipy.optimize import Bounds, LinearConstraint, milp
    from scipy.sparse import coo_matrix

    model = json.load(sys.stdin)
    matrix = coo_matrix((model["coefficients"], (model["rows"], model["columns"])),
                        shape=(len(model["constraint_lower"]), len(model["lower"]))).tocsc()
    result = milp(c=np.zeros(len(model["lower"])), integrality=np.ones(len(model["lower"])),
                  bounds=Bounds(model["lower"], model["upper"]),
                  constraints=LinearConstraint(matrix, model["constraint_lower"], model["constraint_upper"]),
                  options={"presolve": True, "time_limit": model["time_limit"], "mip_rel_gap": 0.0})
    # A bounded search without proof of a feasible solution is unknown, never
    # UNSAT. Even a time-limited incumbent is not accepted by this wrapper.
    if result.status == 0 and result.x is not None:
        output = {"status": "sat", "values": result.x.tolist()}
    elif result.status == 2:
        output = {"status": "unsat", "reason": "infeasible_clock_constraints"}
    else:
        output = {"status": "unknown", "reason": "solver_limit_or_error", "solver_status": int(result.status)}
    print(json.dumps(output))


def _rephase_once(candidate, algorithm, timeout_s, preserve_pi_phases):
    """Return (new_candidate_or_None, report), leaving candidate untouched.

    Only compact and june_random are eligible. PI phases follow the requested
    attempt policy. All PI epochs are their phase minus one in cycle zero. Geometry, including
    fanout trunks and crossings, is immutable. A returned candidate still
    requires fresh IFCN export, full device mapping, and pipeline validation.
    """
    started = time.monotonic()
    report = {"schema": "ifcn.combinational.rephase.v1", "status": "invalid", "algorithm": algorithm,
              "solver": "scipy_highs_milp_in_bounded_process", "launch_policy": "all_pi_cycle0_at_own_phase",
              "pi_phases_preserved": True if preserve_pi_phases else None, "geometry_preserved": True,
              "pi_phase_policy": "fixed_original" if preserve_pi_phases else "free_within_cycle_zero",
              "phase_count": 4, "gate_internal_extra_ticks": 0,
              "requires_fresh_export_mapping": True,
              "scope": "Discrete clock-tile synchronization; not electrical delay, device waveforms, or physical signoff."}

    def finish(status, reason=None, value=None):
        report["status"] = status
        if reason:
            report["reason"] = reason
        report["elapsed_s"] = time.monotonic() - started
        return value, report

    if algorithm not in ("compact", "june_random"):
        return finish("invalid", "Only irregular-clock Compact/June candidates may be rephased")
    if not isinstance(timeout_s, (int, float)) or not math.isfinite(timeout_s) or timeout_s <= 0:
        return finish("invalid", "timeout_s must be finite and positive")
    deadline = started + timeout_s
    max_run = 4 if algorithm == "compact" else 10
    report["max_same_phase_tiles"] = max_run
    # June's existing hasAcceptableAssignedRoutePhases additionally caps the
    # repeated adjacent occurrences at 30 percent. Compact retains its own
    # route-local run limit without importing a new June-specific rule.
    report["max_same_phase_step_fraction"] = 0.3 if algorithm == "june_random" else None
    try:
        if candidate.get("algorithm", algorithm) != algorithm or candidate.get("clock_scheme") not in (None, "irregular"):
            return finish("invalid", "Candidate algorithm/clock scheme is not the requested irregular backend")
        if candidate.get("routed") is not True or candidate.get("native_mapping_valid") is not True:
            return finish("invalid", "A routed baseline with successful native mapping validation is required")
        geometry_check = validate_candidate(candidate, source_crossings=algorithm == "june_random")
        if not geometry_check["passed"]:
            report["validation_errors"] = geometry_check["errors"]
            return finish("invalid", "Baseline candidate fails existing static layout validation")
        nodes = {int(n["id"]): n for n in candidate["nodes"]}
        paths = [((int(r["source"]), int(r["target"])), [tuple(map(int, p)) for p in r["path"]])
                 for r in candidate["routes"]]
        cells = {(int(c["x"]), int(c["y"])): int(c["phase"]) for c in candidate["cells"]}
        if len(cells) != len(candidate["cells"]) or any(p not in (1, 2, 3, 4) for p in cells.values()):
            return finish("invalid", "Duplicate or out-of-range clock resources")
        counts = {"nodes": len(nodes), "routes": len(paths), "occurrences": sum(len(p) for _, p in paths),
                  "steps": sum(len(p)-1 for _, p in paths)}
        report["problem_size"] = counts
        if any(counts[k] > limit for k, limit in LIMITS.items()) or len(cells) > LIMITS["occurrences"]:
            return finish("unknown", "bounded_problem_size_limit")
        report["geometry_sha256"] = _geometry_digest(candidate)
        report["baseline_native_mapping_valid"] = candidate.get("native_mapping_valid") is True
        parent_nodes = defaultdict(set)
        for (a, b), path in paths:
            parent_nodes[b].add(a)
        pi_ids = [i for i, node in nodes.items() if node.get("is_input")]
        if not pi_ids or any(bool(node.get("is_input")) != (not parent_nodes[i]) for i, node in nodes.items()):
            return finish("invalid", "Every undriven node must be a primary input, with no driven primary inputs")
        horizon = 3 + counts["steps"]
        lower, upper, var_index = [], [], {}

        def variable(key, lo=0, hi=horizon):
            if key not in var_index:
                var_index[key] = len(lower)
                lower.append(lo)
                upper.append(hi)
            return var_index[key]

        rows, columns, coefficients, constraint_lower, constraint_upper = [], [], [], [], []

        def constrain(terms, lo, hi):
            row = len(constraint_lower)
            for col, coefficient in terms.items():
                if coefficient:
                    rows.append(row)
                    columns.append(col)
                    coefficients.append(coefficient)
            constraint_lower.append(lo)
            constraint_upper.append(hi)

        phase_vars = {p: variable(("phase", p), 0, 3) for p in cells}
        node_vars = {}
        for i, node in nodes.items():
            phase = cells[int(node["x"]), int(node["y"])] - 1
            node_vars[i] = variable(("node", i), phase if i in pi_ids and preserve_pi_phases else 0,
                                   (phase if preserve_pi_phases else 3) if i in pi_ids else horizon)
        # A shared fanout prefix is the same signal occurrence, not merely a
        # same-phase crossing. Different source trees share phase only.
        occurrences, phase_linked = [], set()
        for (a, b), path in paths:
            variables = []
            for index, p in enumerate(path):
                tick = node_vars[a] if index == 0 else node_vars[b] if index == len(path)-1 else variable(("trunk", a, p))
                variables.append(tick)
                if (tick, p) not in phase_linked:
                    phase_linked.add((tick, p))
                    epoch = variable(("epoch", tick, p), 0, horizon // 4)
                    constrain({tick: 1, phase_vars[p]: -1, epoch: -4}, 0, 0)
            for previous, current in zip(variables, variables[1:]):
                constrain({current: 1, previous: -1}, 0, 1)
            for index in range(len(variables) - max_run):
                constrain({variables[index+max_run]: 1, variables[index]: -1}, 1, max_run)
            occurrences.append(((a, b), path, variables))
        if algorithm == "june_random":
            total_advance = defaultdict(int)
            for (a, b), _, _ in occurrences:
                total_advance[node_vars[b]] += 1
                total_advance[node_vars[a]] -= 1
            constrain(total_advance, (7 * counts["steps"] + 9) // 10, counts["steps"])
        model = {"lower": lower, "upper": upper, "rows": rows, "columns": columns,
                 "coefficients": coefficients, "constraint_lower": constraint_lower,
                 "constraint_upper": constraint_upper, "time_limit": max(0.001, deadline - time.monotonic())}
        solution = _solve(model, deadline)
        if solution.get("status") != "sat":
            return finish(solution.get("status", "unknown"), solution.get("reason", "No certified feasible assignment"))
        if time.monotonic() >= deadline:
            return finish("unknown", "wall_clock_timeout")
        raw = solution.get("values", [])
        if len(raw) != len(lower) or any(not math.isfinite(x) or abs(x-round(x)) > 1e-6 for x in raw):
            return finish("unknown", "Solver did not return a complete integral solution")
        values = [int(round(x)) for x in raw]
        if any(not lo <= x <= hi for x, lo, hi in zip(values, lower, upper)):
            return finish("unknown", "Solver solution violates variable bounds")
        # Check every integer constraint independently of the solver status.
        sums = [0] * len(constraint_lower)
        for row, column, coefficient in zip(rows, columns, coefficients):
            sums[row] += values[column] * coefficient
        if any(not lo <= value <= hi for value, lo, hi in zip(sums, constraint_lower, constraint_upper)):
            return finish("unknown", "Solver solution violates exact integer constraints")
        new = copy.deepcopy(candidate)
        for cell in new["cells"]:
            cell["phase"] = values[phase_vars[int(cell["x"]), int(cell["y"])]] + 1
        new_phases = {(c["x"], c["y"]): c["phase"]-1 for c in new["cells"]}
        checked_arrivals, hold_steps, actual_max_run = {}, 0, 1
        trunk_ticks = {}
        for (a, b), path, _ in occurrences:
            tick = values[node_vars[a]]
            run = 1
            for index, p in enumerate(path):
                if index:
                    delta = (new_phases[p] - new_phases[path[index-1]]) % 4
                    if delta not in (0, 1):
                        return finish("unknown", "Independent phase progression check failed")
                    tick += delta
                    run = run+1 if delta == 0 else 1
                    hold_steps += delta == 0
                    actual_max_run = max(actual_max_run, run)
                if tick % 4 != new_phases[p]:
                    return finish("unknown", "Independent absolute tick/phase check failed")
                if 0 < index < len(path)-1:
                    key = a, p
                    if key in trunk_ticks and trunk_ticks[key] != tick:
                        return finish("unknown", "Shared fanout trunk has different token epochs")
                    trunk_ticks[key] = tick
            if tick != values[node_vars[b]] or b in checked_arrivals and checked_arrivals[b] != tick:
                return finish("unknown", "Independent reconvergent arrival check failed")
            checked_arrivals[b] = tick
        if actual_max_run > max_run or algorithm == "june_random" and hold_steps * 10 > counts["steps"] * 3:
            return finish("unknown", "Independent same-phase-run check failed")
        for i in pi_ids:
            node = nodes[i]
            p = int(node["x"]), int(node["y"])
            if (values[node_vars[i]] != new_phases[p] or not 0 <= values[node_vars[i]] <= 3
                    or preserve_pi_phases and new_phases[p] != cells[p]-1):
                return finish("unknown", "Independent cycle-zero PI anchor check failed")
        final_validation = validate_candidate(new, source_crossings=algorithm == "june_random")
        if not final_validation["passed"] or _geometry_digest(new) != report["geometry_sha256"]:
            return finish("unknown", "Rephased candidate failed static geometry validation")
        report.update(pi_phases_preserved=all(new_phases[int(nodes[i]["x"]), int(nodes[i]["y"])] == cells[int(nodes[i]["x"]), int(nodes[i]["y"])]-1 for i in pi_ids),
                      changed_tiles=sum(cells[p]-1 != phase for p, phase in new_phases.items()),
                      actual_max_same_phase_tiles=actual_max_run, same_phase_steps=hold_steps,
                      node_arrival_ticks={str(i): values[v] for i, v in node_vars.items()},
                      pi_launch_ticks={nodes[i]["name"]: values[node_vars[i]] for i in pi_ids},
                      validation_passed=True)
        # A phase change must not inherit a prior native/device acceptance flag.
        # The caller must export and map this new candidate, then validate the
        # resulting actual IFCN/QCA before considering it for selection.
        new["native_mapping_valid"] = False
        new["native_validation_error"] = "Clock phases changed; fresh exported IFCN device mapping is required"
        new["rephasing"] = {"status": "sat", "launch_policy": report["launch_policy"],
                            "requires_fresh_export_mapping": True, "geometry_sha256": report["geometry_sha256"]}
        if time.monotonic() >= deadline:
            return finish("unknown", "wall_clock_timeout")
        return finish("sat", value=new)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        return finish("invalid", str(exc))


def rephase_candidate(candidate, algorithm, timeout_s):
    """Find a bounded common-cycle-zero assignment, without changing geometry.

    First retain the original PI phases. Only a proved UNSAT permits a second
    attempt with freely assigned PI phases (still tick 0..3 in cycle zero).
    Both attempts share one wall-clock budget; no input vector epoch is shifted.
    A returned candidate must pass a fresh exported-IFCN/device-mapping check.
    """
    started = time.monotonic()
    value, report = _rephase_once(candidate, algorithm, timeout_s, True)
    attempts = [{k: report[k] for k in ("pi_phase_policy", "status", "reason", "elapsed_s") if k in report}]
    if report["status"] == "unsat":
        remaining = timeout_s - (time.monotonic() - started)
        if remaining > 0:
            value, report = _rephase_once(candidate, algorithm, remaining, False)
            attempts.append({k: report[k] for k in ("pi_phase_policy", "status", "reason", "elapsed_s") if k in report})
        else:
            value = None
            report.update(status="unknown", reason="wall_clock_timeout")
    report["attempts"] = attempts
    report["elapsed_s"] = time.monotonic() - started
    if value is not None and report["elapsed_s"] >= timeout_s:
        value = None
        report.update(status="unknown", reason="wall_clock_timeout", validation_passed=False)
    return value, report


if __name__ == "__main__":
    if sys.argv[1:] != ["--solve-milp"]:
        raise SystemExit("This module is called through rephase_candidate(candidate, algorithm, timeout_s).")
    _milp_worker()
