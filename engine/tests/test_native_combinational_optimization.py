"""Same-constraint topology and transactional Compact candidate regressions."""
from __future__ import annotations

from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("IFCN_BUILD_DIR", ROOT / "build"))
sys.path.insert(0, str(ROOT / "scripts"))
from ifcn_agent_layout_validation import validate_candidate, dag_from_candidate, export_native_ifcn
from verify_routed_logic import verify_bytes


class NativeCombinationalOptimizationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fcn-native-topology-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.serial = 0

    def route(self, case, topology=None, algorithm="june_random", expected_code=0):
        self.serial += 1
        output = self.directory / str(self.serial)
        output.mkdir()
        source = ROOT / "tests/benchmarks_pi/v1" / case
        candidate = output / "candidate.json"
        command = [str(BUILD / "ifcn_combinational_pnr"), algorithm, str(source), str(candidate)]
        if topology is not None:
            command.extend(["--topology", topology])
        result = subprocess.run(command, capture_output=True, text=True, timeout=6)
        self.assertEqual(result.returncode, expected_code, result.stdout + result.stderr)
        return source, output, json.loads(candidate.read_text())

    def audit(self, source, output, candidate):
        self.assertTrue(candidate["native_mapping_valid"], candidate["native_validation_error"])
        validation = validate_candidate(candidate, source_crossings=True)
        self.assertTrue(validation["passed"], validation)
        if candidate["algorithm"] == "compact":
            self.assertLessEqual(validation["max_same_phase_run"], 4)
        dag = dag_from_candidate(candidate, validation)
        logic = verify_bytes(source.read_bytes(), json.dumps(dag).encode())
        self.assertEqual(logic["status"], "equivalent", logic)
        # Removing layer-display buffers must not remove the actual fanout
        # splitter vertices inserted by optimizeAIOG_DRC.
        fanouts = Counter(source_id for source_id, _ in candidate["edges"])
        self.assertLessEqual(max(fanouts.values()), 2)
        export_native_ifcn(candidate, output / "layout.ifcn", candidate["algorithm"])
        result = subprocess.run([str(BUILD / "ifcn_energy_analysis"), str(output / "layout.ifcn"),
                                 str(output / "device"), "--qca-only"],
                                capture_output=True, text=True, timeout=6)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        qca = (output / "device_energy_input.qca").read_text()
        cells = qca.count("[TYPE:QCADCell]")
        self.assertGreater(cells, 0)
        self.assertEqual(qca.count("cell_function=QCAD_CELL_INPUT"), dag["input_count"])
        self.assertEqual(qca.count("cell_function=QCAD_CELL_OUTPUT"), dag["output_count"])
        coords = [(cell["x"], cell["y"]) for cell in candidate["cells"]]
        area = ((max(x for x, _ in coords) - min(x for x, _ in coords) + 1) *
                (max(y for _, y in coords) - min(y for _, y in coords) + 1))
        return {"area": area, "cells": cells, "vectors": logic["vectors_checked"]}

    def test_xor_and_xnor_shrink_without_loosening_design_rules(self):
        for case in ("TOY/xor2.v", "TOY/xnor2.v"):
            with self.subTest(case=case):
                old = self.audit(*self.route(case, "layer_redundancy_buffers"))
                new = self.audit(*self.route(case, "optimized_buffers"))
                self.assertLess(new["area"], old["area"])
                self.assertLess(new["cells"], old["cells"])
                self.assertEqual((old["vectors"], new["vectors"]), (4, 4))

    def test_default_june_still_reproduces_legacy_topology(self):
        _, _, default = self.route("TOY/xor2.v")
        _, _, explicit = self.route("TOY/xor2.v", "layer_redundancy_buffers")
        self.assertEqual(default["topology"], "layer_redundancy_buffers")
        for field in ("nodes", "edges", "routes", "cells", "layers"):
            self.assertEqual(default[field], explicit[field], field)

    def test_mux_tradeoff_keeps_both_candidates_available_to_the_selector(self):
        old = self.audit(*self.route("TOY/mux21.v", "layer_redundancy_buffers"))
        new = self.audit(*self.route("TOY/mux21.v", "optimized_buffers"))
        self.assertLess(old["area"], new["area"])
        self.assertGreater(old["cells"], new["cells"])
        self.assertEqual((old["vectors"], new["vectors"]), (8, 8))

    def test_mux41_coarse_success_does_not_bypass_physical_route_rejection(self):
        _, _, old = self.route("TOY/mux41.v", "layer_redundancy_buffers", expected_code=10)
        self.assertFalse(old["routed"])
        self.assertFalse(old["native_mapping_valid"])
        source, output, candidate = self.route("TOY/mux41.v", "optimized_buffers")
        # The optimized graph preserves the logic and satisfies the earlier
        # coarse checks, yet the actual mapped fine-cell route is missing a
        # directed tile boundary. This is failure evidence, not a new successful
        # benchmark, and the export certificate must keep it out of selection.
        self.assertTrue(candidate["native_mapping_valid"])
        validation = validate_candidate(candidate, source_crossings=True)
        self.assertTrue(validation["passed"], validation)
        dag = dag_from_candidate(candidate, validation)
        logic = verify_bytes(source.read_bytes(), json.dumps(dag).encode())
        self.assertEqual((logic["status"], logic["vectors_checked"]), ("equivalent", 64))
        self.assertTrue(any(node["type"] in {"fanout", "redundancy"} for node in candidate["nodes"]))
        export_native_ifcn(candidate, output / "layout.ifcn", candidate["algorithm"])
        result = subprocess.run([str(BUILD / "ifcn_energy_analysis"), str(output / "layout.ifcn"),
                                 str(output / "device"), "--qca-only"],
                                capture_output=True, text=True, timeout=6)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing a directed tile boundary", result.stderr)
        self.assertFalse((output / "device_energy_input.qca").exists())
        certificate = json.loads((output / "device_physical_validation.json").read_text())
        self.assertFalse(certificate["passed"])

    def test_compact_reuses_complete_validated_geometry(self):
        source, output, candidate = self.route("TOY/mux21.v", algorithm="compact")
        checked = self.audit(source, output, candidate)
        self.assertEqual(candidate["topology"], "optimized_buffers")
        self.assertEqual(candidate["expansion"]["accepted_rounds"], 1)
        self.assertEqual(candidate["expansion"]["reused_routed_candidates"], 1)
        self.assertEqual((checked["area"], checked["cells"], checked["vectors"]), (30, 144, 8))

    def test_invalid_topology_never_writes_a_candidate(self):
        for algorithm, arguments in [("june_random", ["--topology", "unconstrained"]),
                                     ("compact", ["--topology", "layer_redundancy_buffers"]),
                                     ("june_random", ["--unknown", "optimized_buffers"])]:
            with self.subTest(algorithm=algorithm, arguments=arguments):
                candidate = self.directory / "invalid.json"
                command = [str(BUILD / "ifcn_combinational_pnr"), algorithm,
                           str(ROOT / "tests/benchmarks_pi/v1/TOY/xor2.v"), str(candidate), *arguments]
                result = subprocess.run(command, capture_output=True, text=True, timeout=6)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(candidate.exists())


if __name__ == "__main__":
    unittest.main()
