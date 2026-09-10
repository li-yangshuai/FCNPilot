"""Real RTL -> state-preserving cut -> cyclic layout -> QCA integration."""
from __future__ import annotations

import graphlib
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/ifcn_agent.py"
FIXTURES = ROOT / "tests/fixtures/sequential/rtl"


class SequentialFlowIntegration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fcnpilot-sequential-flow-")
        self.directory = Path(self.temporary.name)
        self.runs = self.directory / "runs"
        self.active_runs = set()
        self.environment = os.environ.copy()
        self.environment.update(MPLBACKEND="Agg", MPLCONFIGDIR=str(self.directory / "mpl"))

    def tearDown(self):
        # A failing assertion must not leave a worker writing into a deleted
        # temporary directory. Normal completed tests need no cancellation.
        for run_id in list(self.active_runs):
            try:
                self.command("cancel", run_id)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    if not self.command("status", run_id)["active"]:
                        self.active_runs.discard(run_id)
                        break
                    time.sleep(0.1)
            except (AssertionError, OSError, subprocess.TimeoutExpired):
                pass
        self.temporary.cleanup()

    def command(self, *arguments, expected_returncode=0):
        result = subprocess.run(
            [sys.executable, str(CLI), "--runs-dir", str(self.runs), *map(str, arguments)],
            capture_output=True, text=True, timeout=15, env=self.environment,
        )
        self.assertEqual(result.returncode, expected_returncode, result.stdout + result.stderr)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail(f"CLI did not return JSON: {result.stdout}\n{result.stderr}")

    def wait_for_run(self, started):
        run_id = started["run_id"]
        self.active_runs.add(run_id)
        deadline = time.monotonic() + 80
        state = started
        while time.monotonic() < deadline:
            state = self.command("status", run_id)
            if not state["active"]:
                self.active_runs.discard(run_id)
                return state
            time.sleep(0.1)
        self.fail(f"Sequential run exceeded 80 seconds: {json.dumps(state)}")

    def start(self, source, *options):
        return self.wait_for_run(self.command(
            "start", source, "--design-type", "sequential", "--until", "map",
            "--timeout", "45", *options,
        ))

    def artifact(self, manifest, name):
        entry = manifest["artifacts"][name]
        run_root = self.runs / manifest["run_id"]
        path = (run_root / entry["path"]).resolve()
        self.assertTrue(path.is_relative_to(run_root.resolve()))
        data = path.read_bytes()
        self.assertEqual(len(data), entry["bytes"], name)
        self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"], name)
        return data

    def assert_layout_candidate(self, manifest, expected_vectors, expected_state_bits=1):
        diagnostic = {"status": manifest["status"], "error": manifest.get("error"),
                      "stages": {name: item["status"] for name, item in manifest["stages"].items()},
                      "log_tail": manifest.get("log_tail"),
                      "native_cell_counts": {key: manifest["metrics"].get("sequential", {}).get(key)
                                             for key in ("mapped_qca_cells", "mapped_layer_cell_records")}}
        if manifest["status"] != "layout_candidate":
            diagnostic["exported_qca_cells"] = {
                path.name: path.read_bytes().count(b"[TYPE:QCADCell]")
                for path in (self.runs / manifest["run_id"]).glob("03_map_*/*.qca")}
        self.assertEqual(manifest["status"], "layout_candidate", json.dumps(diagnostic))
        self.assertEqual(manifest["design_type"], "sequential")
        self.assertEqual(manifest["parameters"]["algorithm"], "sequential_cyclic")
        self.assertEqual(manifest["requested_until"], "map")
        self.assertEqual({stage: item["status"] for stage, item in manifest["stages"].items()},
                         {"parse": "completed", "pnr": "completed", "map": "completed"})
        for name in manifest["artifacts"]:
            self.artifact(manifest, name)
        report = json.loads(self.artifact(manifest, "result.json"))
        self.assertEqual(report["status"], "layout_candidate")
        self.assertEqual(report["completed_stages"], ["parse", "pnr", "map"])
        state_check = json.loads(self.artifact(manifest, "sequential_validation.json"))
        self.assertEqual(state_check["status"], "equivalent")
        self.assertEqual(state_check["vectors_checked"], expected_vectors)
        self.assertEqual(2 ** (state_check["state_bits"] + state_check["input_bits"]), expected_vectors)
        self.assertEqual(state_check["state_bits"], expected_state_bits)
        boundary_manifest = json.loads(self.artifact(manifest, "state_manifest.json"))
        expected_boundaries = [{key: boundary[key] for key in ("data_event", "q_event", "iteration_distance")}
                               for boundary in boundary_manifest["state_boundaries"]]
        dag = json.loads(self.artifact(manifest, "dag.json"))
        output_names = {node["name"] for node in dag["nodes"] if node["is_output"]}
        input_names = {node["name"] for node in dag["nodes"] if node["is_input"]}
        for boundary in expected_boundaries:
            self.assertIn(boundary["data_event"], output_names)
            self.assertIn(boundary["q_event"], input_names)
        native = json.loads(self.artifact(manifest, "sequential_pnr.json"))
        self.assertEqual(native["state_boundaries"], expected_boundaries)
        self.assertEqual(native["state_boundary_count"], len(expected_boundaries))
        self.assertEqual(native["state_boundary_count"], expected_state_bits)
        self.assertEqual(native["q_pseudo_nodes_removed"], expected_state_bits)
        self.assertTrue(native["directed_cycle_present"])
        self.assertTrue(native["tile_phase_drc"])
        self.assertTrue(native["mapping_drc"])
        self.assertEqual(native["physical_state_signoff"], "not_characterized")
        self.assertEqual(native["feedback_routes"], expected_state_bits)
        # Check the exported topology as well as the native status flag.
        dependencies = {}
        layout = self.artifact(manifest, "layout.ifcn").decode()
        for source, target in re.findall(r"^\((\d+),(\d+)\): \(", layout, re.MULTILINE):
            dependencies.setdefault(source, set())
            dependencies.setdefault(target, set()).add(source)
        self.assertTrue(dependencies)
        with self.assertRaises(graphlib.CycleError):
            list(graphlib.TopologicalSorter(dependencies).static_order())
        feedback_edges = []
        distance = None
        for line in layout.splitlines():
            if line.startswith("#iteration_distance="):
                distance = int(line.split("=", 1)[1])
            route = re.match(r"^\((\d+),(\d+)\): \(", line)
            if route:
                if distance == 1:
                    feedback_edges.append(route.groups())
                distance = None
        self.assertEqual(len(feedback_edges), expected_state_bits)
        for source, target in feedback_edges:
            # Every state edge must participate in a physical cycle, rather
            # than accepting a single unrelated cycle elsewhere in the layout.
            pending, seen = [target], set()
            while pending and source not in seen:
                node = pending.pop()
                if node in seen:
                    continue
                seen.add(node)
                pending.extend(sink for sink, drivers in dependencies.items() if node in drivers)
            self.assertIn(source, seen, (source, target))
        cells = self.artifact(manifest, "device.qca").count(b"[TYPE:QCADCell]")
        self.assertGreater(cells, 0)
        self.assertEqual(cells, native["mapped_qca_cells"])
        self.assertEqual(cells, manifest["metrics"]["mapping"]["cell_count"])
        return report

    def test_toggle_to_qca_and_resume_stays_at_map(self):
        completed = self.start(FIXTURES / "toggle_ff.v")
        self.assert_layout_candidate(completed, 4)
        attempts = {name: item["attempt"] for name, item in completed["stages"].items()}
        device_hash = completed["artifacts"]["device.qca"]["sha256"]
        resumed = self.wait_for_run(self.command("resume", completed["run_id"]))
        self.assert_layout_candidate(resumed, 4)
        self.assertEqual({name: item["attempt"] for name, item in resumed["stages"].items()}, attempts)
        self.assertEqual(resumed["artifacts"]["device.qca"]["sha256"], device_hash)
        self.assertNotIn("simulation.json", resumed["artifacts"])
        self.assertNotIn("energy.json", resumed["artifacts"])

    def test_enable_hold_rtl_to_qca_preserves_sixteen_state_input_cases(self):
        self.assert_layout_candidate(self.start(FIXTURES / "enable_hold_ff.v"), 16)

    def test_johnson_four_state_feedback_uses_a_recorded_feasible_geometry(self):
        completed = self.start(FIXTURES / "johnson4_free_running.v")
        self.assert_layout_candidate(completed, 16, expected_state_bits=4)
        search = json.loads(self.artifact(completed, "geometry_attempts.json"))
        self.assertEqual(search["schema"], "ifcn.sequential-geometry-search.v1")
        self.assertEqual(search["max_candidates"], 64)
        self.assertGreater(search["timeout_s"], 0)
        self.assertLessEqual(search["timeout_s"], 45)
        selected_rank = search["selected_rank"]
        self.assertIsInstance(selected_rank, int)
        self.assertGreater(selected_rank, 0)
        self.assertLess(selected_rank, search["max_candidates"])
        attempts = search["attempts"]
        self.assertEqual([attempt["geometry_rank"] for attempt in attempts], list(range(selected_rank + 1)))
        self.assertEqual(attempts[-1]["status"], "selected")
        for rejected in attempts[:-1]:
            self.assertEqual(rejected["status"], "clock_unsat")
            self.assertIn("UNSAT", rejected["reason"])
        metrics = completed["metrics"]["sequential"]
        self.assertEqual(metrics["geometry_search"]["selected_rank"], selected_rank)
        self.assertEqual(metrics["geometry_search"]["attempted_candidates"], len(attempts))
        self.assertEqual(metrics["geometry_optimization"]["selected_rank"], selected_rank)

    def test_unsupported_state_elements_fail_before_pnr(self):
        sources = {
            "async_reset": "module bad(input clk,rst,d,output reg q); always @(posedge clk or posedge rst) if(rst) q<=0; else q<=d; endmodule",
            "latch": "module bad(input en,d,output reg q); always @* if(en) q=d; endmodule",
        }
        for name, source in sources.items():
            with self.subTest(source=name):
                path = self.directory / f"{name}.v"
                path.write_text(source)
                failed = self.start(path)
                self.assertEqual(failed["status"], "failed", json.dumps(failed))
                self.assertEqual(failed["stages"]["parse"]["status"], "failed")
                self.assertNotIn("pnr", failed["stages"])
                self.assertNotIn("layout.ifcn", failed["artifacts"])
                self.assertNotIn("device.qca", failed["artifacts"])
                self.assertTrue(failed["error"])

    def test_combinational_algorithm_selection_rejects_before_creating_job(self):
        for algorithm in ("auto", "normal_2ddwave", "compact", "june_random"):
            with self.subTest(algorithm=algorithm):
                rejected = self.command("start", FIXTURES / "toggle_ff.v", "--design-type", "sequential",
                                        "--algorithm", algorithm, expected_returncode=1)
                self.assertEqual(rejected["status"], "error")
                self.assertIn("state-aware", rejected["error"])
                self.assertFalse(self.runs.exists())


if __name__ == "__main__":
    unittest.main()
