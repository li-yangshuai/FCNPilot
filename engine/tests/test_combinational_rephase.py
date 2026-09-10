"""Clock assignment regressions with frozen real June geometries and strict limits."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ifcn_combinational_rephase as rephase
from ifcn_agent_clock_validation import validate_clock_arrivals
from ifcn_agent_layout_validation import dag_from_candidate, export_native_ifcn, validate_candidate
from verify_routed_logic import audit_case

FIXTURES = ROOT / "tests/fixtures/combinational_rephase"
BUILD = Path(os.environ.get("IFCN_BUILD_DIR", str(ROOT / "build")))


def fixture(name):
    return json.loads((FIXTURES / (name + ".json")).read_text())


def independent_arrivals(candidate, directory):
    output = directory / "layout.ifcn"
    export_native_ifcn(candidate, output, candidate["algorithm"])
    validation = validate_candidate(candidate, source_crossings=candidate["algorithm"] == "june_random")
    dag = dag_from_candidate(candidate, validation)
    return validate_clock_arrivals(output.read_text(), dag), output, dag


class CombinationalRephase(unittest.TestCase):
    def test_real_xnor_preserves_geometry_pi_phases_and_device_count(self):
        candidate = fixture("xnor2")
        untouched = copy.deepcopy(candidate)
        value, report = rephase.rephase_candidate(candidate, "june_random", 8)
        self.assertEqual(report["status"], "sat", report)
        self.assertTrue(report["pi_phases_preserved"])
        self.assertEqual(candidate, untouched)
        self.assertFalse(value["native_mapping_valid"])
        self.assertTrue(report["requires_fresh_export_mapping"])
        self.assertGreater(report["changed_tiles"], 0)
        for key in ("nodes", "edges", "routes", "layers"):
            self.assertEqual(candidate[key], value[key])
        self.assertLessEqual(report["actual_max_same_phase_tiles"], 10)
        self.assertLessEqual(report["same_phase_steps"] * 10, report["problem_size"]["steps"] * 3)
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            before, _, _ = independent_arrivals(candidate, directory)
            self.assertFalse(before["passed"])
            self.assertFalse(before["relative_schedule_consistent"])
            after, output, dag = independent_arrivals(value, directory)
            self.assertTrue(after["passed"], after)
            dag_path = directory / "dag.json"
            dag_path.write_text(json.dumps(dag))
            self.assertEqual(audit_case(FIXTURES / "xnor2.v", dag_path, max_inputs=11)["status"], "equivalent")
            mapper = BUILD / "ifcn_mapping_metrics"
            if mapper.is_file():
                result = subprocess.run([str(mapper), str(output), "--no-io-contraction"],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(int(result.stdout.split()[-2]), 234)
            energy = BUILD / "ifcn_energy_analysis"
            if energy.is_file():
                prefix = output.with_name("device")
                result = subprocess.run([str(energy), str(output), str(prefix), "--qca-only"],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                qca = Path(str(prefix) + "_energy_input.qca").read_text()
                self.assertEqual(qca.count("[TYPE:QCADCell]"), 234)
                self.assertEqual(qca.count("cell_function=QCAD_CELL_INPUT\n"), 2)
                self.assertEqual(qca.count("cell_function=QCAD_CELL_OUTPUT\n"), 1)

    def test_real_xor_unfreezes_phase_only_after_proved_unsat(self):
        candidate = fixture("xor2")
        value, report = rephase.rephase_candidate(candidate, "june_random", 8)
        self.assertEqual(report["status"], "sat", report)
        self.assertEqual([a["status"] for a in report["attempts"]], ["unsat", "sat"])
        self.assertFalse(report["pi_phases_preserved"])
        self.assertTrue(all(0 <= t <= 3 for t in report["pi_launch_ticks"].values()))
        self.assertLessEqual(report["same_phase_steps"] * 10, report["problem_size"]["steps"] * 3)
        with tempfile.TemporaryDirectory() as tmp:
            after, output, dag = independent_arrivals(value, Path(tmp))
            self.assertTrue(after["passed"], after)
            dag_path = Path(tmp) / "dag.json"
            dag_path.write_text(json.dumps(dag))
            self.assertEqual(audit_case(FIXTURES / "xor2.v", dag_path, max_inputs=11)["status"], "equivalent")
            mapper = BUILD / "ifcn_mapping_metrics"
            if mapper.is_file():
                result = subprocess.run([str(mapper), str(output), "--no-io-contraction"],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(int(result.stdout.split()[-2]), 160)
            energy = BUILD / "ifcn_energy_analysis"
            if energy.is_file():
                prefix = output.with_name("device")
                result = subprocess.run([str(energy), str(output), str(prefix), "--qca-only"],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                qca = Path(str(prefix) + "_energy_input.qca").read_text()
                self.assertEqual(qca.count("[TYPE:QCADCell]"), 160)
                self.assertEqual(qca.count("cell_function=QCAD_CELL_INPUT\n"), 2)
                self.assertEqual(qca.count("cell_function=QCAD_CELL_OUTPUT\n"), 1)

    def test_compact_same_input_detour_cannot_bypass_four_tile_limit(self):
        # Direct fanout reaches y in <=1 tick. The other branch traverses two
        # routes of 5/6 steps; the four-tile same-phase cap needs >=2 ticks.
        a, b, y = (0, 0), (0, 5), (1, 0)
        first = [(0, i) for i in range(6)]
        second = [b] + [(1, i) for i in range(5, -1, -1)]
        phases = {p: (i % 4) + 1 for i, p in enumerate(first)}
        for p, phase in zip(second, [2, 3, 4, 1, 2, 2, 2]):
            phases[p] = phase
        phases[y] = 2
        candidate = {"algorithm": "compact", "routed": True, "native_mapping_valid": True,
                     "nodes": [{"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False, "x": 0, "y": 0},
                               {"id": 1, "name": "b", "type": "buffer", "is_input": False, "is_output": False, "x": 0, "y": 5},
                               {"id": 2, "name": "y", "type": "and", "is_input": False, "is_output": True, "x": 1, "y": 0}],
                     "edges": [[0, 1], [1, 2], [0, 2]], "layers": [[0], [1], [2]],
                     "routes": [{"source": 0, "target": 1, "path": first}, {"source": 1, "target": 2, "path": second},
                                {"source": 0, "target": 2, "path": [a, y]}],
                     "cells": [{"x": p[0], "y": p[1], "phase": phase} for p, phase in phases.items()]}
        self.assertTrue(validate_candidate(candidate)["passed"])
        value, report = rephase.rephase_candidate(candidate, "compact", 8)
        self.assertIsNone(value)
        self.assertEqual(report["status"], "unsat", report)
        self.assertEqual(report["max_same_phase_tiles"], 4)
        self.assertEqual([a["status"] for a in report["attempts"]], ["unsat", "unsat"])

    def test_fixed_clock_invalid_geometry_and_failed_native_baseline_rejected(self):
        for mutation in ("template", "geometry", "native"):
            candidate = fixture("xor2")
            if mutation == "template":
                candidate["clock_scheme"] = "2DDWave"
            elif mutation == "geometry":
                candidate["routes"][0]["path"].pop(1)
            else:
                candidate["native_mapping_valid"] = False
            with self.subTest(mutation=mutation), patch.object(rephase, "_solve") as solver:
                value, report = rephase.rephase_candidate(candidate, "june_random", 8)
                self.assertIsNone(value)
                self.assertEqual(report["status"], "invalid")
                solver.assert_not_called()

    def test_unknown_does_not_retry_or_return_candidate(self):
        with patch.object(rephase, "_solve", return_value={"status": "unknown", "reason": "wall_clock_timeout"}) as solver:
            value, report = rephase.rephase_candidate(fixture("xor2"), "june_random", 8)
        self.assertIsNone(value)
        self.assertEqual(report["status"], "unknown")
        self.assertEqual(len(report["attempts"]), 1)
        solver.assert_called_once()

    def test_incorrect_integral_solver_solution_is_rejected(self):
        def forged(model, deadline):
            return {"status": "sat", "values": [0] * len(model["lower"])}
        with patch.object(rephase, "_solve", side_effect=forged):
            value, report = rephase.rephase_candidate(fixture("xor2"), "june_random", 8)
        self.assertIsNone(value)
        self.assertEqual(report["status"], "unknown")
        self.assertIn("bounds", report["reason"])

    def test_fallback_receives_only_remaining_shared_budget(self):
        budgets = []
        def attempt(candidate, algorithm, budget, fixed):
            budgets.append(budget)
            time.sleep(0.02)
            return None, {"status": "unsat" if fixed else "unknown", "elapsed_s": 0.02,
                          "pi_phase_policy": "fixed_original" if fixed else "free_within_cycle_zero"}
        with patch.object(rephase, "_rephase_once", side_effect=attempt):
            value, report = rephase.rephase_candidate({}, "june_random", 1)
        self.assertIsNone(value)
        self.assertEqual(len(budgets), 2)
        self.assertLess(budgets[1], budgets[0] - 0.015)
        self.assertGreater(report["elapsed_s"], 0.035)

    def test_real_worker_is_killed_at_wall_clock_budget(self):
        original_popen = subprocess.Popen
        spawned = []
        def slow_worker(*args, **kwargs):
            child = original_popen([sys.executable, "-c", "import time; time.sleep(10)"], **kwargs)
            spawned.append(child)
            return child
        started = time.monotonic()
        with patch.object(rephase.subprocess, "Popen", side_effect=slow_worker):
            result = rephase._solve({}, started + 0.08)
        self.assertEqual(result["status"], "unknown")
        self.assertLess(time.monotonic()-started, 1.5)
        self.assertIsNotNone(spawned[0].poll())


if __name__ == "__main__":
    unittest.main()
