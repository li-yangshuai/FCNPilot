"""Spatial-density/proposal unit tests; no native/model evaluation is invoked."""
import copy
import json
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "scripts"))
from ifcn_spatial_density import density_context, spatial_proposals
from ifcn_axis_compaction import placement_metrics
import ifcn_density_search as density_search


def circuit(points, edges, inputs=(0,), outputs=None, routes=None):
    outputs = (len(points) - 1,) if outputs is None else outputs
    return {"nodes": [{"id": node, "name": str(node), "x": x, "y": y,
                       "type": "input" if node in inputs else "buffer",
                       "is_input": node in inputs, "is_output": node in outputs}
                      for node, (x, y) in enumerate(points)],
            "edges": [list(edge) for edge in edges], "routes": routes or [],
            "layers": [[999]], "cells": [{"x": 4095, "y": 4095, "phase": 1}]}


def local_case():
    return circuit([(0, 0), (6, 4), (7, 6), (8, 4), (9, 6), (12, 12)],
                   [(0, 1), (1, 2), (2, 5), (0, 3), (3, 4), (4, 5)])


def apply(original, proposal):
    trial = copy.deepcopy(original)
    destinations = {move["node"]: move["to"] for move in proposal["operations"]}
    for node in trial["nodes"]:
        if node["id"] in destinations:
            node["x"], node["y"] = destinations[node["id"]]
    return trial


def inside(point, box):
    return box["min_x"] <= point[0] <= box["max_x"] and box["min_y"] <= point[1] <= box["max_y"]


class SpatialDensityTests(unittest.TestCase):
    def test_density_separates_true_gate_and_recorded_wire_sites(self):
        original = circuit([(0, 0), (6, 0), (12, 0)], [(0, 1), (1, 2)],
                           routes=[{"source": 0, "target": 1, "path": [[0, 0], [6, 0]]},
                                   {"source": 1, "target": 2, "path": [[6, 0], [12, 0]]}])
        context = density_context(original)
        gates = {(0, 0), (6, 0), (12, 0)}
        wires = {(x, 0) for x in range(13)} - gates
        self.assertTrue(context["proxy_only"])
        for region in context["regions"]:
            ga = sum(inside(point, region["bounds"]) for point in gates)
            wi = sum(inside(point, region["bounds"]) for point in wires)
            self.assertEqual(region["gate_count"], ga)
            self.assertEqual(region["old_wire_count"], wi)
            self.assertAlmostEqual(region["gate_density"], ga / region["area_tiles"])
            self.assertAlmostEqual(region["old_wire_density"], wi / region["area_tiles"])
            self.assertAlmostEqual(region["empty_fraction"], 1 - (ga + wi) / region["area_tiles"])
            self.assertEqual(sum(tile["gate_count"] for tile in region["density_grid"]), ga)
            self.assertEqual(sum(tile["old_wire_count"] for tile in region["density_grid"]), wi)
            self.assertTrue(any(band["axis"] == "x" for band in region["empty_bands"]["gate_only"]))
        compact, broad = context["regions"][0], context["regions"][-1]
        self.assertGreater(compact["combined_density"], broad["combined_density"])
        # Fake device-cell summaries are not a substitute for routed XY geometry.
        original["cells"] = []
        self.assertEqual(density_context(original), context)

    def test_regions_are_bounded_and_spatial_not_logical(self):
        original = local_case()
        context = density_context(original)
        self.assertLessEqual(len(context["regions"]), 24)
        self.assertEqual(len({item["region_id"] for item in context["regions"]}), len(context["regions"]))
        for region in context["regions"]:
            self.assertLessEqual(len(region["movable_internal_ids"]), 8)
            self.assertLessEqual(region["area_tiles"], 625)
            self.assertTrue(all(node in (1, 2, 3, 4) for node in region["movable_internal_ids"]))
        self.assertTrue(any(len({node["dag_depth"] for node in region["nodes_in_window"] if node["movable"]}) > 1
                            for region in context["regions"]))

    def test_cross_depth_disconnected_nodes_can_move_together(self):
        original = local_case()
        region = next(item for item in density_context(original)["regions"] if len(item["movable_internal_ids"]) == 4)
        proposals = spatial_proposals(original, [region["region_id"]], limit=512)
        matched = [p for p in proposals if p["features"]["operator_family"] == "spatial_site_permutation"
                   and p["features"]["moved_internal_ids"] == [2, 3]]
        self.assertTrue(matched)
        self.assertEqual(matched[0]["features"]["dag_depths"], [1, 2])
        self.assertNotIn([2, 3], original["edges"])
        self.assertNotIn([3, 2], original["edges"])

    def test_partial_layer_single_moves_and_one_to_four_tile_offsets(self):
        original = local_case()
        region = next(item for item in density_context(original)["regions"]
                      if len(item["movable_internal_ids"]) == 4 and item["area_tiles"] >= 150)
        proposals = spatial_proposals(original, [region["region_id"]], limit=512, max_operations=1)
        singles = [p for p in proposals if p["operations"][0]["node"] == 1]
        self.assertTrue(singles)
        for proposal in singles:
            trial = apply(original, proposal)
            self.assertEqual(trial["nodes"][3], original["nodes"][3])  # Other gate at the same DAG depth remains fixed.
        shifts = {abs(move["dx"]) + abs(move["dy"]) for p in singles
                  if p["features"]["operator_family"] == "single_vacancy" for move in p["features"]["displacements"]}
        self.assertTrue({1, 2, 3, 4}.issubset(shifts))

    def test_ports_exterior_identity_and_final_occupancy(self):
        original = local_case()
        regions = {region["region_id"]: region for region in density_context(original)["regions"]}
        proposals = spatial_proposals(original)
        self.assertTrue(proposals)
        for proposal in proposals:
            region = regions[proposal["features"]["region_id"]]
            moves = proposal["operations"]
            self.assertEqual(proposal["schema"], "ifcn.layout_edit.v1")
            self.assertEqual(len({move["node"] for move in moves}), len(moves))
            self.assertTrue(all(move["node"] in region["movable_internal_ids"] and move["op"] == "move" for move in moves))
            self.assertTrue(all(inside(move["to"], region["bounds"]) for move in moves))
            trial = apply(original, proposal)
            self.assertEqual(trial["edges"], original["edges"])
            self.assertEqual(len({(node["x"], node["y"]) for node in trial["nodes"]}), len(trial["nodes"]))
            for node in region["fixed_node_ids"]:
                self.assertEqual(trial["nodes"][node], original["nodes"][node])
            vectors = {(item["dx"], item["dy"]) for item in proposal["features"]["displacements"]}
            if len(moves) > 1:
                self.assertGreater(len(vectors), 1)

    def test_proxy_values_exact_and_no_greedy_improvement_filter(self):
        original = local_case()
        proposals = spatial_proposals(original, limit=512)
        before = placement_metrics(original)
        self.assertTrue(any(p["features"]["edge_manhattan"]["delta"] > 0 for p in proposals))
        self.assertTrue(any(p["features"]["node_bbox"]["before"] == p["features"]["node_bbox"]["after"] for p in proposals))
        for proposal in proposals:
            after = placement_metrics(apply(original, proposal))
            values = proposal["features"]["edge_manhattan"]
            self.assertEqual(values["before"], before["manhattan_edges"])
            self.assertEqual(values["after"], after["manhattan_edges"])
            self.assertEqual(values["delta"], after["manhattan_edges"] - before["manhattan_edges"])
            self.assertTrue(proposal["features"]["proxy_only"])
            self.assertTrue(proposal["features"]["requires_reroute_and_certification"])

    def test_record_order_stability_and_no_input_mutation(self):
        original = json.loads((ENGINE / "tests/fixtures/combinational_rephase/xor2.json").read_text())
        snapshot = copy.deepcopy(original)
        expected_context, expected_proposals = density_context(original), spatial_proposals(original)
        changed = copy.deepcopy(original)
        for field in ("nodes", "edges", "routes"):
            random.Random(11).shuffle(changed[field])
        changed["layers"] = [[999]]
        self.assertEqual(density_context(changed), expected_context)
        self.assertEqual(spatial_proposals(changed), expected_proposals)
        self.assertEqual(original, snapshot)
        self.assertEqual(spatial_proposals(original), expected_proposals)

    def test_region_selection_strict_validation_and_empty_selection(self):
        original = local_case()
        region_id = density_context(original)["regions"][0]["region_id"]
        proposals = spatial_proposals(original, [region_id])
        self.assertTrue(proposals)
        self.assertTrue(all(p["features"]["region_id"] == region_id for p in proposals))
        self.assertEqual(spatial_proposals(original, []), [])
        for invalid in (["absent"], [region_id, region_id], region_id, 1, [True]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                spatial_proposals(original, invalid)

    def test_result_limit_deduplication_and_diversity(self):
        original = local_case()
        for limit, budget in ((1, 1), (17, 2), (128, 8)):
            proposals = spatial_proposals(original, limit=limit, max_operations=budget)
            self.assertLessEqual(len(proposals), limit)
            self.assertTrue(all(1 <= len(p["operations"]) <= budget for p in proposals))
            states = [tuple((move["node"], *move["to"]) for move in p["operations"]) for p in proposals]
            self.assertEqual(len(states), len(set(states)))
        proposals = spatial_proposals(original, limit=64)
        self.assertGreater(len({p["features"]["region_id"] for p in proposals}), 1)
        self.assertTrue(any(p["features"]["coordinated"] for p in proposals))
        self.assertTrue(any(not p["features"]["coordinated"] for p in proposals))

    def test_coordinate_limits_and_failures(self):
        original = circuit([(4090, 4090), (4094, 4094), (4095, 4095)], [(0, 1), (1, 2)])
        context = density_context(original)
        bounds = context["coordinate_bounds"]
        for proposal in spatial_proposals(original):
            self.assertTrue(all(inside(move["to"], bounds) and all(0 <= value <= 4095 for value in move["to"])
                                for move in proposal["operations"]))
        for field in ("limit", "max_operations"):
            for value in (0, -1, True, 1.1, None, "3", 513):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    spatial_proposals(local_case(), **{field: value})
        with self.assertRaises(ValueError):
            spatial_proposals(local_case(), max_operations=9)
        malformed = local_case(); del malformed["nodes"][1]["is_output"]
        with self.assertRaises(ValueError):
            density_context(malformed)
        malformed = local_case(); malformed["nodes"][1]["x"] = True
        with self.assertRaises(ValueError):
            spatial_proposals(malformed)
        malformed = local_case(); malformed["edges"].append([5, 0])
        with self.assertRaises(ValueError):
            density_context(malformed)

    def test_wide_real_gate_gap_supports_clipped_five_tile_moves(self):
        original = circuit([(0, 0), (6, 6), (18, 8), (24, 14)], [(0, 1), (1, 2), (2, 3)])
        regions = [region for region in density_context(original)["regions"]
                   if region["movable_internal_ids"] == [1, 2]]
        self.assertTrue(regions)
        proposals = spatial_proposals(original, [regions[0]["region_id"]], limit=512)
        gap_moves = [p for p in proposals if p["features"]["operator_family"] == "spatial_gap_bridge"]
        self.assertTrue(any({item["dx"] for item in p["features"]["displacements"]} == {-5, 5} for p in gap_moves))

    def test_no_internal_and_no_subprocess(self):
        original = circuit([(0, 0), (1, 1)], [(0, 1)])
        self.assertEqual(density_context(original)["regions"], [])
        self.assertEqual(spatial_proposals(original), [])
        with patch("subprocess.run", side_effect=AssertionError("No subprocess")), \
                patch("subprocess.Popen", side_effect=AssertionError("No subprocess")):
            self.assertTrue(spatial_proposals(local_case()))


class DensityFeedbackTests(unittest.TestCase):
    def context(self, history, round_number=2):
        graph = json.loads((ENGINE / "tests/fixtures/combinational_rephase/xor2.json").read_text())
        metrics = {"area_tiles": 100, "qca_cells": 200, "edge_steps": 40}
        return density_search.context_for(graph, metrics, {}, history, density_context(graph), [],
                                          round_number, 4, metrics)

    def completed_round(self, number=1):
        before = {"area_tiles": 100, "qca_cells": 200, "edge_steps": 40}
        after = {"area_tiles": 100, "qca_cells": 184, "edge_steps": 37}
        proposal = {"operations": [{"op": "move", "node": 2, "to": [3, 4]}],
                    "routing_order": [[0, 2], [2, 3]], "rationale": "Close the internal gap."}
        return {"round": number, "status": "improved_retained", "seed_id": "selected-seed",
                "selection": {"source": "llm_text_spatial_seed", "candidate_id": "selected-seed"},
                "start_metrics": before, "retained_metrics": after,
                "accepted_candidate_id": "accepted-neighbor", "accepted_origin": "explicit_alternate_order",
                "candidates": [
                    {"candidate_id": "selected-seed", "seed_id": "selected-seed", "origin": "exact_selected_seed",
                     "proposal": proposal, "result": {"status": "failed", "error": "Clock arrival mismatch",
                         "unrouted_edges": [[2, 3]], "routing_audit": {"route_order_attempts": 1, "fallback_used": False},
                         "phase_repair": {"status": "unsat", "reason": "Fanins cannot align"},
                         "clock_diagnostics": {"passed": False, "error": "Reconvergent input epochs differ"}}},
                    {"candidate_id": "accepted-neighbor", "seed_id": "selected-seed", "origin": "explicit_alternate_order",
                     "proposal": proposal, "result": {"status": "certified", "metrics": after,
                         "certificates": {"logic": "equivalent", "clock": True, "physical": True, "interface": True}}}]}

    def test_model_context_contains_executed_failures_and_accepted_measured_gain(self):
        history = [self.completed_round()]
        original = copy.deepcopy(history)
        context = self.context(history)
        row = context["feedback"][0]
        self.assertEqual(row["seed_id"], "selected-seed")
        self.assertEqual(row["accepted_candidate_id"], "accepted-neighbor")
        self.assertEqual(row["accepted_origin"], "explicit_alternate_order")
        self.assertEqual(row["retained_metrics"]["qca_cells"], 184)
        self.assertEqual(row["retained_delta_from_start"]["qca_cells"], -16)
        failed, accepted = row["candidates"]
        self.assertFalse(failed["accepted"])
        self.assertEqual(failed["error"], "Clock arrival mismatch")
        self.assertEqual(failed["unrouted_edges"], [[2, 3]])
        self.assertEqual(failed["phase_repair"]["status"], "unsat")
        self.assertEqual(failed["clock_diagnostics"]["error"], "Reconvergent input epochs differ")
        self.assertEqual(failed["routing_audit"]["route_order_attempts"], 1)
        self.assertTrue(accepted["accepted"])
        self.assertEqual(accepted["metric_delta_from_start"]["qca_cells"], -16)
        self.assertEqual(accepted["metric_delta_from_start"]["area_tiles"], 0)
        self.assertEqual(accepted["proposal"]["operations"], [{"op": "move", "node": 2, "to": [3, 4]}])
        self.assertEqual(accepted["proposal"]["routing_order"]["edge_count"], 2)
        self.assertEqual(accepted["certificates"]["logic"], "equivalent")
        self.assertEqual(history, original)
        row["candidates"][0]["proposal"]["operations"][0]["to"][0] = 999
        self.assertEqual(history, original)

    def test_current_future_and_unevaluated_candidates_are_not_model_feedback(self):
        past = self.completed_round()
        past["candidates"].append({"candidate_id": "UNSEEN_RESULT", "proposal": {"rationale": "UNSEEN_RESULT"}})
        past["future_outcomes"] = "UNSEEN_RESULT"
        pending = self.completed_round(0); pending["status"] = "running"; pending["seed_id"] = "UNSEEN_RESULT"
        current = self.completed_round(2); current["seed_id"] = "UNSEEN_RESULT"
        future = self.completed_round(3); future["seed_id"] = "UNSEEN_RESULT"
        context = self.context([pending, past, current, future], round_number=2)
        self.assertEqual([row["round"] for row in context["feedback"]], [1])
        self.assertEqual(len(context["feedback"][0]["candidates"]), 2)
        self.assertNotIn("UNSEEN_RESULT", json.dumps(context))

    def test_feedback_caps_recent_rounds_candidates_actions_and_diagnostics(self):
        history = [self.completed_round(number) for number in range(1, 10)]
        for row in history:
            row["candidates"] = [copy.deepcopy(trial) for _ in range(12) for trial in row["candidates"]]
            for trial in row["candidates"]:
                trial["proposal"]["operations"] *= 12
                trial["proposal"]["routing_order"] *= 12
                trial["proposal"]["rationale"] = "r" * 10000
                trial["result"]["error"] = "e" * 10000
                trial["result"]["unrouted_edges"] = [[1, 2]] * 1000
        context = self.context(history, round_number=10)
        self.assertEqual([row["round"] for row in context["feedback"]], [6, 7, 8, 9])
        for row in context["feedback"]:
            self.assertEqual(len(row["candidates"]), 6)
            for trial in row["candidates"]:
                self.assertLessEqual(len(trial["proposal"]["operations"]), 8)
                self.assertLessEqual(len(trial["proposal"]["routing_order"]["first_edges"]), 8)
                self.assertLessEqual(len(trial["error"]), 600)
                self.assertLessEqual(len(trial["unrouted_edges"]), 8)
        self.assertLess(len(json.dumps(context["feedback"])), 60000)

    def test_legacy_flat_history_and_strict_pareto_contract(self):
        legacy = {"round": 1, "status": "accepted", "start_metrics": {"area_tiles": 100, "qca_cells": 200},
                  "metrics": {"area_tiles": 99, "qca_cells": 198},
                  "proposal": {"operations": [{"op": "swap", "nodes": [2, 3]}],
                               "routing_order": None, "rationale": "Legacy accepted edit"}}
        context = self.context([legacy])
        row = context["feedback"][0]
        self.assertEqual(row["retained_delta_from_start"], {"area_tiles": -1, "qca_cells": -2})
        self.assertTrue(row["candidates"][0]["accepted"])
        self.assertEqual(row["candidates"][0]["proposal"]["operations"], [{"op": "swap", "nodes": [2, 3]}])
        contract = context["rules"]["search_contract"]
        self.assertIn("strict Pareto", contract)
        self.assertIn("no regressing exploration state", contract)
        self.assertNotIn("10%", contract)
        self.assertNotIn("temporarily increase", contract)


if __name__ == "__main__":
    unittest.main()
