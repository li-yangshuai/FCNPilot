"""Offline geometry/proposal properties; these tests do not establish routed DRC."""
from __future__ import annotations

import copy
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ifcn_axis_compaction import cut_proposals, placement_metrics, routed_extent


def candidate(points, edges=None, routes=None):
    return {"schema": "ifcn.native_candidate.v1", "algorithm": "compact", "clock_scheme": "irregular",
            "nodes": [{"id": index, "name": f"n{index}", "type": "input" if index == 0 else "buffer",
                       "is_input": index == 0, "is_output": index == len(points) - 1,
                       "x": x, "y": y} for index, (x, y) in enumerate(points)],
            "edges": edges if edges is not None else [[index, index + 1] for index in range(len(points) - 1)],
            "routes": routes or [], "cells": [{"x": 4095, "y": 4095, "phase": 1}]}


def apply(graph, proposal):
    result = copy.deepcopy(graph)
    moves = {operation["node"]: operation["to"] for operation in proposal["operations"]}
    for node in result["nodes"]:
        if node["id"] in moves:
            node["x"], node["y"] = moves[node["id"]]
    return result


def key(proposal):
    return tuple((operation["node"], *operation["to"]) for operation in proposal["operations"])


def transpose(graph):
    result = copy.deepcopy(graph)
    for node in result["nodes"]:
        node["x"], node["y"] = node["y"], node["x"]
    for route in result["routes"]:
        route["path"] = [[y, x] for x, y in route["path"]]
    return result


class AxisCompactionTests(unittest.TestCase):
    def test_placement_and_actual_route_extent_are_distinct(self):
        graph = candidate([(2, 3), (7, 4)], routes=[{"source": 0, "target": 1, "path": [[2, 3], [1, 3], [1, 9], [10, 9], [10, 4], [7, 4]]}])
        gate = placement_metrics(graph)
        self.assertEqual((gate["width"], gate["height"], gate["area_tiles"], gate["manhattan_edges"]), (6, 2, 12, 6))
        actual = routed_extent(graph)
        self.assertEqual((actual["min_x"], actual["max_x"], actual["min_y"], actual["max_y"]), (1, 10, 3, 9))
        self.assertEqual(actual["area_tiles"], 70)
        self.assertEqual(actual["route_bbox"]["area_tiles"], 70)
        # An unrelated cell extent or cached metric must not replace actual paths.
        graph["area_tiles"] = 99999
        self.assertEqual(placement_metrics(graph), gate)
        self.assertEqual(routed_extent(graph), actual)

    def test_route_bbox_and_union_bbox_include_isolated_gate(self):
        graph = candidate([(0, 0), (4, 0), (8, 6)], edges=[[0, 1]], routes=[{"source": 0, "target": 1, "path": [[0, 0], [1, 0], [4, 0]]}])
        extent = routed_extent(graph)
        self.assertEqual(extent["route_bbox"]["area_tiles"], 5)
        self.assertEqual(extent["area_tiles"], 63)
        graph["routes"] = []
        self.assertIsNone(routed_extent(graph)["route_bbox"])

    def test_exact_prefix_and_suffix_cut_preserves_one_level_separation(self):
        graph = candidate([(2, 5), (6, 5)])
        proposals = cut_proposals(graph, axes=("x",), max_shift=100)
        self.assertEqual(len(proposals), 6)
        self.assertEqual({key(p) for p in proposals}, {((node, x, 5),) for node, values in [(0, [3, 4, 5]), (1, [3, 4, 5])] for x in values})
        self.assertEqual([placement_metrics(apply(graph, p))["area_tiles"] for p in proposals], [2, 2, 3, 3, 4, 4])
        self.assertTrue(all(abs(apply(graph, p)["nodes"][0]["x"] - apply(graph, p)["nodes"][1]["x"]) >= 1 for p in proposals))

    def test_eight_move_research_budget_is_separate_from_three(self):
        graph = candidate([(x, y) for x in (0, 5) for y in range(8)])
        self.assertEqual(cut_proposals(graph, axes=("x",), max_operations=3), [])
        eight = cut_proposals(graph, axes=("x",), max_operations=8)
        self.assertEqual(len(eight), 4)
        self.assertTrue(all(len(p["operations"]) == 8 for p in eight))
        for proposal in eight:
            movement = {(operation["to"][0] - graph["nodes"][operation["node"]]["x"], operation["to"][1] - graph["nodes"][operation["node"]]["y"]) for operation in proposal["operations"]}
            self.assertEqual(len(movement), 1)
            self.assertEqual(next(iter(movement))[1], 0)
        nine_per_side = candidate([(x, y) for x in (0, 5) for y in range(9)])
        self.assertEqual(cut_proposals(nine_per_side, axes=("x",), max_operations=8), [])

    def test_transposition_maps_x_and_y_proposal_sets(self):
        graph = candidate([(1, 2), (4, 2), (4, 6), (8, 9)], edges=[[0, 1], [1, 2], [1, 3]])
        for axes, other in [(("x",), ("y",)), (("y",), ("x",)), (("x", "y"), ("x", "y"))]:
            expected = {tuple((node, y, x) for node, x, y in key(p)) for p in cut_proposals(graph, axes=axes)}
            observed = {key(p) for p in cut_proposals(transpose(graph), axes=other)}
            self.assertEqual(expected, observed)
        before, after = placement_metrics(graph), placement_metrics(transpose(graph))
        self.assertEqual((before["width"], before["height"]), (after["height"], after["width"]))
        self.assertEqual(before["area_tiles"], after["area_tiles"])
        self.assertEqual(before["manhattan_edges"], after["manhattan_edges"])

    def test_deterministic_order_and_duplicate_axes(self):
        graph = candidate([(1, 2), (4, 2), (4, 6), (8, 9)], edges=[[0, 1], [1, 2], [1, 3]])
        proposals = cut_proposals(graph)
        shuffled = copy.deepcopy(graph)
        random.Random(4).shuffle(shuffled["nodes"])
        random.Random(9).shuffle(shuffled["edges"])
        self.assertEqual(proposals, cut_proposals(shuffled, axes=("y", "x", "y", "x")))
        scores = []
        for proposal in proposals:
            size = placement_metrics(apply(graph, proposal))
            scores.append((size["area_tiles"], size["manhattan_edges"], len(proposal["operations"]), key(proposal)))
        self.assertEqual(scores, sorted(scores))
        self.assertEqual(len({key(p) for p in proposals}), len(proposals))

    def test_input_identity_roles_topology_routes_and_phase_are_unchanged(self):
        graph = candidate([(0, 0), (4, 0), (4, 4)])
        graph["layers"] = [[0], [1], [2]]
        graph["routes"] = [{"source": 0, "target": 1, "path": [[0, 0], [1, 0], [4, 0]]}]
        original = copy.deepcopy(graph)
        proposals = cut_proposals(graph)
        self.assertTrue(proposals)
        for proposal in proposals:
            self.assertEqual(set(proposal), {"schema", "operations", "rationale"})
            self.assertEqual(proposal["schema"], "ifcn.layout_edit.v1")
            self.assertIn("DRC have not been evaluated", proposal["rationale"])
            self.assertEqual([op["node"] for op in proposal["operations"]], sorted(op["node"] for op in proposal["operations"]))
            changed_axes = set()
            for operation in proposal["operations"]:
                self.assertEqual(set(operation), {"op", "node", "to"})
                self.assertEqual(operation["op"], "move")
                node = original["nodes"][operation["node"]]
                differences = [axis for axis, coordinate in enumerate((node["x"], node["y"])) if operation["to"][axis] != coordinate]
                self.assertEqual(len(differences), 1)
                changed_axes.update(differences)
            self.assertEqual(len(changed_axes), 1)
        self.assertEqual(graph, original)
        proposals[0]["operations"][0]["to"][0] = 123
        self.assertEqual(graph, original)
        self.assertNotEqual(proposals, cut_proposals(graph))

    def test_all_generated_positions_are_unique_in_bounds_and_area_reducing(self):
        for offset in (0, 4086):
            graph = candidate([(offset + x, offset + y) for x, y in [(0, 0), (0, 4), (4, 4), (9, 9)]])
            baseline = placement_metrics(graph)
            extent = routed_extent(graph)
            proposals = cut_proposals(graph, max_shift=20)
            self.assertTrue(proposals)
            states = set()
            for proposal in proposals:
                trial = apply(graph, proposal)
                positions = [(n["x"], n["y"]) for n in trial["nodes"]]
                self.assertEqual(len(positions), len(set(positions)))
                self.assertNotIn(tuple(positions), states); states.add(tuple(positions))
                self.assertLess(placement_metrics(trial)["area_tiles"], baseline["area_tiles"])
                for x, y in positions:
                    self.assertTrue(max(0, extent["min_x"] - 2) <= x <= min(4095, extent["max_x"] + 2))
                    self.assertTrue(max(0, extent["min_y"] - 2) <= y <= min(4095, extent["max_y"] + 2))

    def test_no_empty_gap_or_single_node_has_no_proposal(self):
        self.assertEqual(cut_proposals(candidate([(0, 0), (1, 0), (1, 1)])), [])
        self.assertEqual(cut_proposals(candidate([(4, 4)])), [])
        self.assertEqual(cut_proposals(candidate([(0, 0), (4, 0)]), axes=()), [])

    def test_malformed_or_colliding_input_is_not_a_valid_proposal_source(self):
        cases = []
        duplicate_id = candidate([(0, 0), (4, 0)]); duplicate_id["nodes"][1]["id"] = 0; cases.append(duplicate_id)
        cases.append(candidate([(0, 0), (0, 0)]))
        cases.append(candidate([(-1, 0), (4, 0)]))
        cases.append(candidate([(0, 0), (4096, 0)]))
        noninteger = candidate([(0, 0), (4, 0)]); noninteger["nodes"][0]["x"] = True; cases.append(noninteger)
        cases.append(candidate([(0, 0)], edges=[[0, 3]]))
        cases.append(candidate([(0, 0), (4, 0)], edges=[[0, 1], [0, 1]]))
        for graph in cases:
            with self.subTest(graph=graph):
                with self.assertRaises(ValueError): cut_proposals(graph)

    def test_bad_routes_and_parameters_fail_explicitly(self):
        graph = candidate([(0, 0), (4, 0)])
        for kwargs in ({"max_operations": 0}, {"max_operations": 9}, {"max_operations": True}, {"max_shift": 0}, {"max_shift": 1.5}, {"axes": ("z",)}, {"axes": None}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError): cut_proposals(graph, **kwargs)
        for path in ([], [[0, 0, 1]], [[0, False]], [[0, 5000]]):
            malformed = copy.deepcopy(graph); malformed["routes"] = [{"path": path}]
            with self.assertRaises(ValueError): routed_extent(malformed)


if __name__ == "__main__":
    unittest.main()
