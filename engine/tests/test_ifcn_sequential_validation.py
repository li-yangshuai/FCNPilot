"""Next-state seam regression: mux controls, boundary identity, and limits."""
from __future__ import annotations
import copy
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from ifcn_sequential_validation import verify_next_state
import ifcn_agent_sequential as sequential


def register(identifier, q, d):
    return {"id": identifier, "kind": "plain_posedge_dff", "width": 1, "q": q, "d": d}


def dag_node(identifier, name, kind, output=False):
    return {"id": identifier, "name": name, "type": kind,
            "is_input": kind == "input", "is_output": output}


def enable_reset_fixture():
    # SeqIR muxes implement rst ? 0 : (en ? d : q).  The DAG implements
    # the same expression through independently specified NOT/AND/OR gates.
    seqir = {"schema": "ifcn.seqir.v0",
        "registers": [register("reg.A", "state[7]", "next.state")],
        "clock_domains": [{"signal": "clock_in"}],
        "ports": [{"direction": "input", "bits": [name]} for name in ("clock_in", "payload[0]", "enable", "reset")],
        "combinational_nodes": [
            {"id": "hold", "op": "mux", "inputs": {"A": "state[7]", "B": "payload[0]", "S": "enable"}, "output": "selected"},
            {"id": "reset", "op": "mux", "inputs": {"A": "selected", "B": "const.0", "S": "reset"}, "output": "next.state"},
        ]}
    manifest = {"schema": "ifcn.state_manifest.v0",
        "state_boundaries": [{"id": "reg.A", "q_signal": "state[7]", "data_signal": "next.state",
                              "q_event": "latched_A", "data_event": "capture_B", "iteration_distance": 1}],
        "cut_dag": {"inputs": ["latched_A", "v2", "v0", "v1"], "outputs": ["capture_B"],
                    "primary_inputs": [{"signal": "payload[0]", "event": "v2"},
                                       {"signal": "enable", "event": "v0"},
                                       {"signal": "reset", "event": "v1"}]}}
    nodes = [dag_node(0, "latched_A", "input"), dag_node(1, "v2", "input"),
             dag_node(2, "v0", "input"), dag_node(3, "v1", "input"),
             dag_node(4, "not_enable", "not"), dag_node(5, "held", "and"),
             dag_node(6, "loaded", "and"), dag_node(7, "selected", "or"),
             dag_node(8, "not_reset", "not"), dag_node(9, "capture_gate", "and"),
             dag_node(10, "capture_B", "output", True)]
    edges = [[2, 4], [0, 5], [4, 5], [1, 6], [2, 6], [5, 7], [6, 7], [3, 8], [7, 9], [8, 9], [9, 10]]
    dag = {"schema": "ifcn.dag.v1", "nodes": nodes, "edges": edges,
           "topological_order": list(range(11)), "input_count": 4, "output_count": 1}
    return seqir, manifest, dag


def hold_registers(count):
    seqir = {"schema": "ifcn.seqir.v0", "ports": [], "clock_domains": [],
             "registers": [register(f"r{index}", f"state{index}", f"state{index}") for index in range(count)],
             "combinational_nodes": []}
    manifest = {"schema": "ifcn.state_manifest.v0", "state_boundaries": [
        {"id": f"r{index}", "q_signal": f"state{index}", "data_signal": f"state{index}",
         "q_event": f"q{index}", "data_event": f"d{index}", "iteration_distance": 1} for index in range(count)],
        "cut_dag": {"primary_inputs": [], "inputs": [f"q{index}" for index in range(count)],
                    "outputs": [f"d{index}" for index in range(count)]}}
    nodes = [dag_node(index, f"q{index}", "input") for index in range(count)]
    nodes += [dag_node(count + index, f"d{index}", "output", True) for index in range(count)]
    dag = {"schema": "ifcn.dag.v1", "nodes": nodes,
           "edges": [[index, count + index] for index in range(count)],
           "topological_order": list(range(2 * count))}
    return seqir, manifest, dag


class NextStateValidationTest(unittest.TestCase):
    def test_sync_reset_enable_and_explicit_signal_mapping(self):
        report = verify_next_state(*enable_reset_fixture())
        self.assertEqual(report["status"], "equivalent", report)
        self.assertTrue(report["equivalent"])
        self.assertEqual((report["state_bits"], report["input_bits"], report["vectors_checked"]), (1, 3, 16))
        self.assertEqual(report["gate_nodes"], 6)
        self.assertEqual(report["scope"], "SeqIR_vs_cut_DAG_one_step_next_state")
        self.assertIn("original_RTL_equivalence", report["excludes"])
        self.assertIn("device_waveforms", report["excludes"])

    def test_control_bug_is_reported_with_complete_exhaustion(self):
        seqir, manifest, dag = enable_reset_fixture()
        dag["nodes"][8]["type"] = "buf"  # reset polarity reversed
        report = verify_next_state(seqir, manifest, dag)
        self.assertEqual(report["status"], "mismatch")
        self.assertFalse(report["equivalent"])
        self.assertEqual(report["vectors_checked"], 16)
        self.assertGreater(report["mismatch_count"], 0)
        example = report["counterexamples"][0]
        self.assertEqual(example["register"], "reg.A")
        self.assertEqual(example["data_event"], "capture_B")
        self.assertNotEqual(example["expected"], example["observed"])

    def test_state_outputs_cannot_be_permuted_by_truth_table_matching(self):
        seqir, manifest, dag = hold_registers(2)
        dag["edges"] = [[0, 3], [1, 2]]
        report = verify_next_state(seqir, manifest, dag)
        self.assertEqual(report["status"], "mismatch")
        self.assertEqual(report["vectors_checked"], 4)
        self.assertEqual(report["mismatch_count"], 4)

    def test_source_and_manifest_order_is_not_semantic(self):
        seqir, manifest, dag = enable_reset_fixture()
        seqir["combinational_nodes"].reverse()
        manifest["cut_dag"]["primary_inputs"].reverse()
        manifest["cut_dag"]["inputs"].reverse()
        dag["nodes"].reverse()
        dag["edges"].reverse()
        self.assertEqual(verify_next_state(seqir, manifest, dag)["status"], "equivalent")

    def test_observation_only_logic_does_not_expand_capture_cone(self):
        seqir, manifest, dag = enable_reset_fixture()
        seqir["ports"].append({"direction": "input", "bits": ["observation_only"]})
        seqir["combinational_nodes"].append({"id": "observe", "op": "xor", "inputs": {"A": "observation_only", "B": "state[7]"}, "output": "trace"})
        report = verify_next_state(seqir, manifest, dag)
        self.assertEqual(report["status"], "equivalent", report)
        self.assertEqual(report["input_bits"], 3)
        self.assertEqual(report["source_gate_nodes"], 2)

    def test_xor_source_vs_independent_and_or_not_dag(self):
        seqir, manifest, dag = enable_reset_fixture()
        seqir["combinational_nodes"][0] = {"id": "xor", "op": "xor", "inputs": {"A": "state[7]", "B": "payload[0]"}, "output": "selected"}
        seqir["ports"] = [port for port in seqir["ports"] if port["bits"] != ["enable"]]
        manifest["cut_dag"]["primary_inputs"] = [entry for entry in manifest["cut_dag"]["primary_inputs"] if entry["signal"] != "enable"]
        manifest["cut_dag"]["inputs"].remove("v0")
        # (q & !d) | (!q & d), followed by the original reset cone.
        dag["nodes"][2] = dag_node(2, "not_q", "not")
        dag["nodes"][4]["name"] = "not_d"
        dag["edges"] = [[0, 2], [1, 4], [0, 5], [4, 5], [1, 6], [2, 6], [5, 7], [6, 7], [3, 8], [7, 9], [8, 9], [9, 10]]
        dag["input_count"] = 3
        report = verify_next_state(seqir, manifest, dag)
        self.assertEqual(report["status"], "equivalent", report)
        self.assertEqual(report["vectors_checked"], 8)

    def test_missing_or_relabelled_boundary_is_rejected(self):
        mutations = {
            "removed": lambda m: m["state_boundaries"].clear(),
            "wrong_d": lambda m: m["state_boundaries"][0].update(data_signal="selected"),
            "wrong_q": lambda m: m["state_boundaries"][0].update(q_signal="payload[0]"),
            "lost_delay": lambda m: m["state_boundaries"][0].update(iteration_distance=0),
            "duplicate": lambda m: m["state_boundaries"].append(copy.deepcopy(m["state_boundaries"][0])),
            "lost_input": lambda m: m["cut_dag"]["primary_inputs"].pop(),
            "guessed_input": lambda m: m["cut_dag"]["primary_inputs"][0].update(signal="payload")}
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                seqir, manifest, dag = enable_reset_fixture()
                mutate(manifest)
                report = verify_next_state(seqir, manifest, dag)
                self.assertEqual(report["status"], "invalid", report)
                self.assertIsNone(report["equivalent"])
                self.assertEqual(report["vectors_checked"], 0)

    def test_dag_must_keep_explicit_q_and_d_boundaries(self):
        for field, node in [("is_input", 0), ("is_output", 10)]:
            seqir, manifest, dag = enable_reset_fixture()
            dag["nodes"][node][field] = False
            report = verify_next_state(seqir, manifest, dag)
            self.assertEqual(report["status"], "invalid", report)
            self.assertIsNone(report["equivalent"])

    def test_unknown_operations_and_wrong_structure_never_pass(self):
        mutations = [
            lambda s, m, d: s["combinational_nodes"][0].update(op="mystery"),
            lambda s, m, d: s["combinational_nodes"][0]["inputs"].update(S="undriven"),
            lambda s, m, d: d["nodes"][4].update(type="constant_1", name="1'b1"),
            lambda s, m, d: d["topological_order"].reverse(),
            lambda s, m, d: d["edges"].append([9, 7]),
            lambda s, m, d: d["edges"].append([0, 5]),
            lambda s, m, d: d["nodes"][10].update(name="forgotten_D"),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                seqir, manifest, dag = enable_reset_fixture()
                mutate(seqir, manifest, dag)
                report = verify_next_state(seqir, manifest, dag)
                self.assertEqual(report["status"], "invalid", report)
                self.assertIsNone(report["equivalent"])

    def test_eleven_bits_are_exhaustive_twelve_are_not_performed(self):
        checked = verify_next_state(*hold_registers(11))
        self.assertEqual(checked["status"], "equivalent")
        self.assertEqual(checked["vectors_checked"], 2048)
        limited = verify_next_state(*hold_registers(12))
        self.assertEqual(limited["status"], "not_performed")
        self.assertIsNone(limited["equivalent"])
        self.assertEqual(limited["state_bits"], 12)
        self.assertEqual(limited["vectors_checked"], 0)

    def test_malformed_payload_returns_failure_report(self):
        for seqir, manifest, dag in [(None, {}, {}), ({}, [], {}), ({}, {}, [])]:
            self.assertEqual(verify_next_state(seqir, manifest, dag)["status"], "invalid")
        self.assertEqual(verify_next_state(*enable_reset_fixture(), max_inputs=True)["status"], "invalid")

    def test_real_yosys_fixture_to_native_parser_dag(self):
        import yosys_json_to_seqir as converter
        build = Path(os.environ.get("IFCN_BUILD_DIR", ROOT / "build"))
        if not any((build / "python").glob("iFCN_Lab*.so")):
            self.skipTest("native parser bindings are not built")
        document = json.loads((ROOT / "tests/fixtures/sequential/toggle_ff.canonical.yosys.json").read_text())
        seqir = converter.import_yosys_json(document)
        exported = converter.build_legacy_cut_artifacts(seqir, compact_names=True)
        with tempfile.TemporaryDirectory(prefix="fcn-next-state-") as temporary:
            out = Path(temporary)
            source = out / "cut.v"
            source.write_text(exported.verilog)
            result = subprocess.run([sys.executable, str(ROOT / "scripts/ifcn_agent_backend.py"), "parse",
                                     "--input", str(source), "--output", str(out)],
                                    capture_output=True, text=True, timeout=25)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            ordinary_dag = json.loads((out / "dag.json").read_text())
            ordinary_report = verify_next_state(seqir, exported.state_manifest, ordinary_dag)
            self.assertEqual(ordinary_report["status"], "invalid")
            self.assertIsNone(ordinary_report["equivalent"])
            preserved = out / "preserved"
            result = subprocess.run([sys.executable, str(ROOT / "scripts/ifcn_agent_backend.py"), "parse",
                                     "--input", str(source), "--output", str(preserved), "--preserve-output-boundaries"],
                                    capture_output=True, text=True, timeout=25)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            dag = json.loads((preserved / "dag.json").read_text())
        report = verify_next_state(seqir, exported.state_manifest, dag)
        self.assertEqual(report["status"], "equivalent", report)
        self.assertEqual(report["state_bits"], 1)
        self.assertEqual(report["vectors_checked"], 4)


class CyclicCandidateSearchTest(unittest.TestCase):
    UNSAT = "ifcn_sequential_cyclic_pnr failed: global cyclic phase/epoch solve UNSAT: fixed geometry infeasible"
    LIMIT = "ifcn_sequential_cyclic_pnr failed: global cyclic phase/epoch solve LIMIT: search budget reached"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fcn-cyclic-search-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name)
        self.directory = self.path / "pnr"
        self.directory.mkdir()
        self.normalized = self.path / "cut.v"
        self.normalized.write_text("module cut(input q, output d); assign d=~q; endmodule\n")
        self.boundaries = {
            "state_boundaries": [{"data_event": "d", "q_event": "q", "iteration_distance": 1}],
            "ifcn_sequential_pnr": {"argv": ["--state", "d:q"]},
        }
        self.report = {
            "status": "layout_candidate", "mapping_mode": "sequential",
            "state_boundary_count": 1, "state_boundaries": self.boundaries["state_boundaries"],
            "feedback_routes": 1, "directed_cycle_present": True,
            "mapping_drc": True, "tile_phase_drc": True,
            "physical_state_signoff": "not_characterized",
        }
        self.manifest = {
            "parameters": {"timeout_s": 10, "ii_candidates": "4,8"},
            "configuration": {"sequential_pnr_binary": "fake-native"}, "metrics": {},
        }
        self.clock = 100.0
        self.calls = []
        self.registered = []
        self.outcomes = []
        self.elapsed = []
        self.api = mock.Mock(STOP=False)
        self.api.execute.side_effect = self.execute
        self.api.write_json.side_effect = lambda path, value: path.write_text(json.dumps(value))
        self.api.register_artifact.side_effect = lambda *args: self.registered.append(args)
        self.time_patch = mock.patch.object(sequential.time, "monotonic", side_effect=lambda: self.clock)
        self.time_patch.start()
        self.addCleanup(self.time_patch.stop)

    def execute(self, command, path, step, manifest, *, timeout_s):
        index = len(self.calls)
        self.calls.append({"command": command, "timeout_s": timeout_s})
        self.assertEqual((path, step, manifest), (self.path, "pnr", self.manifest))
        self.clock += self.elapsed[index] if index < len(self.elapsed) else 0
        outcome = self.outcomes[index] if index < len(self.outcomes) else None
        if callable(outcome):
            outcome = outcome()
        if isinstance(outcome, Exception):
            raise outcome
        target = Path(command[2])
        target.write_text(f"validated candidate {index}\n")
        target.with_suffix(".ifcn.json").write_text(json.dumps(self.report))
        target.with_suffix(".tex").write_text(f"candidate {index} figure\n")

    def run_search(self):
        sequential.run_cyclic_candidates(self.api, self.directory, self.path, self.manifest,
                                         self.boundaries, self.normalized)

    def search_report(self):
        report = json.loads((self.directory / "geometry_attempts.json").read_text())
        self.assertEqual(len(self.registered), 1)
        self.assertEqual(self.registered[0][2], "geometry_attempts.json")
        return report

    def assert_no_selected_layout(self):
        self.assertFalse((self.directory / "layout.ifcn").exists())
        self.assertNotIn("geometry_search", self.manifest["metrics"].get("sequential", {}))
        self.assertIsNone(self.search_report()["selected_rank"])

    def test_current_unsat_retries_both_exception_formats_with_shared_budget(self):
        # First command has the execute prefix on the same line. Later failures
        # contain accumulated log text, with the current diagnostic on its own line.
        self.outcomes = [RuntimeError("pnr command exited with 1. " + self.UNSAT),
                         RuntimeError("pnr command exited with 1. " + self.UNSAT + "\n" + self.UNSAT), None]
        self.elapsed = [2.25, 3.0, 0.25]
        self.run_search()
        self.assertEqual([call["timeout_s"] for call in self.calls], [10.0, 7.75, 4.75])
        for rank, call in enumerate(self.calls):
            command = call["command"]
            self.assertEqual(command[command.index("--geometry-rank") + 1], rank)
            self.assertEqual(command[command.index("--state") + 1], "d:q")
            self.assertEqual(command[command.index("--ii") + 1], "4,8")
        report = self.search_report()
        self.assertEqual([item["status"] for item in report["attempts"]], ["clock_unsat", "clock_unsat", "selected"])
        self.assertEqual(report["selected_rank"], 2)
        self.assertEqual(self.manifest["metrics"]["sequential"]["geometry_search"]["attempted_candidates"], 3)
        self.assertEqual((self.directory / "layout.ifcn").read_text(), "validated candidate 2\n")
        self.assertEqual(json.loads((self.directory / "layout.ifcn.json").read_text()), self.report)
        self.assertEqual((self.directory / "layout.tex").read_text(), "candidate 2 figure\n")

    def test_limit_or_other_current_failure_never_reuses_prior_unsat(self):
        for current in (self.LIMIT, "ifcn_sequential_cyclic_pnr failed: mapping DRC failed", "process terminated without a native diagnostic"):
            with self.subTest(current=current):
                # Reset only this test's temporary candidate directories, never repository data.
                with tempfile.TemporaryDirectory(dir=self.path) as temporary:
                    self.directory = Path(temporary)
                    self.calls.clear()
                    self.registered.clear()
                    self.outcomes = [RuntimeError("pnr command exited with 1. " + self.UNSAT + "\n" + current)]
                    with self.assertRaisesRegex(RuntimeError, re.escape(current)):
                        self.run_search()
                    self.assertEqual(len(self.calls), 1)
                    self.assertEqual(self.search_report()["attempts"][0]["status"], "failed")
                    self.assert_no_selected_layout()

    def test_native_candidate_exhaustion_is_bounded_and_not_circuit_unsat(self):
        self.outcomes = [RuntimeError(self.UNSAT), RuntimeError(
            "ifcn_sequential_cyclic_pnr failed: --geometry-rank 1 is unavailable; only 1 distinct DRC-valid candidates were found")]
        with self.assertRaisesRegex(ValueError, "available ranked native geometries"):
            self.run_search()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual([item["status"] for item in self.search_report()["attempts"]], ["clock_unsat", "candidate_unavailable"])
        self.assert_no_selected_layout()

    def test_cancel_before_execution_launches_no_candidate(self):
        self.api.STOP = True
        with self.assertRaises(InterruptedError):
            self.run_search()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.search_report()["attempts"], [])
        self.assert_no_selected_layout()

    def test_cancel_file_after_unsat_stops_before_next_candidate(self):
        def cancel_after_unsat():
            (self.path / "cancel.request").touch()
            return RuntimeError(self.UNSAT)
        self.outcomes = [cancel_after_unsat]
        with self.assertRaises(InterruptedError):
            self.run_search()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.search_report()["attempts"][0]["status"], "clock_unsat")
        self.assert_no_selected_layout()

    def test_cancel_during_execution_records_cancelled_and_does_not_retry(self):
        self.outcomes = [InterruptedError("Cancellation requested.")]
        with self.assertRaises(InterruptedError):
            self.run_search()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.search_report()["attempts"][0]["status"], "cancelled")
        self.assert_no_selected_layout()

    def test_command_timeout_is_not_retried(self):
        self.outcomes = [TimeoutError("pnr exceeded the per-command timeout.")]
        with self.assertRaises(TimeoutError):
            self.run_search()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.search_report()["attempts"][0]["status"], "failed")
        self.assert_no_selected_layout()

    def test_exhausted_shared_budget_never_starts_the_next_native_command(self):
        self.outcomes, self.elapsed = [RuntimeError(self.UNSAT)], [9.5]
        with self.assertRaisesRegex(TimeoutError, "shared P&R time budget"):
            self.run_search()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual([item["status"] for item in self.search_report()["attempts"]], ["clock_unsat", "budget_exhausted"])
        self.assert_no_selected_layout()

    def test_success_exit_with_lost_state_boundary_is_rejected_without_promotion(self):
        self.report["state_boundary_count"] = 0
        with self.assertRaisesRegex(ValueError, "complete state boundary map"):
            self.run_search()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.search_report()["attempts"][0]["status"], "failed")
        self.assert_no_selected_layout()

    def test_sixty_four_unsat_candidates_do_not_claim_global_infeasibility(self):
        self.outcomes = [RuntimeError(self.UNSAT)] * 64
        with self.assertRaisesRegex(ValueError, "does not prove the circuit infeasible"):
            self.run_search()
        self.assertEqual(len(self.calls), 64)
        self.assertEqual([item["geometry_rank"] for item in self.search_report()["attempts"]], list(range(64)))
        self.assert_no_selected_layout()

    def test_executor_silent_failure_does_not_return_an_old_unsat_tail(self):
        # A native process may fail without writing anything. Its failure must
        # not inherit a previous candidate's UNSAT from the shared stage log.
        import ifcn_agent
        self.time_patch.stop()  # The actual executor needs an advancing clock.
        self.manifest.update(stages={"pnr": {"log": "pnr.log"}})
        first = [sys.executable, "-c", "import sys; print(" + repr(self.UNSAT) + "); sys.exit(1)"]
        silent = [sys.executable, "-c", "import sys; sys.exit(1)"]
        with mock.patch.object(ifcn_agent, "STOP", False), mock.patch.object(ifcn_agent, "backend_environment", return_value=os.environ.copy()):
            with self.assertRaises(RuntimeError) as previous:
                ifcn_agent.execute(first, self.path, "pnr", self.manifest, timeout_s=2)
            self.assertIn(self.UNSAT, str(previous.exception))
            with self.assertRaises(RuntimeError) as current:
                ifcn_agent.execute(silent, self.path, "pnr", self.manifest, timeout_s=2)
        self.assertIn("pnr command exited with 1", str(current.exception))
        self.assertNotIn(self.UNSAT, str(current.exception))
        self.assertIn(self.UNSAT, (self.path / "pnr.log").read_text())


if __name__ == "__main__":
    unittest.main()
