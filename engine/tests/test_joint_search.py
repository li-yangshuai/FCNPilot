"""Offline joint-search contracts and evaluator orchestration.

Native execution and proof generation are controlled fakes. Real temporary
artifacts, QCA counts, certificate content bindings, and failure persistence are
used, but these tests do not establish physical legality or model improvement.
No model requests, credentials, native compilation, or archived-run writes occur.
"""
from __future__ import annotations

from contextlib import ExitStack
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "scripts"))
import ifcn_joint_search as search


def fixture():
    return json.loads((ENGINE / "tests/fixtures/combinational_rephase/xor2.json").read_text())


def proposal(graph, operations=None, order=None):
    return {"schema": "ifcn.layout_search.v2", "operations": operations or [],
            "routing_order": copy.deepcopy(graph["edges"] if order is None else order),
            "rationale": "Route the selected difficult edges first without changing the DAG."}


def qca_text(count=7):
    functions = ["QCAD_CELL_INPUT", "QCAD_CELL_INPUT", "QCAD_CELL_OUTPUT"]
    functions += ["QCAD_CELL_NORMAL"] * (count - len(functions))
    return "\n".join("[TYPE:QCADCell]\ncell_function=" + role + "\n[#TYPE:QCADCell]"
                     for role in functions) + "\n"


class ProposalContractTests(unittest.TestCase):
    def setUp(self):
        self.graph = fixture()

    def assert_invalid(self, item):
        with self.assertRaises(ValueError):
            search.validate_proposal(item, self.graph)

    def test_route_only_with_complete_nondefault_order_is_valid(self):
        item = proposal(self.graph, order=list(reversed(self.graph["edges"])))
        before = copy.deepcopy(self.graph)
        self.assertEqual(search.validate_proposal(item, self.graph), item)
        self.assertEqual(item["operations"], [])
        self.assertEqual(self.graph, before)

    def test_fixed_io_rejects_port_moves_and_swaps_but_keeps_legacy_default(self):
        before = copy.deepcopy(self.graph)
        for operations in [[{"op": "move", "node": 0, "to": [21, 20]}],
                           [{"op": "move", "node": 2, "to": [21, 28]}],
                           [{"op": "swap", "nodes": [0, 3]}],
                           [{"op": "swap", "nodes": [3, 2]}]]:
            item = proposal(self.graph, operations)
            with self.subTest(operations=operations):
                self.assertEqual(search.validate_proposal(item, self.graph), item)
                with self.assertRaisesRegex(ValueError, "coordinates are locked"):
                    search.validate_proposal(item, self.graph, lock_io=True)
        self.assertEqual(self.graph, before)

    def test_fixed_io_allows_coordinated_internal_moves_and_routing_only(self):
        operations = [{"op": "move", "node": 3, "to": [20, 23]},
                      {"op": "move", "node": 4, "to": [22, 23]}]
        for item in [proposal(self.graph, operations), proposal(self.graph)]:
            self.assertEqual(search.validate_proposal(item, self.graph, lock_io=True), item)
        after = search.apply_positions(self.graph, operations)
        self.assertEqual(search._io_positions(after), search._io_positions(self.graph))
        for value in [None, 1, "true"]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "Boolean"):
                search.validate_proposal(proposal(self.graph), self.graph, lock_io=value)
        unmarked = copy.deepcopy(self.graph); del unmarked["nodes"][0]["is_input"]
        with self.assertRaisesRegex(ValueError, "PI/PO identities"):
            search.validate_proposal(proposal(unmarked), unmarked, lock_io=True)

    def test_exact_v2_top_fields_required(self):
        for missing in ["schema", "operations", "routing_order", "rationale"]:
            item = proposal(self.graph)
            del item[missing]
            with self.subTest(missing=missing): self.assert_invalid(item)
        for extra in ["edges", "dag", "clock_scheme", "route_retries", "tools"]:
            item = proposal(self.graph)
            item[extra] = []
            with self.subTest(extra=extra): self.assert_invalid(item)
        item = proposal(self.graph)
        item["schema"] = "ifcn.layout_edit.v1"
        self.assert_invalid(item)

    def test_order_rejects_missing_duplicate_foreign_reversed_and_malformed_edges(self):
        original = self.graph["edges"]
        variants = [original[:-1], original + [original[0]],
                    [original[0]] * len(original),
                    [list(reversed(original[0]))] + original[1:],
                    [[0, 9999]] + original[1:],
                    [[True, original[0][1]]] + original[1:],
                    [[0.0, original[0][1]]] + original[1:],
                    [[0]] + original[1:], [tuple(original[0])] + original[1:],
                    None, {}, "0,3"]
        for order in variants:
            item = proposal(self.graph)
            item["routing_order"] = copy.deepcopy(order)
            with self.subTest(order=order): self.assert_invalid(item)

    def test_move_and_swap_reject_bad_identity_coordinates_and_fields(self):
        bad = [{"op": "move", "node": True, "to": [21, 20]},
               {"op": "move", "node": 999, "to": [21, 20]},
               {"op": "move", "node": 0, "to": [True, 21]},
               {"op": "move", "node": 0, "to": [21.0, 21]},
               {"op": "move", "node": 0, "to": [20, 20]},
               {"op": "move", "node": 0, "to": [-1, 20]},
               {"op": "move", "node": 0, "to": [99, 99]},
               {"op": "move", "node": 0, "to": [21, 20], "phase": 2},
               {"op": "swap", "nodes": [0, 0]},
               {"op": "swap", "nodes": [0, True]},
               {"op": "swap", "nodes": [0, 999]},
               {"op": "swap", "nodes": [0, 1], "phase": 2},
               {"op": "cut", "axis": "y"}, None]
        for operation in bad:
            with self.subTest(operation=operation): self.assert_invalid(proposal(self.graph, [operation]))

    def test_repeated_node_and_final_collisions_are_rejected(self):
        variants = [[{"op": "move", "node": 0, "to": [21, 20]},
                     {"op": "move", "node": 0, "to": [21, 21]}],
                    [{"op": "swap", "nodes": [0, 1]},
                     {"op": "move", "node": 1, "to": [21, 21]}],
                    [{"op": "move", "node": 0, "to": [22, 20]}]]
        for operations in variants:
            with self.subTest(operations=operations): self.assert_invalid(proposal(self.graph, operations))

    def test_coordinated_moves_may_exchange_two_positions(self):
        operations = [{"op": "move", "node": 0, "to": [22, 20]},
                      {"op": "move", "node": 1, "to": [20, 20]}]
        search.validate_proposal(proposal(self.graph, operations), self.graph)
        after = search.apply_positions(self.graph, operations)
        positions = {n["id"]: (n["x"], n["y"]) for n in after["nodes"]}
        self.assertEqual(positions[0], (22, 20))
        self.assertEqual(positions[1], (20, 20))

    def test_rationale_and_operation_bounds(self):
        for value in [None, "", "  ", "x" * 1201]:
            item = proposal(self.graph); item["rationale"] = value
            with self.subTest(rationale=value): self.assert_invalid(item)
        self.assert_invalid(proposal(self.graph, [{"op": "move", "node": 0, "to": [21, 20]}] * 9))
        for cap in [True, False, -1, 9, "8"]:
            with self.subTest(max_operations=cap), self.assertRaises(ValueError):
                search.validate_proposal(proposal(self.graph), self.graph, max_operations=cap)

    def test_eight_independent_moves_are_within_the_joint_contract(self):
        graph = {"nodes": [{"id": n, "x": 20 + 2 * n, "y": 20} for n in range(8)],
                 "edges": [[n, n + 1] for n in range(7)], "routes": []}
        operations = [{"op": "move", "node": n, "to": [20 + 2 * n, 21]} for n in range(8)]
        item = proposal(graph, operations)
        self.assertEqual(search.validate_proposal(item, graph), item)
        with self.assertRaises(ValueError):
            search.validate_proposal(item, graph, max_operations=3)

    def test_apply_positions_only_changes_requested_coordinates_without_mutation(self):
        before = copy.deepcopy(self.graph)
        ops = [{"op": "move", "node": 2, "to": [21, 28]}, {"op": "swap", "nodes": [0, 1]}]
        search.validate_proposal(proposal(self.graph, ops), self.graph)
        after = search.apply_positions(self.graph, ops)
        self.assertEqual(self.graph, before)
        self.assertEqual(after["edges"], before["edges"])
        self.assertEqual(after["routes"], before["routes"])
        for a, b in zip(before["nodes"], after["nodes"]):
            self.assertEqual({k: v for k, v in a.items() if k not in ("x", "y")},
                             {k: v for k, v in b.items() if k not in ("x", "y")})
        self.assertEqual((after["nodes"][2]["x"], after["nodes"][2]["y"]), (21, 28))


class ContextAndObjectiveTests(unittest.TestCase):
    def test_control_order_is_a_complete_deterministic_fixed_policy(self):
        graph = {"nodes": [{"id": n, "x": x, "y": y} for n, (x, y) in
                            enumerate([(0, 0), (4, 0), (1, 3), (4, 4)])],
                 "layers": [[0, 1], [2], [3]], "edges": [[2, 3], [1, 2], [0, 2], [0, 3]]}
        before = copy.deepcopy(graph)
        self.assertEqual(search.control_order(graph), [[0, 3], [1, 2], [0, 2], [2, 3]])
        self.assertEqual(graph, before)
        graph["edges"].reverse()
        self.assertEqual(search.control_order(graph), search.control_order(before))

    def test_context_exposes_real_route_costs_xy_gaps_and_clock_state(self):
        graph = fixture(); before = copy.deepcopy(graph)
        metrics = {"area_tiles": 40, "qca_cells": 160}
        clock = {"arrival_tick_ranges": {"2": [11, 11]},
                 "route_delays": [{"source": 5, "target": 2, "ticks": 4}]}
        history = [{"round": i, "status": "failed", "error": "clock alignment failed",
                    "proposal": proposal(graph), "routing_audit": {"fallback_used": False},
                    "unrouted_edges": [[0, 3]], "phase_repair": {"status": "infeasible"},
                    "clock_diagnostics": {"passed": False, "mismatches": [{"node": 2}]}} for i in range(6)]
        context = search.context_for(graph, metrics, clock, history)
        self.assertEqual(graph, before)
        self.assertEqual(context["action_space"]["proposal_schema"], "ifcn.layout_search.v2")
        self.assertEqual(context["action_space"]["max_operations"], 8)
        self.assertTrue(context["rules"]["require_explicit_routing_order"])
        state = context["state_features"]
        self.assertEqual(state["absolute_arrival_ticks"], clock["arrival_tick_ranges"])
        self.assertEqual(state["route_delay_ticks"], clock["route_delays"])
        self.assertEqual(state["phase_map_native_1_based"], graph["cells"])
        self.assertEqual([(r["level"], r["gap_from_previous"]) for r in state["gate_levels"]["x"]],
                         [(20, None), (21, 1), (22, 1)])
        self.assertEqual([(r["level"], r["gap_from_previous"]) for r in state["gate_levels"]["y"]],
                         [(20, None), (23, 3), (26, 3), (29, 3)])
        cost = {tuple(r["edge"]): r for r in state["route_costs"]}
        self.assertEqual((cost[1, 3]["steps"], cost[1, 3]["manhattan_lower_bound"], cost[1, 3]["detour_steps"]), (5, 3, 2))
        self.assertEqual(state["routed_extent"]["area_tiles"], 40)
        self.assertEqual([r["round"] for r in context["feedback"]], [2, 3, 4, 5])
        self.assertEqual(context["feedback"][-1]["error"], "clock alignment failed")
        self.assertEqual(context["feedback"][-1]["unrouted_edges"], [[0, 3]])
        self.assertEqual(context["feedback"][-1]["phase_repair"], {"status": "infeasible"})
        self.assertEqual(context["feedback"][-1]["clock_diagnostics"]["mismatches"], [{"node": 2}])
        for suggestion in state["geometric_cut_suggestions"]:
            self.assertIn(suggestion["axis"], ["x", "y"])
            self.assertNotIn("certified", suggestion)
            search.validate_proposal(proposal(graph, suggestion["operations"]), graph)

    def test_fixed_io_context_exposes_only_internal_actions_without_pinning_phases(self):
        graph = fixture(); before = copy.deepcopy(graph)
        legacy = search.context_for(graph, {}, {}, [])
        locked = search.context_for(graph, {}, {}, [], lock_io=True)
        fixed = {n["id"] for n in graph["nodes"] if n["is_input"] or n["is_output"]}
        self.assertTrue(legacy["rules"]["port_coordinates_movable"])
        self.assertEqual(legacy["action_space"]["movable_node_ids"], [n["id"] for n in graph["nodes"]])
        self.assertFalse(locked["rules"]["port_coordinates_movable"])
        self.assertIn("does not pin phases", locked["rules"]["port_coordinate_scope"])
        self.assertEqual(locked["action_space"]["movable_node_ids"], [3, 4, 5])
        self.assertEqual(locked["state_features"]["phase_map_native_1_based"], graph["cells"])
        self.assertTrue(any(any(op["node"] in fixed for op in item["operations"])
                            for item in legacy["state_features"]["geometric_cut_suggestions"]))
        for item in locked["state_features"]["geometric_cut_suggestions"]:
            self.assertTrue(all(op["node"] not in fixed for op in item["operations"]))
            search.validate_proposal(proposal(graph, item["operations"]), graph, lock_io=True)
        self.assertEqual(graph, before)

    def test_pareto_requires_strict_area_or_cells_without_trading_the_other(self):
        before = {"area_tiles": 40, "qca_cells": 160, "run_time_s": 99, "width": 4, "height": 10}
        for area, cells, accepted in [(40, 160, False), (39, 160, True), (40, 159, True),
                                      (39, 159, True), (41, 159, False), (39, 161, False), (41, 161, False)]:
            with self.subTest(area=area, cells=cells):
                after = {**before, "area_tiles": area, "qca_cells": cells, "run_time_s": 0.1,
                         "edge_steps": 0, "width": 2, "height": 20}
                self.assertEqual(search.pareto(before, after), accepted)


class EvaluateContractsTests(unittest.TestCase):
    def evaluate(self, changes=None, summary_change=None, proof_change=None, broken=None, times=None, lock_io=False, operations=None):
        graph = fixture(); item = proposal(graph, operations, order=list(reversed(graph["edges"])))
        after = search.apply_positions(graph, item["operations"])
        after["edit"] = {"requested_order": copy.deepcopy(item["routing_order"]),
                         "executed_order": copy.deepcopy(item["routing_order"]),
                         "route_order_attempts": 1, "fallback_used": False, "explicit_routing_order": True, "io_locked": lock_io}
        if changes: changes(after)
        summary = {"algorithm": graph["algorithm"], "clock_scheme": "irregular", "layout_legal": True,
                   "failed_edge_count": 0, "clock_legal": True, "validation": {"passed": True},
                   "width": 4, "height": 10, "area_tiles": 40}
        if summary_change: summary_change(summary)
        logic = {"status": "equivalent"}
        clock = {"passed": True, "arrival_tick_ranges": {"2": [11, 11]}}
        if proof_change: proof_change(logic, clock)
        calls = []
        with tempfile.TemporaryDirectory(prefix="ifcn-joint-contract-") as temporary:
            root = Path(temporary); target = root / "candidate"
            (root / "source.v").write_text("module top(input a,b,output out); assign out=a^b; endmodule\n")
            (root / "normalized.v").write_text((root / "source.v").read_text())
            def invoke(command, out, deadline, name):
                calls.append(name)
                (out / (name + ".log")).write_text("Controlled offline executor.\n")
                if name == "evaluation":
                    self.assertEqual("--lock-io" in command, lock_io)
                    search.save(out / "pnr.json", summary)
                    if broken == "candidate":
                        (out / "layout_candidate.json").write_text('{"nodes":')
                        raise TimeoutError("native interrupted")
                    search.save(out / "layout_candidate.json", after)
                    search.save(out / "routed_dag.json", after)
                    (out / "layout.ifcn").write_text("Controlled IFCN placeholder; clock proof is mocked.\n")
                    if broken == "phase_repair":
                        (out / "phase_repair.json").write_text('{"status":')
                        raise TimeoutError("phase repair interrupted")
                else:
                    (out / "device_energy_input.qca").write_text(qca_text())
                    search.save(out / "device_physical_validation.json", {
                        "schema": "ifcn.qca.physical_routes.v1", "passed": True,
                        "checks": ["ordered_route_continuity", "source_site_isolation", "layer_transition_columns",
                                   "route_site_coverage", "gate_connection_ports"],
                        "net_count": 7, "route_count": 7, "cell_count": 7})
            with ExitStack() as stack:
                stack.enter_context(patch.object(search, "invoke", side_effect=invoke))
                stack.enter_context(patch.object(search.api, "logic_report", return_value=logic))
                stack.enter_context(patch.object(search, "clock_arrival_report", return_value=clock))
                if times is not None: stack.enter_context(patch.object(search.time, "monotonic", side_effect=times))
                row = search.evaluate(graph, item, target, root / "source.v", root / "normalized.v",
                                      {"inputs": ["a", "b"], "outputs": ["out"]},
                                      {"python": "offline-python", "backend": "offline-backend", "energy_binary": "offline-export"}, 20, lock_io=lock_io)
            self.assertTrue((target / "start.json").is_file())
            self.assertEqual(json.loads((target / "proposal.json").read_text()), item)
            self.assertEqual(json.loads((target / "result.json").read_text()), row)
            return row, calls

    def test_route_only_candidate_is_certified_using_actual_qca_count(self):
        row, calls = self.evaluate()
        self.assertEqual(row["status"], "certified")
        self.assertEqual(calls, ["evaluation", "export"])
        self.assertEqual(row["moves"], [])
        self.assertEqual((row["metrics"]["area_tiles"], row["metrics"]["qca_cells"]), (40, 7))
        self.assertEqual(row["routing_audit"]["requested_order"], row["routing_audit"]["executed_order"])
        self.assertEqual(row["metrics"]["output_arrival_ticks"], {"2": [11, 11]})

    def test_fixed_io_native_audit_and_internal_moves_reach_certification(self):
        operations = [{"op": "move", "node": 3, "to": [20, 23]},
                      {"op": "move", "node": 4, "to": [22, 23]}]
        row, calls = self.evaluate(lock_io=True, operations=operations)
        self.assertEqual(row["status"], "certified")
        self.assertEqual(calls, ["evaluation", "export"])
        self.assertEqual(len(row["moves"]), 2)
        self.assertEqual(row["io_lock"]["fixed_node_ids"], [0, 1, 2])
        self.assertTrue(row["io_lock"]["passed"])
        self.assertTrue(row["routing_audit"]["io_locked"])
        self.assertIn("not pinned", row["io_lock"]["scope"])

    def test_fixed_io_rejects_missing_or_forged_audit_before_export(self):
        for value in [False, None, 1, "true"]:
            with self.subTest(value=value):
                row, calls = self.evaluate(lock_io=True, changes=lambda a: a["edit"].update(io_locked=value))
                self.assertEqual(row["status"], "failed")
                self.assertEqual(calls, ["evaluation"])
                self.assertIn("did not confirm fixed I/O", row["error"])

    def test_fixed_io_rechecks_input_and_output_xy_even_with_positive_audit(self):
        for node in [0, 2]:
            with self.subTest(node=node):
                row, calls = self.evaluate(lock_io=True, changes=lambda a: a["nodes"][node].update(x=99))
                self.assertEqual(row["status"], "failed")
                self.assertEqual(calls, ["evaluation"])
                self.assertIn("changed fixed PI/PO", row["error"])
                self.assertTrue(row["routing_audit"]["io_locked"])

    def test_native_must_prove_exact_single_order_and_no_fallback(self):
        mutations = [("requested_order", []), ("executed_order", []), ("route_order_attempts", 2),
                     ("route_order_attempts", True), ("route_order_attempts", "1"),
                     ("fallback_used", True), ("fallback_used", None),
                     ("explicit_routing_order", False), ("explicit_routing_order", None)]
        for field, value in mutations:
            with self.subTest(field=field, value=value):
                row, calls = self.evaluate(changes=lambda a, f=field, v=value: a["edit"].update({f: v}))
                self.assertEqual(row["status"], "failed")
                self.assertNotIn("export", calls)
                self.assertIn("route order", row["error"])

    def test_executor_cannot_change_unrequested_node_or_graph_identity(self):
        variants = [lambda a: a["nodes"][0].update(x=21),
                    lambda a: a["nodes"][0].update(name="changed-port"),
                    lambda a: a["edges"].pop()]
        for mutate in variants:
            row, calls = self.evaluate(changes=mutate)
            self.assertEqual(row["status"], "failed")
            self.assertNotIn("export", calls)

    def test_failed_clock_or_logic_never_certifies(self):
        for kind in ["clock", "logic"]:
            def mutate(logic, clock):
                if kind == "clock": clock["passed"] = False
                else: logic["status"] = "inequivalent"
            with self.subTest(kind=kind):
                row, _ = self.evaluate(proof_change=mutate)
                self.assertEqual(row["status"], "failed")

    def test_misreported_routed_area_and_late_certification_are_failures(self):
        row, _ = self.evaluate(summary_change=lambda s: s.update(area_tiles=20))
        self.assertEqual(row["status"], "failed")
        self.assertIn("Routed bounds", row["error"])
        row, _ = self.evaluate(times=[0.0, 21.0, 21.0])
        self.assertEqual(row["status"], "failed")
        self.assertIn("budget", row["error"])

    def test_truncated_native_artifacts_preserve_failed_result_instead_of_crashing(self):
        for artifact in ["candidate", "phase_repair"]:
            with self.subTest(artifact=artifact):
                row, _ = self.evaluate(broken=artifact)
                self.assertEqual(row["status"], "failed")
                self.assertIn("interrupted", row["error"])


class PairedAblationIsolationTests(unittest.TestCase):
    def test_shadow_exceptions_do_not_discard_an_accepted_joint_candidate(self):
        """Counterfactual failures cannot veto the independent live trajectory."""
        runner_path = ENGINE.parent / "experiments/llm_joint_search/run_study.py"
        spec = importlib.util.spec_from_file_location("ifcn_joint_runner_contract", runner_path)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        baseline = fixture()
        original = copy.deepcopy(baseline)
        initial = {"width": 4, "height": 10, "area_tiles": 40, "qca_cells": 160}
        improved = {"width": 3, "height": 10, "area_tiles": 30, "qca_cells": 150}
        timing = {"passed": True, "arrival_tick_ranges": {"2": [11, 11]}}
        item = proposal(baseline, [{"op": "move", "node": 2, "to": [21, 28]}],
                        order=list(reversed(baseline["edges"])))
        contexts = []
        invoked = []
        with tempfile.TemporaryDirectory(prefix="ifcn-joint-shadow-") as temporary:
            out = Path(temporary); inputs = out / "inputs"; inputs.mkdir()
            (inputs / "source.v").write_text("Controlled source; native execution is mocked.\n")
            (inputs / "normalized.v").write_text((inputs / "source.v").read_text())

            def model_call(node, context, model, target, request_id):
                contexts.append(copy.deepcopy(context))
                audit = {"status": "ok", "proposal": item, "model": model, "usage": {"totalTokens": 10}}
                search.save(target / "request.json", {"request_id": request_id, "context": context})
                search.save(target / "response.json", audit)
                return audit, 0.01

            def evaluate(start, selected, target, *unused):
                invoked.append((target.name, copy.deepcopy(start)))
                if target.name != "joint":
                    raise RuntimeError("Controlled " + target.name + " infrastructure failure")
                target.mkdir()
                (target / "evaluation.log").write_text("Controlled certified live candidate.\n")
                search.save(target / "layout_candidate.json", search.apply_positions(start, selected["operations"]))
                search.save(target / "clock.json", timing)
                return {"status": "certified", "proposal": selected, "metrics": improved,
                        "routing_audit": {"requested_order": selected["routing_order"],
                                          "executed_order": selected["routing_order"],
                                          "route_order_attempts": 1, "fallback_used": False,
                                          "explicit_routing_order": True}}

            with patch.object(runner, "model_call", side_effect=model_call), \
                 patch.object(runner.search, "evaluate", side_effect=evaluate), \
                 patch("builtins.print"):
                report = runner.run_policy(out, "llm_joint", baseline, initial, timing, inputs,
                                           {"inputs": ["a", "b"], "outputs": ["out"]}, {}, "offline-node",
                                           {"provider": "offline", "modelId": "controlled"}, 1, 20)
            self.assertEqual(report["status"], "completed")
            self.assertEqual(report["selected"], improved)
            self.assertEqual(report["selected_round"], 1)
            self.assertEqual(report["outcomes"], {"accepted": 1})
            self.assertEqual(report["live_native_evaluations"], 1)
            self.assertEqual(report["real_model_requests"], 1)
            self.assertEqual(report["paired_native_evaluations"], 0)
            row = report["rounds"][0]
            self.assertEqual(row["status"], "accepted")
            self.assertEqual(row["metrics"], improved)
            self.assertEqual([name for name, _ in invoked], ["joint", "placement_only", "routing_only"])
            self.assertTrue(all(start == original for _, start in invoked))
            self.assertEqual(len(contexts), 1)
            for name in ["placement_only", "routing_only"]:
                shadow = row["paired_ablations"][name]
                self.assertEqual(shadow["status"], "failed")
                self.assertIn(name, shadow["error"])
                saved = json.loads((out / "llm_joint/01" / name / "result.json").read_text())
                self.assertEqual(saved["status"], "failed")
            saved = json.loads((out / "llm_joint/result.json").read_text())
            self.assertEqual(saved["selected"], improved)
            self.assertEqual(saved["rounds"][0]["status"], "accepted")
        self.assertEqual(baseline, original)


if __name__ == "__main__":
    unittest.main()
