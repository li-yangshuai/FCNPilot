"""Explicit placement edits preserve the DAG and remain independently checkable."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("IFCN_BUILD_DIR", ROOT / "build"))
FIXTURES = ROOT / "tests/fixtures/combinational_rephase"
sys.path.insert(0, str(ROOT / "scripts"))
from ifcn_agent_clock_validation import validate_clock_arrivals
from ifcn_agent_layout_validation import validate_candidate, dag_from_candidate, export_native_ifcn
from ifcn_combinational_rephase import rephase_candidate
from verify_routed_logic import verify_bytes


class NativeLayoutEditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fcn-coordinate-edit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = FIXTURES / "xor2.v"
        self.baseline = json.loads((FIXTURES / "xor2.json").read_text())
        self.serial = 0

    def invoke(self, operations, *, baseline=None, extra=(), proposal=None):
        self.serial += 1
        directory = self.root / str(self.serial)
        directory.mkdir()
        original = directory / "baseline.json"
        original.write_text(json.dumps(self.baseline if baseline is None else baseline))
        initial = hashlib.sha256(original.read_bytes()).hexdigest()
        request = directory / "proposal.json"
        request.write_text(json.dumps(proposal if proposal is not None else {
            "schema": "ifcn.layout_edit.v1", "operations": operations,
            "rationale": "Deterministic test fixture, not an LLM experiment.",
        }))
        output = directory / "candidate.json"
        result = subprocess.run([str(BUILD / "ifcn_layout_edit"), str(self.source),
                                 str(original), str(request), str(output), *extra],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), initial)
        return result, json.loads(output.read_text()) if output.exists() else None, directory

    def assert_success(self, result, candidate):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(candidate["native_mapping_valid"])
        self.assertTrue(candidate["edit"]["requires_strict_clock_and_qca_export"])
        self.assertEqual(candidate["algorithm"], self.baseline["algorithm"])
        self.assertEqual(candidate["clock_scheme"], "irregular")
        self.assertEqual(candidate["topology"], self.baseline["topology"])
        self.assertEqual(candidate["edges"], self.baseline["edges"])
        self.assertEqual(candidate["edit"]["coordinate_translation"], [0, 0])
        # Check clock rules from the actual route occurrences independently.
        phases = {(cell["x"], cell["y"]): cell["phase"] for cell in candidate["cells"]}
        holds = steps = longest = 0
        for route in candidate["routes"]:
            run = 1
            for a, b in zip(route["path"], route["path"][1:]):
                p, q = phases[tuple(a)], phases[tuple(b)]
                self.assertIn((q - p) % 4, (0, 1))
                steps += 1
                holds += p == q
                run = run + 1 if p == q else 1
                longest = max(longest, run)
        limit = 4 if candidate["algorithm"] == "compact" else 10
        self.assertLessEqual(longest, limit)
        if candidate["algorithm"] == "june_random":
            self.assertLessEqual(holds * 10, steps * 3)
        clock = candidate["edit"]["clock_constraints"]
        self.assertTrue(clock["passed"])
        self.assertEqual((clock["same_phase_steps"], clock["total_steps"]), (holds, steps))

    def test_noop_reroute_control_preserves_all_coordinates_and_paths(self):
        baseline = copy.deepcopy(self.baseline)
        # A repaired candidate must be re-exported. Its invalidated historical
        # mapping flag cannot make the independent coordinate-edit route unusable.
        baseline["native_mapping_valid"] = False
        result, candidate, _ = self.invoke([], baseline=baseline)
        self.assert_success(result, candidate)
        self.assertEqual(candidate["nodes"], baseline["nodes"])
        self.assertEqual(candidate["routes"], baseline["routes"])
        self.assertEqual(candidate["edit"]["node_changes"], [])
        self.assertEqual(candidate["edit"]["route_changes"], [])

    def test_explicit_output_move_passes_fresh_logic_clock_and_actual_qca_checks(self):
        result, candidate, directory = self.invoke([{"op": "move", "node": 2, "to": [21, 28]}])
        self.assert_success(result, candidate)
        expected = copy.deepcopy(self.baseline["nodes"])
        next(node for node in expected if node["id"] == 2)["y"] = 28
        self.assertEqual(candidate["nodes"], expected)
        self.assertEqual(candidate["edit"]["node_changes"], [
            {"node": 2, "name": "out", "from": [21, 29], "to": [21, 28]}])
        self.assertEqual(candidate["edit"]["changed_route_count"], 2)
        old = {(r["source"], r["target"]): r["path"] for r in self.baseline["routes"]}
        new = {(r["source"], r["target"]): r["path"] for r in candidate["routes"]}
        for change in candidate["edit"]["route_changes"]:
            key = (change["source"], change["target"])
            self.assertEqual(change["before"], old[key])
            self.assertEqual(change["after"], new[key])
        repaired, report = rephase_candidate(candidate, "june_random", 8)
        self.assertEqual(report["status"], "sat", report)
        self.assertEqual(repaired["nodes"], expected)
        validation = validate_candidate(repaired, source_crossings=True)
        self.assertTrue(validation["passed"], validation)
        dag = dag_from_candidate(repaired, validation)
        logic = verify_bytes(self.source.read_bytes(), json.dumps(dag).encode())
        self.assertEqual((logic["status"], logic["vectors_checked"]), ("equivalent", 4))
        ifcn = directory / "layout.ifcn"
        export_native_ifcn(repaired, ifcn, "june_random")
        self.assertTrue(validate_clock_arrivals(ifcn.read_text(), dag)["passed"])
        export = subprocess.run([str(BUILD / "ifcn_energy_analysis"), str(ifcn),
                                 str(directory / "device"), "--qca-only"],
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(export.returncode, 0, export.stderr)
        qca = (directory / "device_energy_input.qca").read_text()
        certificate = json.loads((directory / "device_physical_validation.json").read_text())
        self.assertTrue(certificate["passed"])
        self.assertEqual(qca.count("[TYPE:QCADCell]"), 150)
        self.assertEqual(certificate["cell_count"], 150)
        self.assertEqual(qca.count("cell_function=QCAD_CELL_INPUT\n"), 2)
        self.assertEqual(qca.count("cell_function=QCAD_CELL_OUTPUT\n"), 1)

    def test_swap_is_exact_and_does_not_claim_an_improvement(self):
        result, candidate, _ = self.invoke([{"op": "swap", "nodes": [3, 4]}])
        self.assert_success(result, candidate)
        before = {node["id"]: (node["x"], node["y"]) for node in self.baseline["nodes"]}
        after = {node["id"]: (node["x"], node["y"]) for node in candidate["nodes"]}
        before[3], before[4] = before[4], before[3]
        self.assertEqual(after, before)
        self.assertEqual(candidate["edit"]["changed_node_count"], 2)
        self.assertGreater(candidate["edit"]["native_physical_cell_count"], 160)
        self.assertNotIn("improved", candidate["edit"])

    def test_compact_rerouting_retains_its_four_tile_clock_limit(self):
        self.source = ROOT / "tests/benchmarks_pi/v1/TOY/mux21.v"
        baseline_path = self.root / "compact.json"
        routed = subprocess.run([str(BUILD / "ifcn_combinational_pnr"), "compact",
                                 str(self.source), str(baseline_path)],
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(routed.returncode, 0, routed.stderr)
        self.baseline = json.loads(baseline_path.read_text())
        result, candidate, _ = self.invoke([])
        self.assert_success(result, candidate)
        self.assertEqual(candidate["nodes"], self.baseline["nodes"])
        self.assertEqual(candidate["edit"]["changed_node_count"], 0)
        self.assertEqual(candidate["edit"]["clock_constraints"]["max_same_phase_tiles"], 4)
        self.assertIsNone(candidate["edit"]["clock_constraints"]["max_same_phase_step_fraction"])

    def test_failed_physical_candidate_is_retained_without_replacing_the_baseline(self):
        self.source = ROOT / "tests/benchmarks_pi/v1/TOY/mux41.v"
        baseline_path = self.root / "coarse_candidate.json"
        routed = subprocess.run([str(BUILD / "ifcn_combinational_pnr"), "june_random",
                                 str(self.source), str(baseline_path), "--topology", "optimized_buffers"],
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(routed.returncode, 0, routed.stderr)
        self.baseline = json.loads(baseline_path.read_text())
        result, candidate, _ = self.invoke([])
        self.assertEqual(result.returncode, 10)
        self.assertIsNotNone(candidate)
        self.assertFalse(candidate["native_mapping_valid"])
        self.assertIn("missing a directed tile boundary", candidate["native_validation_error"])
        self.assertEqual(candidate["nodes"], self.baseline["nodes"])
        self.assertEqual(candidate["edit"]["node_changes"], [])

    def test_illegal_proposals_and_locked_io_are_rejected_without_touching_baseline(self):
        examples = [
            ([{"op": "move", "node": 99, "to": [21, 28]}], (), "unknown node"),
            ([{"op": "move", "node": 2, "to": [100, 28]}], (), "permitted range"),
            ([{"op": "move", "node": 2, "to": [22, 23]}], (), "node collision"),
            ([{"op": "move", "node": 2, "to": [21, 28]}], ("--lock-io",), "locked"),
            ([{"op": "delete", "node": 3}], (), "only move and swap"),
            ([{"op": "move", "node": 2, "to": [21.0, 28]}], (), "permitted range"),
            ([{"op": "swap", "nodes": [3, 3]}], (), "distinct node"),
            ([{"op": "move", "node": 2, "to": [21, 28], "clock": "2DDWave"}], (), "unsupported proposal field"),
        ]
        for operations, extra, error in examples:
            with self.subTest(error=error):
                result, candidate, _ = self.invoke(operations, extra=extra)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
                self.assertIsNone(candidate)

    def test_locked_io_accepts_two_exact_internal_moves_and_preserves_source_pins(self):
        operations = [{"op": "move", "node": 3, "to": [20, 23]},
                      {"op": "move", "node": 4, "to": [22, 23]}]
        request = {"schema": "ifcn.layout_search.v2", "operations": operations,
                   "routing_order": None, "rationale": "Coordinated internal move regression; not an optimization claim."}
        result, candidate, _ = self.invoke(operations, proposal=request, extra=("--lock-io",))
        self.assert_success(result, candidate)
        self.assertTrue(candidate["edit"]["io_locked"])
        expected = {n["id"]: (n["x"], n["y"]) for n in self.baseline["nodes"]}
        expected[3], expected[4] = expected[4], expected[3]
        self.assertEqual({n["id"]: (n["x"], n["y"]) for n in candidate["nodes"]}, expected)
        self.assertEqual({n["node"] for n in candidate["edit"]["node_changes"]}, {3, 4})
        self.assertEqual([n for n in candidate["nodes"] if n["is_input"] or n["is_output"]],
                         [n for n in self.baseline["nodes"] if n["is_input"] or n["is_output"]])

    def test_locked_io_rejects_input_moves_and_mixed_swaps_from_source_roles(self):
        for operations in [[{"op": "move", "node": 0, "to": [21, 20]}],
                           [{"op": "swap", "nodes": [0, 3]}],
                           [{"op": "swap", "nodes": [3, 2]}]]:
            with self.subTest(operations=operations):
                result, candidate, _ = self.invoke(operations, extra=("--lock-io",))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("I/O node is locked", result.stderr)
                self.assertIsNone(candidate)
        forged = copy.deepcopy(self.baseline); forged["nodes"][0]["is_input"] = False
        result, candidate, _ = self.invoke([], baseline=forged, extra=("--lock-io",))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("identity/type differs", result.stderr)
        self.assertIsNone(candidate)

    def test_v2_route_only_changes_paths_and_passes_fresh_logic_clock_and_qca(self):
        # This order differs from the executor's built-in priority policy.
        # Coordinates are identical, so any changed path is attributable to
        # the explicit routing decision rather than a placement edit.
        order = [[0, 3], [0, 4], [1, 3], [1, 4], [3, 5], [4, 2], [5, 2]]
        proposal = {"schema": "ifcn.layout_search.v2", "operations": [],
                    "routing_order": order, "rationale": "Route-only regression fixture."}
        result, candidate, directory = self.invoke([], proposal=proposal)
        self.assert_success(result, candidate)
        self.assertEqual(candidate["nodes"], self.baseline["nodes"])
        self.assertNotEqual(candidate["routes"], self.baseline["routes"])
        edit = candidate["edit"]
        self.assertEqual(edit["schema"], "ifcn.layout_search_result.v2")
        self.assertEqual(edit["node_changes"], [])
        self.assertEqual(edit["changed_route_count"], 2)
        self.assertTrue(edit["explicit_routing_order"])
        self.assertEqual(edit["requested_order"], order)
        self.assertEqual(edit["executed_order"], order)
        self.assertEqual(edit["route_order_attempts"], 1)
        self.assertFalse(edit["fallback_used"])
        # Altering the fallback budget must not change an explicit decision.
        replay, replay_candidate, _ = self.invoke([], proposal=proposal,
                                                  extra=("--route-retries", "64"))
        self.assert_success(replay, replay_candidate)
        self.assertEqual(replay_candidate["routes"], candidate["routes"])
        self.assertEqual(replay_candidate["edit"]["route_order_attempts"], 1)
        repaired, report = rephase_candidate(candidate, "june_random", 8)
        self.assertEqual(report["status"], "sat", report)
        validation = validate_candidate(repaired, source_crossings=True)
        self.assertTrue(validation["passed"], validation)
        dag = dag_from_candidate(repaired, validation)
        logic = verify_bytes(self.source.read_bytes(), json.dumps(dag).encode())
        self.assertEqual((logic["status"], logic["vectors_checked"]), ("equivalent", 4))
        ifcn = directory / "layout.ifcn"
        export_native_ifcn(repaired, ifcn, "june_random")
        self.assertTrue(validate_clock_arrivals(ifcn.read_text(), dag)["passed"])
        export = subprocess.run([str(BUILD / "ifcn_energy_analysis"), str(ifcn),
                                 str(directory / "device"), "--qca-only"],
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(export.returncode, 0, export.stderr)
        qca = (directory / "device_energy_input.qca").read_text()
        certificate = json.loads((directory / "device_physical_validation.json").read_text())
        self.assertTrue(certificate["passed"])
        self.assertEqual(certificate["cell_count"], 155)
        self.assertEqual(qca.count("[TYPE:QCADCell]"), 155)
        self.assertEqual(qca.count("cell_function=QCAD_CELL_INPUT\n"), 2)
        self.assertEqual(qca.count("cell_function=QCAD_CELL_OUTPUT\n"), 1)
        # Use the pipeline certificate wrappers as well as native counts;
        # the selected device file and IFCN geometry must be hash-bound.
        from ifcn_agent import qca_interface_report, physical_route_report
        qca_file = directory / "device_energy_input.qca"
        interface = qca_interface_report(qca_file, {"inputs": ["a", "b"], "outputs": ["out"]},
                                         directory / "interface.json")
        physical = physical_route_report(directory / "device_physical_validation.json",
                                         qca_file, interface, directory / "physical.json", ifcn)
        self.assertTrue(physical["passed"])
        self.assertEqual(physical["qca_sha256"], hashlib.sha256(qca_file.read_bytes()).hexdigest())
        self.assertEqual(physical["ifcn_sha256"], hashlib.sha256(ifcn.read_bytes()).hexdigest())

    def test_v2_null_order_preserves_default_coordinate_edit_execution(self):
        operations = [{"op": "move", "node": 2, "to": [21, 28]}]
        old_result, old_candidate, _ = self.invoke(operations)
        self.assert_success(old_result, old_candidate)
        proposal = {"schema": "ifcn.layout_search.v2", "operations": operations,
                    "routing_order": None, "rationale": "Retain the existing default router."}
        result, candidate, _ = self.invoke(operations, proposal=proposal)
        self.assert_success(result, candidate)
        self.assertEqual(candidate["nodes"], old_candidate["nodes"])
        self.assertEqual(candidate["routes"], old_candidate["routes"])
        self.assertFalse(candidate["edit"]["explicit_routing_order"])
        self.assertIsNone(candidate["edit"]["requested_order"])
        self.assertEqual(candidate["edit"]["executed_order"], old_candidate["edit"]["executed_order"])
        self.assertGreaterEqual(candidate["edit"]["route_order_attempts"], 1)

    def test_v2_failed_order_retains_partial_attempt_trace_without_fallback(self):
        operations = [{"op": "move", "node": 4, "to": [21, 26]},
                      {"op": "move", "node": 1, "to": [22, 24]},
                      {"op": "move", "node": 0, "to": [22, 22]}]
        order = [[5, 2], [4, 2], [1, 4], [3, 5], [0, 4], [0, 3], [1, 3]]
        proposal = {"schema": "ifcn.layout_search.v2", "operations": operations,
                    "routing_order": order, "rationale": "Retain a failed explicit decision."}
        attempted = order[:5]
        previous_routes = None
        for retries in (0, 64):
            with self.subTest(retries=retries):
                result, candidate, _ = self.invoke(operations, proposal=proposal,
                                                   extra=("--route-retries", str(retries)))
                self.assertEqual(result.returncode, 10)
                self.assertIsNotNone(candidate)
                self.assertFalse(candidate["routed"])
                self.assertFalse(candidate["native_mapping_valid"])
                self.assertIn("could not be routed", candidate["native_validation_error"])
                edit = candidate["edit"]
                self.assertEqual(edit["requested_order"], order)
                self.assertEqual(edit["executed_order"], attempted)
                self.assertEqual(edit["route_order_attempts"], 1)
                self.assertFalse(edit["fallback_used"])
                completed = {(r["source"], r["target"]) for r in candidate["routes"]}
                self.assertEqual(completed, {tuple(e) for e in attempted[:-1]})
                self.assertNotIn(tuple(attempted[-1]), completed)
                if previous_routes is not None:
                    self.assertEqual(candidate["routes"], previous_routes)
                previous_routes = candidate["routes"]

    def test_v2_strict_schema_and_exact_edge_permutation(self):
        valid = {"schema": "ifcn.layout_search.v2", "operations": [],
                 "routing_order": copy.deepcopy(self.baseline["edges"]),
                 "rationale": "Schema rejection regression fixture."}
        examples = []
        for key in ("operations", "routing_order", "rationale"):
            missing = copy.deepcopy(valid)
            missing.pop(key)
            examples.append(missing)
        examples.extend([
            dict(valid, extra="unsupported"),
            dict(valid, routing_order=None),
            dict(valid, routing_order=[]),
            dict(valid, routing_order=valid["routing_order"][:-1]),
            dict(valid, routing_order=valid["routing_order"] + [valid["routing_order"][0]]),
            dict(valid, routing_order=[[999, 3], *valid["routing_order"][1:]]),
            dict(valid, routing_order=[[0, 3, 5], *valid["routing_order"][1:]]),
            dict(valid, routing_order=[[False, 3], *valid["routing_order"][1:]]),
            dict(valid, routing_order=[[0.0, 3], *valid["routing_order"][1:]]),
            dict(valid, routing_order={"edges": valid["routing_order"]}),
            dict(valid, routing_order="default"),
            dict(valid, operations=[{"op": "move", "node": 2, "to": [21, 28]}] * 9),
            dict(valid, operations=[{"op": "move", "node": 2, "to": [21, 29]}]),
            dict(valid, operations=[{"op": "swap", "nodes": [3, 4]},
                                    {"op": "move", "node": 4, "to": [21, 24]}]),
            dict(valid, operations=[{"op": "delete", "node": 3}]),
            dict(valid, rationale=[]),
            dict(valid, schema="ifcn.layout_search.v3"),
            # A routing field cannot silently extend the legacy v1 contract.
            dict(valid, schema="ifcn.layout_edit.v1"),
        ])
        for proposal in examples:
            with self.subTest(proposal=proposal):
                result, candidate, _ = self.invoke([], proposal=proposal)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(candidate)

    def test_source_graph_identity_cannot_be_changed_by_baseline_metadata(self):
        for kind in ("name", "type", "edges", "missing_node", "algorithm"):
            baseline = copy.deepcopy(self.baseline)
            if kind in ("name", "type"):
                baseline["nodes"][0][kind] = "forged"
            elif kind == "edges":
                baseline["edges"].pop()
            elif kind == "missing_node":
                baseline["nodes"].pop()
            else:
                baseline["algorithm"] = "normal_2ddwave"
            with self.subTest(kind=kind):
                result, candidate, _ = self.invoke([], baseline=baseline)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(candidate)

    def test_output_cannot_overwrite_a_baseline_or_previous_candidate(self):
        result, candidate, directory = self.invoke([])
        self.assert_success(result, candidate)
        baseline = directory / "baseline.json"
        for target in (baseline, directory / "candidate.json"):
            before = target.read_bytes()
            repeated = subprocess.run([str(BUILD / "ifcn_layout_edit"), str(self.source),
                                       str(baseline), str(directory / "proposal.json"), str(target)],
                                      capture_output=True, text=True, timeout=8)
            self.assertNotEqual(repeated.returncode, 0)
            self.assertIn("output already exists", repeated.stderr)
            self.assertEqual(target.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
