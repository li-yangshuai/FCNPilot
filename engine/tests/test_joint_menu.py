"""Offline action-menu properties; no model/native executions or DRC claims."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "scripts"))
from ifcn_joint_menu import candidate_menu
from ifcn_joint_search import apply_positions, validate_proposal


def fixture():
    return json.loads((ENGINE / "tests/fixtures/combinational_rephase/xor2.json").read_text())


def graph(points):
    return {"schema": "ifcn.native_candidate.v1", "algorithm": "june_random",
            "nodes": [{"id": n, "name": "n" + str(n), "type": "input" if n == 0 else "buffer",
                       "is_input": n == 0, "is_output": n == len(points) - 1, "x": x, "y": y}
                      for n, (x, y) in enumerate(points)],
            "edges": [[n, n + 1] for n in range(len(points) - 1)],
            "layers": [[n] for n in range(len(points))], "routes": [], "cells": []}


def signature(candidate, entry):
    after = apply_positions(candidate, entry["operations"])
    return (tuple(sorted((n["id"], n["x"], n["y"]) for n in after["nodes"])),
            tuple(map(tuple, entry["routing_order"])))


class JointMenuTests(unittest.TestCase):
    def test_unique_stable_ids_and_exact_states_without_mutating_incumbent(self):
        candidate = fixture(); before = copy.deepcopy(candidate)
        first = candidate_menu(candidate)
        second = candidate_menu(candidate)
        self.assertEqual(first, second)
        self.assertEqual(candidate, before)
        self.assertTrue(first)
        self.assertLessEqual(len(first), 48)
        self.assertEqual(len({e["id"] for e in first}), len(first))
        self.assertEqual(len({signature(candidate, e) for e in first}), len(first))
        self.assertTrue(all(e["id"].startswith("menu_") for e in first))
        # Returned mutable containers must not alias the incumbent or each other.
        first[0]["operations"].append({"op": "irrelevant"})
        first[0]["routing_order"][0][0] = 99999
        self.assertEqual(candidate, before)
        self.assertEqual(candidate_menu(candidate), second)

    def test_every_entry_satisfies_independent_joint_contract(self):
        for candidate in [fixture(), graph([(10, 10), (13, 13)]), graph([(10 + 3*n, 20 + 4*n) for n in range(8)])]:
            for entry in candidate_menu(candidate):
                with self.subTest(id=entry["id"]):
                    item = {"schema": "ifcn.layout_search.v2", "operations": entry["operations"],
                            "routing_order": entry["routing_order"], "rationale": entry["description"]}
                    validate_proposal(item, candidate)
                    features = entry["features"]
                    self.assertLessEqual(features["changed_nodes"], 8)
                    self.assertEqual(features["changed_nodes"], len(entry["operations"]))
                    self.assertNotIn("qca_cells", features["placement_proxy"])
                    self.assertNotIn("certified", features)
                    self.assertIn("Unevaluated", features["placement_proxy"]["scope"])

    def test_pure_routing_candidates_exist_and_order_variants_are_deduplicated(self):
        candidate = graph([(10, 10), (13, 13)])
        menu = candidate_menu(candidate)
        pure = [e for e in menu if not e["operations"]]
        # With one edge, all four route policies give exactly the same order.
        self.assertEqual(len(pure), 1)
        self.assertEqual(pure[0]["routing_order"], [[0, 1]])
        self.assertEqual(pure[0]["features"]["route_policy"], "sink_pressure_layer_long")
        self.assertEqual(pure[0]["features"]["changed_nodes"], 0)
        self.assertEqual(pure[0]["features"]["width_change_tiles"], 0)
        self.assertEqual(pure[0]["features"]["height_change_tiles"], 0)

    def test_cap_reserves_pure_routing_and_preserves_disclosed_rank(self):
        candidate = graph([(10 + 3*n, 20 + 4*n) for n in range(8)])
        menu = candidate_menu(candidate)
        self.assertEqual(len(menu), 48)
        self.assertTrue(any(not e["operations"] for e in menu))
        self.assertTrue(any(e["operations"] for e in menu))
        ranks = {p: n for n, p in enumerate(["sink_pressure_layer_long", "topological_layer", "longest_manhattan", "shortest_manhattan"])}
        scores = [(e["features"]["placement_proxy"]["area_tiles"],
                   e["features"]["placement_proxy"]["manhattan_edges"],
                   e["features"]["changed_nodes"], ranks[e["features"]["route_policy"]]) for e in menu]
        self.assertEqual(scores, sorted(scores))
        one = candidate_menu(candidate, limit=1)
        self.assertEqual(len(one), 1)
        self.assertEqual(one[0]["operations"], [])
        self.assertEqual(len(candidate_menu(candidate, limit=7)), 7)

    def test_exclusion_precedes_cap_and_never_reoffers_an_evaluated_id(self):
        candidate = fixture()
        seen = set()
        rounds = 0
        while True:
            menu = candidate_menu(candidate, excluded_ids=seen, limit=7)
            if not menu:
                break
            self.assertFalse(seen.intersection(e["id"] for e in menu))
            seen.update(e["id"] for e in menu)
            rounds += 1
            self.assertLess(rounds, 100)
        self.assertGreater(rounds, 1)
        self.assertEqual(candidate_menu(candidate, excluded_ids=seen), [])
        self.assertEqual(candidate_menu(candidate, excluded_ids=["unknown-id"]), candidate_menu(candidate))

    def test_transposition_preserves_menu_structure_and_swaps_geometry_metrics(self):
        candidate = graph([(10, 20), (13, 25)])
        transposed = copy.deepcopy(candidate)
        for n in transposed["nodes"]:
            n["x"], n["y"] = n["y"], n["x"]
        first = candidate_menu(candidate)
        second = candidate_menu(transposed)
        expected = {(tuple((node, y, x) for node, x, y in signature(candidate, e)[0]), signature(candidate, e)[1]) for e in first}
        actual = {signature(transposed, e) for e in second}
        self.assertEqual(expected, actual)
        by_state = {signature(transposed, e): e for e in second}
        for entry in first:
            state, order = signature(candidate, entry)
            other = by_state[tuple((node, y, x) for node, x, y in state), order]
            a, b = entry["features"], other["features"]
            self.assertEqual(a["placement_proxy"]["width"], b["placement_proxy"]["height"])
            self.assertEqual(a["width_change_tiles"], b["height_change_tiles"])
            self.assertEqual(a["placement_proxy"]["area_tiles"], b["placement_proxy"]["area_tiles"])
            self.assertEqual(a["placement_proxy"]["manhattan_edges"], b["placement_proxy"]["manhattan_edges"])

    def test_ids_ignore_input_list_order_old_routes_and_cached_real_gains(self):
        candidate = fixture(); expected = candidate_menu(candidate)
        other = copy.deepcopy(candidate)
        other["nodes"].reverse(); other["edges"].reverse(); other["routes"].reverse()
        other["routes"][0]["path"].append([1, 1])
        other["qca_cells"] = 1; other["area_tiles"] = 1
        other["comparison_result"] = {"selected": "secret measured winner"}
        self.assertEqual(candidate_menu(other), expected)

    def test_menu_can_be_built_with_all_external_execution_disabled(self):
        with patch("subprocess.Popen", side_effect=AssertionError("No process may run")), \
             patch("subprocess.run", side_effect=AssertionError("No process may run")), \
             patch("ifcn_joint_search.evaluate", side_effect=AssertionError("No evaluator may run")):
            self.assertTrue(candidate_menu(fixture()))

    def test_cut_entries_are_pure_axis_moves_with_true_proxy_deltas(self):
        candidate = graph([(10, 10), (13, 13)])
        before = {n["id"]: (n["x"], n["y"]) for n in candidate["nodes"]}
        axes = set()
        for entry in candidate_menu(candidate):
            axis = entry["features"]["placement_axis"]
            if axis is None:
                continue
            axes.add(axis)
            for operation in entry["operations"]:
                x, y = before[operation["node"]]; nx, ny = operation["to"]
                if axis == "x":
                    self.assertEqual(ny, y); self.assertTrue(1 <= abs(nx - x) <= 2)
                    self.assertEqual(entry["features"]["height_change_tiles"], 0)
                else:
                    self.assertEqual(nx, x); self.assertTrue(1 <= abs(ny - y) <= 2)
                    self.assertEqual(entry["features"]["width_change_tiles"], 0)
        self.assertEqual(axes, {"x", "y"})

    def test_complete_disclosed_route_orders_cover_the_dag(self):
        candidate = fixture()
        for entry in candidate_menu(candidate):
            placed = apply_positions(candidate, entry["operations"])
            nodes = {n["id"]: n for n in placed["nodes"]}
            distances = {(a, b): abs(nodes[a]["x"] - nodes[b]["x"]) + abs(nodes[a]["y"] - nodes[b]["y"]) for a, b in candidate["edges"]}
            self.assertEqual({tuple(e) for e in entry["routing_order"]}, set(distances))
            policy = entry["features"]["route_policy"]
            if policy == "longest_manhattan":
                self.assertEqual(entry["routing_order"], [list(e) for e in sorted(distances, key=lambda e: (-distances[e], e))])
            elif policy == "shortest_manhattan":
                self.assertEqual(entry["routing_order"], [list(e) for e in sorted(distances, key=lambda e: (distances[e], e))])

    def test_reject_invalid_limits_exclusions_and_cyclic_dag(self):
        for limit in [0, -1, 49, True, "48"]:
            with self.subTest(limit=limit), self.assertRaises(ValueError): candidate_menu(fixture(), limit=limit)
        for excluded in ["menu_id", [True], [["unhashable"]], None]:
            with self.subTest(excluded=excluded), self.assertRaises(ValueError): candidate_menu(fixture(), excluded_ids=excluded)
        cyclic = graph([(10, 10), (13, 13)])
        cyclic["edges"].append([1, 0])
        with self.assertRaises(ValueError): candidate_menu(cyclic)


if __name__ == "__main__":
    unittest.main()
