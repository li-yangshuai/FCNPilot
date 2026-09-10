#!/usr/bin/env python3
"""Exercise physical feedback and fail-closed export through the native CLI."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

EXECUTABLE = Path(sys.argv.pop(1)).resolve()
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "sequential"


def paths_and_phases(text: str):
    routes = []
    distance = None
    for line in text.splitlines():
        if line.startswith("#iteration_distance="):
            distance = int(line.split("=", 1)[1])
        match = re.fullmatch(r"\((\d+),(\d+)\): (.+);", line)
        if match and distance is not None:
            coordinates = [tuple(map(int, pair)) for pair in re.findall(r"\((\d+),(\d+)\)", match[3])]
            routes.append((int(match[1]), int(match[2]), distance, coordinates))
            distance = None
    phase_section = text.split("#phase map")[1]
    phases = {(int(x), int(y)): int(phase) for x, y, phase in re.findall(r"\((\d+),(\d+)\): (\d+);", phase_section)}
    return routes, phases


def reaches(edges, start, end):
    queue, seen = [start], set()
    while queue:
        current = queue.pop()
        if current == end:
            return True
        if current in seen:
            continue
        seen.add(current)
        queue.extend(sink for source, sink in edges if source == current)
    return False


class SequentialNativeRegression(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fcnpilot-sequential-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def run_case(self, fixture="toggle_ff_cut.v", state="d:q", extras=(), name="candidate"):
        output = self.root / f"{name}.ifcn"
        command = [str(EXECUTABLE), str(FIXTURES / fixture), str(output),
                   "--state", state, "--ii", "4,8", "--spacing", "2",
                   "--route-search-cost", "80", "--compaction-max-states", "256",
                   "--compaction-seeds", "16", *map(str, extras)]
        result = subprocess.run(command, text=True, capture_output=True, timeout=35)
        return result, output

    def assert_candidate(self, result, output, state):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(output.with_suffix(".ifcn.json").read_text())
        self.assertEqual(report["status"], "layout_candidate")
        self.assertEqual(report["physical_state_signoff"], "not_characterized")
        self.assertEqual(report["rtl_equivalence"], "not_checked_by_native_pnr")
        self.assertEqual(report["state_boundary_count"], 1)
        data, q = state.split(":")
        self.assertEqual(report["state_boundaries"], [{"data_event": data, "q_event": q, "iteration_distance": 1}])
        self.assertTrue(report["mapping_drc"])
        self.assertTrue(report["tile_phase_drc"])
        self.assertTrue(report["directed_cycle_present"])
        self.assertFalse(report["geometry_optimization"]["global_pnr_optimality_claimed"])
        routes, phases = paths_and_phases(output.read_text())
        self.assertEqual(len(routes), report["routes"])
        feedback = [route for route in routes if route[2] == 1]
        self.assertEqual(len(feedback), report["feedback_routes"])
        self.assertGreater(len(feedback), 0)
        edges = [(source, sink) for source, sink, _, _ in routes]
        # A feedback label alone is insufficient: independently find a return
        # path in the exported graph, so deleting the closed loop fails here.
        self.assertTrue(any(reaches(edges, sink, source) for source, sink, _, _ in feedback))
        for _, _, _, path in routes:
            self.assertGreaterEqual(len(path), 2)
            self.assertEqual(len(path), len(set(path)))
            run = 1
            for previous, current in zip(path, path[1:]):
                self.assertEqual(abs(previous[0] - current[0]) + abs(previous[1] - current[1]), 1)
                advance = (phases[current] - phases[previous]) % 4
                self.assertIn(advance, (0, 1))
                run = run + 1 if advance == 0 else 1
                self.assertLessEqual(run, report["max_same_phase_tiles"])
        return report, routes

    def test_toggle_contains_complete_feedback_and_clock_problem(self):
        problem = self.root / "clock.json"
        tex = self.root / "candidate.tex"
        result, output = self.run_case(extras=("--clock-problem-out", problem, "--tex", tex))
        report, routes = self.assert_candidate(result, output, "d:q")
        self.assertEqual(report["initiation_interval"], 4)
        self.assertEqual(report["state_boundary_count"], 1)
        self.assertEqual((len(routes), report["feedback_routes"]), (2, 1))
        clock = json.loads(problem.read_text())
        self.assertEqual(clock["occurrence_granularity"], "tile")
        self.assertEqual(sorted(route["iteration_distance"] for route in clock["routes"]), [0, 1])
        self.assertTrue(tex.is_file())
        # For this inverter ring every cycle edge must advance at II=4.
        self.assertEqual(sum(len(route[3]) - 1 for route in routes), 4)

    def test_enable_hold_feedback_is_not_replaced_by_primary_input(self):
        result, output = self.run_case("enable_hold_ff_cut.v", "d0:q0")
        report, _ = self.assert_candidate(result, output, "d0:q0")
        self.assertGreater(report["nodes"], 2)
        self.assertGreater(report["mapped_layer_cell_records"], 0)

        self.assertEqual(report["cell_count_basis"], "unique_xy_layer_sites")
        self.assertEqual(report["mapped_qca_cells"], report["mapped_layer_cell_records"])
        # This fixture exercises crossing pillars, so a count of XY locations
        # cannot accidentally pass as a count of actual physical QCA cells.
        self.assertGreater(report["mapped_qca_cells"], report["mapped_unique_xy_sites"])
        metrics = EXECUTABLE.with_name("ifcn_mapping_metrics")
        energy = EXECUTABLE.with_name("ifcn_energy_analysis")
        for contract in (False, True):
            prefix = self.root / ("contracted" if contract else "full")
            metric_command = [str(metrics), str(output)]
            if not contract:
                metric_command.append("--no-io-contraction")
            measured = subprocess.run(metric_command, capture_output=True, text=True, timeout=10)
            self.assertEqual(measured.returncode, 0, measured.stderr)
            export_command = [str(energy), str(output), str(prefix), "--qca-only"]
            if contract:
                export_command.append("--io-contraction")
            exported = subprocess.run(export_command, capture_output=True, text=True, timeout=10)
            self.assertEqual(exported.returncode, 0, exported.stderr)
            text = Path(str(prefix) + "_energy_input.qca").read_text()
            cells, layer = [], 0
            for block in text.split("[TYPE:QCADLayer]")[1:]:
                if not block.lstrip().startswith("type=1\n"):
                    continue
                for x, y in re.findall(r"\[TYPE:QCADCell\]\s*\[TYPE:QCADDesignObject\]\s*x=([^\n]+)\s*y=([^\n]+)", block):
                    cells.append((float(x), float(y), layer))
                layer += 1
            self.assertEqual(len(cells), text.count("[TYPE:QCADCell]"))
            self.assertEqual(len(cells), len(set(cells)))
            self.assertEqual(len(cells), int(measured.stdout.split()[0]))
            if not contract:
                self.assertEqual(len(cells), report["mapped_qca_cells"])
                self.assertEqual(len({(x, y) for x, y, _ in cells}), report["mapped_unique_xy_sites"])
                self.assertEqual({layer for _, _, layer in cells}, {0, 1, 2})

    def test_geometry_only_does_not_emit_validated_layout(self):
        problem = self.root / "clock.json"
        result, output = self.run_case(extras=("--defer-phase", "--clock-problem-out", problem))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("geometry_ready", result.stdout)
        self.assertTrue(problem.is_file())
        self.assertFalse(output.exists())
        self.assertFalse(output.with_suffix(".ifcn.json").exists())

    def test_external_phase_solution_is_independently_checked(self):
        problem_path = self.root / "clock.json"
        result, output = self.run_case(extras=("--clock-problem-out", problem_path))
        self.assert_candidate(result, output, "d:q")
        problem = json.loads(problem_path.read_text())
        # Independent exact solution for d -> not(q) -> d, with one
        # distance-one route: d is epoch 0 and not(q) is epoch -1.
        events = {"d": 0, "~q": -1}
        occurrence_epoch = {}
        resource_phase = {}
        occurrences = {entry["id"]: entry for entry in problem["occurrences"]}
        for route in problem["routes"]:
            for step, identifier in enumerate(route["occurrences"]):
                epoch = events[route["source_event"]] + step
                occurrence_epoch[identifier] = epoch
                resource = occurrences[identifier]["clock_resource"]
                if resource in resource_phase:
                    self.assertEqual(resource_phase[resource], epoch % 4)
                resource_phase[resource] = epoch % 4
            self.assertEqual(epoch, events[route["sink_event"]] + route["iteration_distance"] * 4)
        lines = ["ifcn.global-clock-solution.v1", "status\tSAT", "phase_count\t4", "ii\t4"]
        lines += [f"event\t{key}\t{value}" for key, value in events.items()]
        lines += [f"occurrence\t{key}\t{value}" for key, value in occurrence_epoch.items()]
        lines += [f"resource\t{key}\t{value}" for key, value in resource_phase.items()]
        solution = self.root / "solution.tsv"
        solution.write_text("\n".join(lines) + "\n")
        valid, valid_output = self.run_case(extras=("--phase-solution", solution), name="external")
        report, _ = self.assert_candidate(valid, valid_output, "d:q")
        self.assertEqual(report["phase_backend"], "external_phase_solution")
        # A syntactically SAT file with the wrong recurrence is not accepted.
        solution.write_text(solution.read_text().replace("event\td\t0", "event\td\t1"))
        invalid, invalid_output = self.run_case(extras=("--phase-solution", solution), name="invalid")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("validation failed", invalid.stderr)
        self.assertFalse(invalid_output.exists())
        self.assertFalse(invalid_output.with_suffix(".ifcn.json").exists())

    def test_invalid_state_boundary_fails_before_export(self):
        for name, state, extra in [("missing", "absent:q", ()), ("duplicate", "d:q", ("--state", "d:q"))]:
            with self.subTest(name=name):
                result, output = self.run_case(state=state, extras=extra, name=name)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
                self.assertFalse(output.with_suffix(".ifcn.json").exists())


if __name__ == "__main__":
    unittest.main()
