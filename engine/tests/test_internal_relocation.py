"""Geometry-only regressions: no native, model or candidate evaluation runs."""
import copy
import json
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "scripts"))
from ifcn_internal_relocation import internal_proposals
from ifcn_axis_compaction import placement_metrics, routed_extent


def circuit(points, edges, inputs=(0,), outputs=None, routes=None):
    outputs = (len(points) - 1,) if outputs is None else outputs
    return {"schema": "ifcn.native_candidate.v1", "algorithm": "june_random",
            "nodes": [{"id": node, "name": f"n{node}",
                       "type": "input" if node in inputs else "buffer",
                       "is_input": node in inputs, "is_output": node in outputs,
                       "x": point[0], "y": point[1]} for node, point in enumerate(points)],
            "edges": [list(edge) for edge in edges], "routes": routes or [],
            "cells": [{"x": 4095, "y": 4095, "phase": 1}]}


def fixed_box():
    return circuit([(0, 0), (2, 9), (10, 3), (12, 12)], [(0, 1), (1, 2), (2, 3)])


def layer_case():
    return circuit([(0, 0), (2, 3), (7, 3), (2, 8), (7, 8)],
                   [(0, 1), (0, 2), (1, 3), (2, 4)], outputs=(3, 4))


def applied(candidate, proposal):
    result = copy.deepcopy(candidate)
    positions = {operation["node"]: operation["to"] for operation in proposal["operations"]}
    for node in result["nodes"]:
        if node["id"] in positions:
            node["x"], node["y"] = positions[node["id"]]
    return result


class InternalRelocationTests(unittest.TestCase):
    def test_every_proposal_preserves_ports_identity_and_final_occupancy(self):
        original = fixed_box()
        internal = {1, 2}
        proposals = internal_proposals(original)
        self.assertTrue(proposals)
        for proposal in proposals:
            self.assertEqual(proposal["schema"], "ifcn.layout_edit.v1")
            moves = proposal["operations"]
            self.assertTrue(1 <= len(moves) <= 8)
            self.assertEqual(len({move["node"] for move in moves}), len(moves))
            self.assertTrue(all(move["op"] == "move" and move["node"] in internal for move in moves))
            trial = applied(original, proposal)
            self.assertEqual(trial["edges"], original["edges"])
            self.assertEqual(len({(node["x"], node["y"]) for node in trial["nodes"]}), len(trial["nodes"]))
            for before, after in zip(original["nodes"], trial["nodes"]):
                self.assertEqual({key: value for key, value in before.items() if key not in ("x", "y")},
                                 {key: value for key, value in after.items() if key not in ("x", "y")})
                if before["is_input"] or before["is_output"]:
                    self.assertEqual(before, after)

    def test_fixed_full_bbox_internal_length_improvement(self):
        original = fixed_box()
        proposals = internal_proposals(original)
        improvements = [proposal for proposal in proposals
                        if len(proposal["operations"]) >= 2
                        and proposal["features"]["edge_manhattan"]["delta"] < 0
                        and proposal["features"]["node_bbox"]["before"] == proposal["features"]["node_bbox"]["after"]]
        self.assertTrue(improvements)
        for proposal in improvements:
            before = placement_metrics(original)
            after = placement_metrics(applied(original, proposal))
            self.assertEqual(before["area_tiles"], after["area_tiles"])
            self.assertLess(after["manhattan_edges"], before["manhattan_edges"])
        self.assertTrue(any(proposal["features"]["operator_family"] == "connected_contraction" for proposal in improvements))

    def test_atomic_same_layer_swap_is_kept_even_when_proxy_worsens(self):
        original = layer_case()
        swaps = [proposal for proposal in internal_proposals(original)
                 if proposal["features"]["operator_family"] == "layer_permutation"]
        self.assertTrue(swaps)
        swap = swaps[0]
        self.assertEqual(swap["operations"], [{"op": "move", "node": 1, "to": [7, 3]},
                                              {"op": "move", "node": 2, "to": [2, 3]}])
        self.assertGreater(swap["features"]["edge_manhattan"]["delta"], 0)
        self.assertEqual(swap["features"]["node_bbox"]["before"], swap["features"]["node_bbox"]["after"])
        self.assertEqual(swap["features"]["internal_extent"]["before"], swap["features"]["internal_extent"]["after"])
        self.assertEqual({item["depth"] for item in swap["features"]["dag_depths"]}, {1})

    def test_connected_group_can_coordinate_more_than_two_nodes(self):
        original = circuit([(0, 0), (3, 3), (6, 6), (9, 9), (12, 12), (15, 15)],
                           [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)])
        proposals = internal_proposals(original, limit=256)
        self.assertTrue(any(len(proposal["operations"]) >= 3 and proposal["features"]["coordinated"]
                            for proposal in proposals))
        self.assertTrue(any("2-tile level spacing" in proposal["rationale"] for proposal in proposals))

    def test_route_detour_hints_are_actual_geometry(self):
        original = circuit([(0, 0), (3, 2), (3, 6), (6, 8)], [(0, 1), (1, 2), (2, 3)],
                           routes=[{"source": 1, "target": 2, "path": [[3, 2], [6, 2], [6, 6], [3, 6]]}])
        proposals = internal_proposals(original)
        detours = [proposal for proposal in proposals if proposal["features"]["operator_family"] == "route_detour"]
        self.assertTrue(detours)
        for proposal in detours:
            self.assertIn({"edge": [1, 2], "length": 10, "manhattan": 4, "detour": 6},
                          proposal["features"]["recorded_route_hints"])
        # Existing wires are not treated as fixed gate occupancy: they must be rerouted.
        self.assertTrue(any(move["to"] == [5, 2] for proposal in detours for move in proposal["operations"]))

    def test_features_match_recomputed_geometry(self):
        original = fixed_box()
        for proposal in internal_proposals(original):
            feature = proposal["features"]
            before, after = placement_metrics(original), placement_metrics(applied(original, proposal))
            self.assertTrue(feature["proxy_only"])
            self.assertTrue(feature["requires_reroute_and_certification"])
            self.assertTrue(feature["port_coordinates_fixed"])
            self.assertEqual(feature["edge_manhattan"]["before"], before["manhattan_edges"])
            self.assertEqual(feature["edge_manhattan"]["after"], after["manhattan_edges"])
            self.assertEqual(feature["edge_manhattan"]["delta"], after["manhattan_edges"] - before["manhattan_edges"])
            self.assertEqual(feature["node_bbox"]["after"]["area_tiles"], after["area_tiles"])
            self.assertEqual(feature["moved_internal_ids"], [move["node"] for move in proposal["operations"]])

    def test_result_budget_duplicates_and_family_diversity(self):
        original = fixed_box()
        for budget in (1, 2, 3, 8):
            for limit in (1, 5, 64, 256):
                proposals = internal_proposals(original, max_operations=budget, limit=limit)
                self.assertLessEqual(len(proposals), limit)
                states = [tuple((move["node"], *move["to"]) for move in proposal["operations"]) for proposal in proposals]
                self.assertEqual(len(states), len(set(states)))
                self.assertTrue(all(len(proposal["operations"]) <= budget for proposal in proposals))
                if budget == 1:
                    self.assertTrue(all(not proposal["features"]["coordinated"] for proposal in proposals))
        families = {proposal["features"]["operator_family"] for proposal in internal_proposals(original, limit=7)}
        self.assertTrue("connected_contraction" in families and "neighbor_median" in families and "local_vacancy" in families)

    def test_reproducible_under_record_permutation_and_stale_layers(self):
        original = json.loads((ENGINE / "tests/fixtures/combinational_rephase/xor2.json").read_text())
        expected = internal_proposals(original)
        changed = copy.deepcopy(original)
        random.Random(15).shuffle(changed["nodes"])
        random.Random(26).shuffle(changed["edges"])
        random.Random(37).shuffle(changed["routes"])
        changed["layers"] = [[9999]]
        changed["cells"] = []
        self.assertEqual(internal_proposals(changed), expected)
        self.assertEqual(internal_proposals(original), expected)

    def test_input_and_results_do_not_alias(self):
        original = fixed_box()
        snapshot = copy.deepcopy(original)
        proposals = internal_proposals(original)
        self.assertEqual(original, snapshot)
        expected = copy.deepcopy(proposals[1:])
        proposals[0]["operations"][0]["to"][0] = 999
        proposals[0]["features"]["internal_node_ids"].clear()
        proposals[0]["features"]["node_bbox"]["before"]["area_tiles"] = -1
        proposals[0]["features"]["coordinate_bounds"]["max_x"] = 999
        self.assertEqual(proposals[1:], expected)
        self.assertEqual(original, snapshot)

    def test_bounds_use_routes_and_clamp_native_coordinate_range(self):
        originals = [fixed_box(), circuit([(4090, 4090), (4094, 4094), (4095, 4095)], [(0, 1), (1, 2)])]
        for original in originals:
            extent = routed_extent(original)
            for proposal in internal_proposals(original):
                for move in proposal["operations"]:
                    x, y = move["to"]
                    self.assertTrue(max(0, extent["min_x"] - 2) <= x <= min(4095, extent["max_x"] + 2))
                    self.assertTrue(max(0, extent["min_y"] - 2) <= y <= min(4095, extent["max_y"] + 2))
        original = circuit([(10, 10), (12, 12), (14, 14)], [(0, 1), (1, 2)],
                           routes=[{"source": 0, "target": 1, "path": [[10, 10], [6, 10], [6, 12], [12, 12]]}])
        self.assertEqual(internal_proposals(original)[0]["features"]["coordinate_bounds"]["min_x"], 4)

    def test_no_internal_gates(self):
        self.assertEqual(internal_proposals(circuit([(0, 0), (1, 1)], [(0, 1)])), [])

    def test_strict_budgets(self):
        for argument in ("max_operations", "limit"):
            for value in (True, False, 0, -1, 1.5, "2", None, 257):
                with self.subTest(argument=argument, value=value), self.assertRaises(ValueError):
                    internal_proposals(fixed_box(), **{argument: value})
        with self.assertRaises(ValueError):
            internal_proposals(fixed_box(), max_operations=9)

    def test_rejects_missing_or_forged_roles(self):
        for role in ("is_input", "is_output"):
            original = fixed_box()
            del original["nodes"][1][role]
            with self.assertRaises(ValueError):
                internal_proposals(original)
            original["nodes"][1][role] = 0
            with self.assertRaises(ValueError):
                internal_proposals(original)
        original = fixed_box()
        original["nodes"][0]["is_input"] = False
        with self.assertRaises(ValueError):
            internal_proposals(original)

    def test_rejects_malformed_graph_and_route_geometry(self):
        broken = []
        original = fixed_box(); original["nodes"][1]["x"] = True; broken.append(original)
        original = fixed_box(); original["nodes"][1]["id"] = 0; broken.append(original)
        original = fixed_box(); original["nodes"][1].update(x=0, y=0); broken.append(original)
        original = fixed_box(); original["edges"].append([1, 2]); broken.append(original)
        original = fixed_box(); original["edges"].append([3, 0]); broken.append(original)
        original = fixed_box(); original["edges"].append([2, 999]); broken.append(original)
        original = fixed_box(); original["routes"] = [{"source": 0, "target": 1, "path": [[0, 0], [2, 9]]}]; broken.append(original)
        original = fixed_box(); original["routes"] = [{"source": 0, "target": 1, "path": [[1, 0], [1, 9], [2, 9]]}]; broken.append(original)
        original = fixed_box(); original["routes"] = [{"source": 0, "target": 3, "path": [[0, 0], [0, 12], [12, 12]]}]; broken.append(original)
        original = fixed_box(); original["routes"] = [{"source": 0, "target": 1, "path": [[0, 0], [0, 9], [2, 9]]}] * 2; broken.append(original)
        for index, original in enumerate(broken):
            with self.subTest(index=index), self.assertRaises(ValueError):
                internal_proposals(original)

    def test_read_only_archived_fixture_and_no_execution(self):
        original = json.loads((ENGINE / "tests/fixtures/combinational_rephase/xor2.json").read_text())
        with patch("subprocess.run", side_effect=AssertionError("No subprocess allowed")), \
                patch("subprocess.Popen", side_effect=AssertionError("No subprocess allowed")):
            proposals = internal_proposals(original)
        self.assertTrue(proposals)
        self.assertTrue(any(len(proposal["operations"]) >= 2 for proposal in proposals))
        self.assertTrue(all(move["node"] in (3, 4, 5) for proposal in proposals for move in proposal["operations"]))


if __name__ == "__main__":
    unittest.main()
