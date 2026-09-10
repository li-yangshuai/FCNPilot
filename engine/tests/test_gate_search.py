"""Search-contract regressions; no model call or native evaluator is used."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ifcn_gate_search as gate
import ifcn_joint_search as search


def circuit():
    return {
        "algorithm": "june_random", "routed": True,
        "nodes": [
            {"id": 0, "name": "a", "type": "input", "is_input": True,
             "is_output": False, "x": 0, "y": 0},
            {"id": 1, "name": "g", "type": "wire", "is_input": False,
             "is_output": False, "x": 4, "y": 3},
            {"id": 2, "name": "z", "type": "wire", "is_input": False,
             "is_output": True, "x": 0, "y": 6}],
        "edges": [[0, 1], [1, 2]], "layers": [[0], [1], [2]],
        "cells": [{"x": 0, "y": 0, "phase": 1}, {"x": 1, "y": 0, "phase": 2}],
        "routes": [
            {"source": 0, "target": 1,
             "path": [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [4, 3]]},
            {"source": 1, "target": 2,
             "path": [[4, 3], [3, 3], [2, 3], [1, 3], [0, 3], [0, 4], [0, 5], [0, 6]]}]}


def metrics(area=35, cells=100):
    return {"width": 5, "height": 7, "area_tiles": area, "qca_cells": cells, "edge_steps": 14}


def certified(candidate=None, area=35, cells=100):
    return {"candidate": candidate or circuit(), "metrics": metrics(area, cells), "clock": {},
            "status": "certified", "certificates": {"logic": "equivalent", "clock": True,
                                                       "physical": True, "interface": True}}


class GateContextTests(unittest.TestCase):
    def test_fixed_ports_are_an_inclusive_lower_bound_not_an_achievability_claim(self):
        context = gate.gate_context(circuit(), metrics(), {}, [], metrics())
        envelope = context["state_features"]["fixed_port_envelope"]
        self.assertEqual(envelope["width_lower_bound_tiles"], 1)
        self.assertEqual(envelope["height_lower_bound_tiles"], 7)
        self.assertEqual(envelope["area_lower_bound_tiles"], 7)
        self.assertFalse(envelope["current_area_equals_lower_bound"])
        self.assertIn("not a routability guarantee", envelope["scope"])
        attained = gate.gate_context(circuit(), metrics(7), {}, [], metrics(7))
        self.assertTrue(attained["state_features"]["fixed_port_envelope"]["current_area_equals_lower_bound"])

    def test_direct_context_has_observations_but_no_candidate_menu(self):
        original = circuit()
        context = gate.gate_context(original, metrics(), {}, [], metrics())
        self.assertNotIn("candidate_menu", context)
        self.assertNotIn("geometric_cut_suggestions", context["state_features"])
        self.assertEqual(context["action_space"]["selection_mode"], "direct")
        self.assertEqual(context["action_space"]["max_operations"], 8)
        self.assertEqual(context["action_space"]["movable_node_ids"], [1])
        self.assertTrue(context["action_space"]["cross_region_moves_allowed"])
        self.assertTrue(context["action_space"]["must_change_internal_node"])
        self.assertFalse(context["action_space"]["empty_operations_allow_routing_only"])
        self.assertIn("At least one true internal node must change XY", context["rules"]["search_contract"])
        self.assertTrue(context["state_features"]["spatial_regions"])
        self.assertEqual(context["state_features"]["internal_neighbor_anchors"][0]["neighbor_median_xy"], [0, 0])
        self.assertEqual(context["state_features"]["route_costs"][0]["steps"], 7)
        proposal = {"schema": "ifcn.layout_search.v2", "operations": [{"op": "move", "node": 1, "to": [0, 3]}],
                    "routing_order": [[1, 2], [0, 1]], "rationale": "Relocate the internal wire and route its output first."}
        search.validate_proposal(proposal, original, lock_io=True)
        context["dag"]["edges"][0][0] = 999
        self.assertEqual(original["edges"][0][0], 0)

    def test_free_ports_do_not_turn_the_incumbent_envelope_into_a_bound(self):
        context = gate.gate_context(circuit(), metrics(), {}, [], metrics(), lock_io=False)
        self.assertNotIn("fixed_port_envelope", context["state_features"])
        envelope = context["state_features"]["incumbent_port_envelope"]
        self.assertNotIn("area_lower_bound_tiles", envelope)
        self.assertFalse(envelope["coordinates_locked"])
        self.assertEqual(context["action_space"]["movable_node_ids"], [0, 1, 2])
        self.assertTrue(context["rules"]["port_coordinates_movable"])
        self.assertTrue(context["action_space"]["must_change_internal_node"])
        self.assertFalse(context["action_space"]["empty_operations_allow_routing_only"])
        with self.assertRaisesRegex(ValueError, "Boolean"):
            gate.gate_context(circuit(), metrics(), {}, [], metrics(), lock_io=1)

    def test_past_candidate_feedback_contains_failures_and_actual_metric_deltas(self):
        proposal = {"operations": [{"op": "move", "node": 1, "to": [2, 3]}]}
        history = [{"round": 1, "status": "no_pareto_gain", "start_metrics": metrics(),
                    "candidates": [
                        {"candidate_id": "bad", "proposal": proposal,
                         "result": {"status": "failed", "error": "route blocked", "unrouted_edges": [[1, 2]],
                                    "clock_diagnostics": {"passed": False, "errors": ["phase conflict"]}}},
                        {"candidate_id": "legal", "proposal": proposal, "result": certified(cells=103)}]}]
        before = copy.deepcopy(history)
        context = gate.gate_context(circuit(), metrics(), {}, history, metrics())
        bad, legal = context["feedback"]
        self.assertEqual(bad["error"], "route blocked")
        self.assertEqual(bad["unrouted_edges"], [[1, 2]])
        self.assertEqual(bad["clock_diagnostics"]["errors"], ["phase conflict"])
        self.assertEqual(legal["metric_delta_from_start"]["qca_cells"], 3)
        self.assertEqual(legal["status"], "certified")
        self.assertNotIn("candidate", legal)
        self.assertEqual(history, before)

    def test_feedback_is_bounded_and_direct_round_errors_are_retained(self):
        history = [{"round": i, "status": "failed", "error": "x" * 3000} for i in range(20)]
        context = gate.gate_context(circuit(), metrics(), {}, history, metrics())
        self.assertEqual([r["round"] for r in context["feedback"]], [16, 17, 18, 19])
        self.assertEqual(len(context["feedback"][0]["error"]), 700)
        history = [{"round": 1, "candidates": [{"result": {"status": "failed"}} for _ in range(40)]}]
        self.assertEqual(len(gate.gate_context(circuit(), metrics(), {}, history, metrics())["feedback"]), 12)


class GateStateTests(unittest.TestCase):
    def test_key_ignores_artifact_order_but_distinguishes_route_and_phase(self):
        base = circuit(); reordered = copy.deepcopy(base)
        for field in ("nodes", "edges", "routes", "cells"):
            reordered[field].reverse()
        reordered["description"] = "metadata only"
        self.assertEqual(gate.state_key(base), gate.state_key(reordered))
        polyline = copy.deepcopy(base)
        polyline["routes"][0]["path"] = [[0, 0], [4, 0], [4, 3]]
        self.assertEqual(gate.state_key(base), gate.state_key(polyline))
        rerouted = copy.deepcopy(base)
        rerouted["routes"][0]["path"] = [[0, 0], [0, 3], [4, 3]]
        self.assertNotEqual(gate.state_key(base), gate.state_key(rerouted))
        rephased = copy.deepcopy(base); rephased["cells"][0]["phase"] = 4
        self.assertNotEqual(gate.state_key(base), gate.state_key(rephased))

    def test_certified_exploration_does_not_modify_retained_best(self):
        base, best_metrics = circuit(), metrics()
        moved = search.apply_positions(base, [{"op": "move", "node": 1, "to": [3, 3]}])
        before = copy.deepcopy((base, best_metrics))
        row = certified(moved, area=38, cells=110)
        selected, decision = gate.select_state(base, best_metrics, {}, [row], {gate.state_key(base)})
        self.assertEqual(decision, "certified_exploration")
        self.assertEqual(selected["metrics"]["qca_cells"], 110)
        self.assertEqual((base, best_metrics), before)
        selected["candidate"]["nodes"][0]["x"] = 99
        self.assertEqual(row["candidate"]["nodes"][0]["x"], 0)

    def test_exploration_bound_is_relative_to_best_and_cannot_accumulate_drift(self):
        base = circuit()
        moved = search.apply_positions(base, [{"op": "move", "node": 1, "to": [3, 3]}])
        for area, cells in ((39, 100), (35, 111), (39, 111)):
            selected, decision = gate.select_state(base, metrics(), {}, [certified(moved, area, cells)], set())
            self.assertEqual(decision, "retain_best")
            self.assertEqual(selected["metrics"], metrics())

    def test_improvement_is_prioritized_over_exploration(self):
        base = circuit(); gain = certified(cells=99)
        selected, decision = gate.select_state(base, metrics(), {}, [certified(cells=110), gain], set())
        self.assertEqual(decision, "improved_retained")
        self.assertEqual(selected["metrics"]["qca_cells"], 99)

    def test_invalid_certificates_never_enter_best_or_exploration(self):
        for field, value in (("logic", "unknown"), ("clock", False), ("physical", 1), ("interface", None)):
            row = certified(cells=50); row["certificates"][field] = value
            self.assertEqual(gate.select_state(circuit(), metrics(), {}, [row], set())[1], "retain_best")
        row = certified(cells=50); row["status"] = "failed"
        self.assertEqual(gate.select_state(circuit(), metrics(), {}, [row], set())[1], "retain_best")

    def test_equal_geometry_new_routes_can_explore_only_once(self):
        base = circuit(); rerouted = copy.deepcopy(base)
        rerouted["routes"][0]["path"] = [[0, 0], [0, 3], [4, 3]]
        expanded = {gate.state_key(base)}
        row = certified(rerouted)
        self.assertEqual(gate.select_state(base, metrics(), {}, [row], expanded)[1], "certified_exploration")
        expanded.add(gate.state_key(rerouted))
        self.assertEqual(gate.select_state(base, metrics(), {}, [row], expanded)[1], "retain_best")


if __name__ == "__main__":
    unittest.main()
