"""Offline runner regressions with synthetic states, never research evidence.

No Pi provider, native router, clock solver or device mapper is invoked. Fake
evaluation records below exercise bookkeeping only, and live exclusively in
TemporaryDirectory; their metrics and Boolean flags are not circuit results.
"""
from __future__ import annotations

import copy
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "engine/scripts"), str(ROOT / "experiments/llm_joint_search")]
import run_gate_study as study


def circuit():
    """Synthetic geometry fixture: not a validated FCN circuit."""
    result = {
        "offline_test_fixture": True, "algorithm": "june_random", "routed": True,
        "nodes": [
            {"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False, "x": 0, "y": 0},
            {"id": 1, "name": "g1", "type": "wire", "is_input": False, "is_output": False, "x": 4, "y": 3},
            {"id": 3, "name": "g2", "type": "wire", "is_input": False, "is_output": False, "x": 6, "y": 5},
            {"id": 2, "name": "z", "type": "wire", "is_input": False, "is_output": True, "x": 0, "y": 8}],
        "edges": [[0, 1], [1, 3], [3, 2]], "layers": [[0], [1], [3], [2]]}
    return refresh_fake_routes(result)


def refresh_fake_routes(candidate):
    """Manhattan fixture paths; no clock/physical legality is asserted."""
    nodes = {n["id"]: (n["x"], n["y"]) for n in candidate["nodes"]}
    routes, sites = [], set()
    for source, target in candidate["edges"]:
        x, y = nodes[source]
        tx, ty = nodes[target]
        path = [[x, y]]
        while x != tx:
            x += 1 if tx > x else -1
            path.append([x, y])
        while y != ty:
            y += 1 if ty > y else -1
            path.append([x, y])
        routes.append({"source": source, "target": target, "path": path})
        sites.update(map(tuple, path))
    candidate["routes"] = routes
    candidate["cells"] = [{"x": x, "y": y, "phase": 1} for x, y in sorted(sites)]
    return candidate


def metrics(area=100, cells=100):
    return {"width": 10, "height": 10, "area_tiles": area, "qca_cells": cells, "edge_steps": 20}


def proposal(operations, order=None):
    return {"schema": "ifcn.layout_search.v2", "operations": operations,
            "routing_order": copy.deepcopy(order or circuit()["edges"]),
            "rationale": "Offline unit fixture only; not an LLM design proposal."}


def move(node=1, x=3, y=3):
    return {"op": "move", "node": node, "to": [x, y]}


def write_fake_artifacts(folder, candidate, *, baseline=False, marker="offline"):
    folder.mkdir(parents=True, exist_ok=True)
    study.save(folder / "layout_candidate.json", candidate)
    study.save(folder / "routed_dag.json", {"offline_test_fixture": True, "nodes": candidate["nodes"], "edges": candidate["edges"]})
    for name in ("clock.json", "physical.json", "interface.json", "logic.json"):
        actual = "checked_" + name if baseline and name in ("interface.json", "logic.json") else name
        study.save(folder / actual, {"offline_test_fixture": True, "marker": marker, "kind": name})
    (folder / "layout.ifcn").write_text("OFFLINE TEST ONLY: " + marker)
    (folder / "device_energy_input.qca").write_text("OFFLINE TEST ONLY: " + marker)


class GateActionTests(unittest.TestCase):
    def test_internal_moves_are_required_in_both_port_modes(self):
        base = circuit()
        for fixed in (True, False):
            with self.subTest(fixed=fixed):
                self.assertIs(study.validate_action(base, request := proposal([move()]), fixed), request)
                with self.assertRaisesRegex(ValueError, "internal gate"):
                    study.validate_action(base, proposal([]), fixed)
        with self.assertRaisesRegex(ValueError, "locked"):
            study.validate_action(base, proposal([move(0, 1, 0)]), True)
        with self.assertRaisesRegex(ValueError, "internal gate"):
            study.validate_action(base, proposal([move(0, 1, 0)]), False)
        mixed = proposal([move(), move(0, 1, 0)])
        study.validate_action(base, mixed, False)
        with self.assertRaisesRegex(ValueError, "locked"):
            study.validate_action(base, mixed, True)

    def test_swap_is_internal_relocation_and_graph_edits_are_rejected(self):
        base = circuit()
        study.validate_action(base, proposal([{"op": "swap", "nodes": [1, 3]}]), True)
        with self.assertRaises(ValueError):
            study.validate_action(base, proposal([{"op": "delete", "node": 1}]), False)
        with self.assertRaises(ValueError):
            study.validate_action(base, proposal([move()], [[0, 3], [1, 3], [3, 2]]), False)
        with self.assertRaisesRegex(ValueError, "collision"):
            study.validate_action(base, proposal([move(1, 6, 5)]), False)

    def test_action_key_canonicalizes_final_positions_and_preserves_route_priority(self):
        base = circuit()
        moves = [move(1, 6, 5), move(3, 4, 3)]
        a = proposal(moves)
        b = proposal(list(reversed(moves)))
        c = proposal([{"op": "swap", "nodes": [3, 1]}])
        c["rationale"] = "Different wording cannot spend another evaluation."
        self.assertEqual(study.action_key(base, a), study.action_key(base, b))
        self.assertEqual(study.action_key(base, a), study.action_key(base, c))
        reordered = copy.deepcopy(base)
        for field in ("nodes", "edges", "routes", "cells"):
            reordered[field].reverse()
        self.assertEqual(study.action_key(base, a), study.action_key(reordered, a))
        different_order = copy.deepcopy(a)
        different_order["routing_order"].reverse()
        self.assertNotEqual(study.action_key(base, a), study.action_key(base, different_order))
        rephased = copy.deepcopy(base)
        rephased["cells"][0]["phase"] = 2
        self.assertNotEqual(study.action_key(base, a), study.action_key(rephased, a))


def policy_report(area, cells, *, complete=True, calls=3):
    return {"initial": metrics(), "selected": metrics(area, cells), "budget_complete": complete,
            "native_execution_reports": calls, "model_request_attempts": calls,
            "successful_model_proposals": calls, "backend_evaluation_attempts": calls,
            "diagnostic_backend_evaluation_attempts": 0}


class GateAggregateTests(unittest.TestCase):
    fixture_policies = ("deterministic_gate", "llm_gate_direct")

    def rows(self):
        a = {"status": "completed", "eligible": True, "policies": {
            "deterministic_gate": policy_report(90, 95), "llm_gate_direct": policy_report(80, 90)}}
        b = {"status": "completed", "eligible": True, "policies": {
            "deterministic_gate": policy_report(100, 100),
            "llm_gate_direct": policy_report(100, 100, complete=False, calls=0)}}
        return [a, b, {"status": "execution_failed", "eligible": True}, {"status": "unavailable", "eligible": False}]

    def test_paired_complete_denominator_excludes_partial_and_failed_cases(self):
        result = study.aggregate(self.rows(), self.fixture_policies)
        self.assertEqual((result["registered_cases"], result["eligible_cases"], result["completed_cases"]), (4, 3, 2))
        self.assertEqual(result["paired_budget_complete_cases"], 1)
        paired = result["paired_budget_complete_policies"]
        self.assertAlmostEqual(paired["deterministic_gate"]["mean_area_reduction_pct"], 10)
        self.assertAlmostEqual(paired["deterministic_gate"]["mean_qca_reduction_pct"], 5)
        self.assertAlmostEqual(paired["llm_gate_direct"]["mean_area_reduction_pct"], 20)
        self.assertAlmostEqual(paired["llm_gate_direct"]["mean_qca_reduction_pct"], 10)
        for report in result["policies"].values():
            self.assertIsNone(report["mean_area_reduction_pct_all_eligible"])
            self.assertIsNone(report["mean_qca_reduction_pct_all_eligible"])
        self.assertEqual(result["policies"]["llm_gate_direct"]["incomplete_budgets"], 1)
        self.assertEqual(result["policies"]["llm_gate_direct"]["evaluated_cases"], 1)

    def test_all_eligible_mean_keeps_zero_gains_and_empty_pair_is_unavailable(self):
        result = study.aggregate(self.rows()[:2], self.fixture_policies)
        self.assertAlmostEqual(result["policies"]["deterministic_gate"]["mean_area_reduction_pct_all_eligible"], 5)
        self.assertAlmostEqual(result["policies"]["llm_gate_direct"]["mean_area_reduction_pct_all_eligible"], 10)
        empty = study.aggregate([self.rows()[1]], self.fixture_policies)
        self.assertEqual(empty["paired_budget_complete_cases"], 0)
        for report in empty["paired_budget_complete_policies"].values():
            self.assertIsNone(report["mean_area_reduction_pct"])
            self.assertIsNone(report["mean_qca_reduction_pct"])

    def test_warm_start_aggregate_separates_additional_from_total_gain(self):
        rows = self.rows()[:2]
        for row in rows:
            for report in row["policies"].values():
                report["warm_start"] = {"prefix_backend_evaluation_attempts": 4}
                report["original_initial"] = metrics(200, 200)
        result = study.aggregate(rows, self.fixture_policies)
        control = result["policies"]["deterministic_gate"]
        self.assertAlmostEqual(control["mean_area_reduction_pct_all_eligible"], 5)
        self.assertAlmostEqual(control["mean_total_area_reduction_pct_all_eligible"], 52.5)
        self.assertEqual(control["common_prefix_backend_evaluation_attempts"], 8)
        self.assertEqual(control["gain_reference"], "deterministic_prefix_selected")


class OfflineGateRunnerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="offline-gate-runner-unit-")
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name) / "offline_case"
        self.inputs = self.folder / "inputs"
        self.base = circuit()
        write_fake_artifacts(self.inputs, self.base, baseline=True, marker="offline_baseline")
        (self.inputs / "source.v").write_text("// OFFLINE UNIT FIXTURE, never submitted to a tool")
        (self.inputs / "normalized.v").write_text("// OFFLINE UNIT FIXTURE, never submitted to a tool")
        self.input_hashes = {p.name: study.sha(p) for p in self.inputs.iterdir()}
        self.prepared = {"baseline": self.base, "metrics": metrics(), "clock": {"offline_test_fixture": True},
                         "manifest": {"frontend": {"offline_test_fixture": True}, "configuration": {"offline_test_fixture": True}}}
        self.args = SimpleNamespace(port_policy="fixed", rounds=3, candidate_timeout=1, model_timeout=1,
                                    vision=False, guidance="none")
        self.context_history = []

        def fake_context(candidate, current_metrics, clock, history, best_metrics, **kwargs):
            self.context_history.append(copy.deepcopy(history))
            return {"rules": {}, "state_features": {}, "action_space": {}, "offline_test_fixture": True}

        def fake_render(candidate, density, path):
            path.write_bytes(b"OFFLINE TEST IMAGE STUB; not a scientific figure")

        self.enterContext(patch.object(study.gate, "gate_context", side_effect=fake_context))
        self.enterContext(patch.object(study, "control_pool", return_value=[]))
        self.enterContext(patch.object(study, "density_context", return_value={"offline_test_fixture": True}))
        self.enterContext(patch.object(study, "render_layout", side_effect=fake_render))

    def assert_inputs_unchanged(self):
        self.assertEqual({p.name: study.sha(p) for p in self.inputs.iterdir()}, self.input_hashes)

    def assert_archive(self, source):
        selected = self.folder / "llm_gate_direct/selected"
        names = {"layout_candidate.json", "layout.ifcn", "routed_dag.json", "clock.json", "physical.json",
                 "interface.json", "logic.json", "device_energy_input.qca", "source.v", "normalized.v"}
        self.assertEqual({p.name for p in selected.iterdir()}, names)
        for name in names:
            original = (self.inputs if name in ("source.v", "normalized.v") else source) / name
            if not original.exists():
                original = source / ("checked_" + name)
            self.assertEqual(study.sha(selected / name), study.sha(original))

    def run_offline(self, policy="llm_gate_direct"):
        with redirect_stdout(io.StringIO()):
            return study.run_policy(self.folder, policy, self.prepared, self.args,
                                    "OFFLINE_TEST_NO_NODE", {"provider": "offline-unit", "modelId": "fake-never-a-model"})

    def test_placement_model_null_order_is_compiled_from_moved_gates_with_explicit_provenance(self):
        self.args.rounds = 1
        model_proposal = proposal([move(1, 2, 3), move(3, 5, 5)])
        model_proposal["routing_order"] = None
        original_proposal = copy.deepcopy(model_proposal)
        captured_contexts, evaluated = [], []
        placed = study.search.apply_positions(self.base, model_proposal["operations"])
        expected_order = study.search.control_order(placed)

        def fake_model(context, *unused):
            captured_contexts.append(copy.deepcopy(context))
            return {"proposal": model_proposal, "model": {"provider": "offline-unit", "modelId": "fake"}}

        def fake_evaluate(start, compiled, target, *unused, **kwargs):
            evaluated.append(copy.deepcopy(compiled))
            return {"offline_test_fixture": True, "status": "failed", "error": "Synthetic offline routing failure"}

        order = self.enterContext(patch.object(study.search, "control_order", wraps=study.search.control_order))
        self.enterContext(patch.object(study, "model_call", side_effect=fake_model))
        self.enterContext(patch.object(study.search, "evaluate", side_effect=fake_evaluate))
        result = self.run_offline("llm_gate_placement")
        self.assertEqual(len(evaluated), 1)
        self.assertEqual(evaluated[0]["operations"], original_proposal["operations"])
        self.assertEqual(evaluated[0]["routing_order"], expected_order)
        self.assertEqual(model_proposal, original_proposal)
        self.assertIsNone(model_proposal["routing_order"])
        self.assertTrue(any(study.search.key(call.args[0]) == study.search.key(placed) for call in order.call_args_list))
        context = captured_contexts[0]
        self.assertEqual(context["action_space"]["routing_order_owner"], "deterministic_executor")
        self.assertFalse(context["rules"]["require_explicit_routing_order"])
        row = json.loads((self.folder / "llm_gate_placement/01/result.json").read_text())
        self.assertIsNone(row["model_proposal"]["routing_order"])
        self.assertEqual(row["proposal"]["routing_order"], expected_order)
        self.assertEqual(row["routing_order_origin"], "deterministic_executor_from_model_gate_positions")
        self.assertEqual(row["proposal_origin"], "direct_llm_gate_action")
        self.assertEqual(result["backend_evaluation_attempts"], 1)
        self.assertEqual(result["model_request_attempts"], 1)
        self.assertEqual(result["selected"], metrics())
        self.assert_inputs_unchanged()

    def test_placement_model_authored_order_is_rejected_without_silently_replacing_it(self):
        self.args.rounds = 1
        supplied = proposal([move()])
        self.enterContext(patch.object(study, "model_call", return_value={
            "proposal": supplied, "model": {"provider": "offline-unit", "modelId": "fake"}}))
        evaluator = self.enterContext(patch.object(study.search, "evaluate", side_effect=AssertionError("Must reject before native evaluation")))
        result = self.run_offline("llm_gate_placement")
        evaluator.assert_not_called()
        row = json.loads((self.folder / "llm_gate_placement/01/result.json").read_text())
        self.assertEqual(row["status"], "failed")
        self.assertIn("requires null routing order", row["error"])
        self.assertEqual(row["model_proposal"], supplied)
        self.assertNotIn("routing_order_origin", row)
        self.assertEqual(result["backend_evaluation_attempts"], 0)
        self.assertEqual(result["model_request_attempts"], 1)
        self.assertEqual(result["selected"], metrics())

    def test_three_round_exploration_retention_and_diagnostics_never_become_live_feedback(self):
        requests = iter([proposal([move(1, 3, 3)]), proposal([move(1, 2, 3)]), proposal([move(1, 1, 3)])])
        self.enterContext(patch.object(study, "model_call", side_effect=lambda *a, **k: {
            "proposal": next(requests), "model": {"provider": "offline-unit", "modelId": "fake"}, "usage": {"offline_test_fixture": True}}))
        live = iter([(105, 105), (90, 90), (99, 99)])
        starts = []

        def fake_evaluate(start, action, target, *unused, **kwargs):
            starts.append((target.name, study.gate.state_key(start)))
            candidate = refresh_fake_routes(study.search.apply_positions(start, action["operations"]))
            area, cells = next(live) if target.name == "candidate" else (1, 1)
            write_fake_artifacts(target, candidate, marker="OFFLINE-" + target.parent.name + "-" + target.name)
            # Synthetic flags exclusively test runner control flow. They never
            # come from an actual evaluator or certify the synthetic geometry.
            return {"offline_test_fixture": True, "status": "certified", "metrics": metrics(area, cells),
                    "certificates": {"logic": "equivalent", "clock": True, "physical": True, "interface": True}}

        evaluator = self.enterContext(patch.object(study.search, "evaluate", side_effect=fake_evaluate))
        result = self.run_offline()
        self.assertEqual(result["selected"]["area_tiles"], 90)
        self.assertEqual(result["selected"]["qca_cells"], 90)
        self.assertEqual(result["selected_round"], 2)
        self.assertEqual(result["selected_artifact_source"], "llm_gate_direct/02/candidate")
        self.assertEqual(result["backend_evaluation_attempts"], 3)
        self.assertEqual(result["native_execution_reports"], 3)
        self.assertEqual(result["diagnostic_backend_evaluation_attempts"], 2)
        self.assertEqual(evaluator.call_count, 5)
        self.assertEqual([name for name, _ in starts], ["candidate", "candidate", "routing_only", "placement_reference_order", "candidate"])
        self.assertEqual(starts[1][1], starts[2][1])
        self.assertEqual(starts[1][1], starts[3][1])
        rounds = json.loads((self.folder / "llm_gate_direct/summary.json").read_text())["rounds"]
        self.assertEqual([r["decision"] for r in rounds], ["certified_exploration", "improved_retained", "certified_exploration"])
        self.assertEqual([r["start_metrics"]["area_tiles"] for r in rounds], [100, 105, 90])
        self.assertEqual([r["retained_metrics"]["area_tiles"] for r in rounds], [100, 90, 90])
        self.assertNotIn("diagnostics", json.dumps(self.context_history))
        self.assertNotIn('"area_tiles": 1,', json.dumps(self.context_history))
        self.assertTrue((self.folder / "llm_gate_direct/02/attribution.json").is_file())
        self.assert_archive(self.folder / "llm_gate_direct/02/candidate")
        self.assert_inputs_unchanged()

    def test_provider_errors_stop_after_three_attempts_and_archive_checked_baseline(self):
        self.args.rounds = 5

        def fail_model(context, node, model, target, *unused):
            study.save(target / "response.json", {"offline_test_fixture": True, "status": "error",
                       "model": {"provider": "offline-unit", "modelId": "fake"},
                       "error": {"code": "provider_error", "message": "Synthetic offline outage"}})
            raise ValueError("Synthetic offline provider error; no provider was contacted")

        model = self.enterContext(patch.object(study, "model_call", side_effect=fail_model))
        evaluator = self.enterContext(patch.object(study.search, "evaluate", side_effect=AssertionError("Offline error test must not evaluate")))
        result = self.run_offline()
        self.assertEqual(model.call_count, 3)
        evaluator.assert_not_called()
        self.assertEqual(result["model_request_attempts"], 3)
        self.assertEqual(result["successful_model_proposals"], 0)
        self.assertEqual(result["model_errors"], {"provider_error": 3})
        self.assertEqual(result["rounds_completed"], 3)
        self.assertFalse(result["budget_complete"])
        self.assertEqual(result["backend_evaluation_attempts"], 0)
        self.assertEqual(result["native_execution_reports"], 0)
        self.assertEqual(result["selected_artifact_source"], "inputs")
        self.assertEqual(result["selected"], metrics())
        self.assert_archive(self.inputs)
        self.assert_inputs_unchanged()

    def test_backend_start_failure_is_an_attempt_without_a_native_execution_report(self):
        self.args.rounds = 1
        self.enterContext(patch.object(study, "model_call", return_value={"proposal": proposal([move()]), "model": {"provider": "offline-unit"}}))
        evaluator = self.enterContext(patch.object(study.search, "evaluate", side_effect=FileNotFoundError("Offline simulated missing executable")))
        result = self.run_offline()
        self.assertEqual(evaluator.call_count, 1)
        self.assertEqual(result["backend_evaluation_attempts"], 1)
        self.assertEqual(result["native_execution_reports"], 0)
        self.assertEqual(result["diagnostic_backend_evaluation_attempts"], 0)
        self.assertEqual(result["selected"], metrics())
        self.assert_archive(self.inputs)

    def test_continuations_share_prefix_skip_repeats_and_keep_seed_on_no_gain(self):
        # Bookkeeping fixture only: import and physical validation have their
        # own tests. This exercises both continuations after a valid import.
        self.args.rounds = 1
        seed = refresh_fake_routes(study.search.apply_positions(self.base, [move(1, 3, 3)]))
        seed_dir = self.inputs / "warm_start"
        write_fake_artifacts(seed_dir, seed, marker="offline_deterministic_prefix")
        repeated = proposal([move(1, 2, 3)])
        previous = [{"round": 4, "status": "failed", "error": "Offline deterministic prefix failure"}]
        key = study.action_key(seed, repeated)
        self.prepared.update(
            baseline=seed, metrics=metrics(80, 90), seed_artifacts=seed_dir,
            seed_history=copy.deepcopy(previous), seed_seen={key}, seed_expanded={study.gate.state_key(seed)},
            seed_provenance={"original_initial_metrics": metrics(), "prefix_round_budget": 4,
                             "prefix_rounds_completed": 4, "prefix_backend_evaluation_attempts": 4})
        captured_seen = []

        def repeated_pool(candidate, seen, lock_io):
            captured_seen.append(set(seen))
            return [{"proposal": repeated, "proxy": {"offline_test_fixture": True}}]

        self.enterContext(patch.object(study, "control_pool", side_effect=repeated_pool))
        self.enterContext(patch.object(study, "model_call", return_value={"proposal": repeated}))
        evaluator = self.enterContext(patch.object(study.search, "evaluate", side_effect=AssertionError("Repeated prefix action must not run")))
        for policy in ("deterministic_gate", "llm_gate_direct"):
            result = self.run_offline(policy)
            self.assertEqual(result["initial"], metrics(80, 90))
            self.assertEqual(result["selected"], metrics(80, 90))
            self.assertEqual(result["selected_artifact_source"], "inputs/warm_start")
            self.assertEqual(result["rounds_completed"], 1)
            self.assertEqual(result["cumulative_rounds_completed"], 5)
            self.assertEqual(result["cumulative_backend_evaluation_attempts"], 4)
            self.assertIsNone(result["selected_round"])
            self.assertEqual(result["incremental_gain"]["area_reduction_pct"], 0)
            self.assertAlmostEqual(result["total_gain"]["area_reduction_pct"], 20)
            row = json.loads((self.folder / policy / "01/result.json").read_text())
            self.assertEqual(row["start_state"], study.gate.state_key(seed))
            self.assertEqual(row["cumulative_round"], 5)
            self.assertIn("Repeated exact", row["error"])
            selected = self.folder / policy / "selected"
            self.assertEqual(study.sha(selected / "layout.ifcn"), study.sha(seed_dir / "layout.ifcn"))
            self.assertEqual(study.sha(selected / "device_energy_input.qca"), study.sha(seed_dir / "device_energy_input.qca"))
        evaluator.assert_not_called()
        self.assertEqual(captured_seen, [{key}, {key}])
        self.assertEqual(self.context_history, [previous, previous])
        self.assertEqual(self.prepared["seed_history"], previous)
        self.assertEqual(self.prepared["seed_seen"], {key})
        self.assert_archive(seed_dir)


if __name__ == "__main__":
    unittest.main()
