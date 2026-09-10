"""Unevaluated, deterministic action menus for bounded joint P&R selection.

The same menu is available to model and deterministic selectors. Construction
uses only the supplied incumbent geometry and DAG: no routing, model call,
certificate, previous comparator result, or measured candidate improvement is
queried. IDs identify final node coordinates plus an exact complete edge order.
They deliberately exclude the incumbent route geometry; callers must keep the
DAG, native routing configuration, and execution bounds under recorded control.
"""
from __future__ import annotations

import copy
import hashlib
import json
import graphlib

from ifcn_axis_compaction import cut_proposals, placement_metrics
from ifcn_joint_search import apply_positions, control_order

MAX_MENU_ENTRIES = 48
_ROUTE_POLICIES = (
    ("sink_pressure_layer_long", "sink-pressure/layer/long-edge"),
    ("topological_layer", "topological source-layer"),
    ("longest_manhattan", "longest-Manhattan-first"),
    ("shortest_manhattan", "shortest-Manhattan-first"),
)


def _state(candidate):
    return tuple(sorted((node["id"], node["x"], node["y"]) for node in candidate["nodes"]))


def _source_layers(candidate):
    """DAG depth, independent of coordinates, route lengths, and list ordering."""
    predecessors = {node["id"]: set() for node in candidate["nodes"]}
    for source, target in candidate["edges"]:
        predecessors[target].add(source)
    try:
        order = tuple(graphlib.TopologicalSorter(predecessors).static_order())
    except graphlib.CycleError as error:
        raise ValueError("A joint action menu requires an acyclic circuit DAG") from error
    layers = {}
    for node in order:
        layers[node] = max((layers[parent] + 1 for parent in predecessors[node]), default=0)
    return layers


def _orders(candidate, layers):
    positions = {node["id"]: (node["x"], node["y"]) for node in candidate["nodes"]}
    edges = [tuple(edge) for edge in candidate["edges"]]
    def distance(edge):
        a, b = (positions[node] for node in edge)
        return abs(a[0] - b[0]) + abs(a[1] - b[1])
    return (
        control_order(candidate),
        [list(edge) for edge in sorted(edges, key=lambda edge: (layers[edge[0]], edge))],
        [list(edge) for edge in sorted(edges, key=lambda edge: (-distance(edge), edge))],
        [list(edge) for edge in sorted(edges, key=lambda edge: (distance(edge), edge))],
    )


def candidate_menu(candidate, excluded_ids=(), limit=MAX_MENU_ENTRIES):
    """Return ranked exact actions, with pure-routing entries reserved at the cap.

    Generate inward X and Y cuts independently, with at most eight moved nodes
    and a two-tile shift, plus unchanged placement. Pair every placement with
    four fixed single-pass route orders and deduplicate exact final states/orders.
    Rank by node-box area, Manhattan edge sum, changed-node count, then disclosed
    route-policy priority; final-state/order tuples break remaining ties.

    Exclusions apply before truncation. Up to four distinct pure-routing entries
    reserve menu positions so cuts cannot remove the routing-only action family.
    If ``limit`` is smaller than that family, its first ``limit`` entries remain.
    The remaining capacity holds the best cut entries, and the combined menu is
    sorted by the same ranking. No entries have been natively routed or checked.
    """
    if type(limit) is not int or not 1 <= limit <= MAX_MENU_ENTRIES:
        raise ValueError("Menu limit must be an integer in 1..48")
    if isinstance(excluded_ids, (str, bytes)):
        raise ValueError("excluded_ids must be a collection of menu ID strings")
    try:
        excluded = set(excluded_ids)
    except (TypeError, ValueError) as error:
        raise ValueError("excluded_ids must be a collection of menu ID strings") from error
    if any(not isinstance(identifier, str) for identifier in excluded):
        raise ValueError("excluded_ids must contain only menu ID strings")
    initial = placement_metrics(candidate)  # also validates node/edge geometry
    layers = _source_layers(candidate)
    before = {node["id"]: (node["x"], node["y"]) for node in candidate["nodes"]}
    placements = []
    for axis in ("x", "y"):
        for cut in cut_proposals(candidate, axes=(axis,), max_operations=8, max_shift=2):
            placements.append((cut["operations"], axis, cut["rationale"]))
    placements.append(([], None, "Keep all node coordinates fixed."))
    unique = {}
    for operations, axis, description in placements:
        placed = apply_positions(candidate, operations)
        final = _state(placed)
        proxy = placement_metrics(placed)
        changed = sum((x, y) != before[node] for node, x, y in final)
        for policy_index, (order, (policy, label)) in enumerate(zip(_orders(placed, layers), _ROUTE_POLICIES)):
            signature = (final, tuple(map(tuple, order)))
            identifier = "menu_" + hashlib.sha256(json.dumps(signature, separators=(",", ":")).encode("utf-8")).hexdigest()[:24]
            if signature in unique or identifier in excluded:
                continue
            entry = {"id": identifier, "operations": copy.deepcopy(operations),
                     "routing_order": copy.deepcopy(order),
                     "features": {"placement_proxy": {**proxy, "scope": "Unevaluated node-box area and Manhattan edge sum; not routed area or QCA count."},
                                  "changed_nodes": changed,
                                  "width_change_tiles": proxy["width"] - initial["width"],
                                  "height_change_tiles": proxy["height"] - initial["height"],
                                  "route_policy": policy, "placement_axis": axis},
                     "description": description + " Select the " + label + " single-pass edge order; routing and certificates remain unevaluated."}
            score = (proxy["area_tiles"], proxy["manhattan_edges"], changed, policy_index, final, signature[1])
            unique[signature] = (score, entry)
    ranked = sorted(unique.values(), key=lambda pair: pair[0])
    route_only = [pair for pair in ranked if pair[1]["features"]["changed_nodes"] == 0][:limit]
    cuts = [pair for pair in ranked if pair[1]["features"]["changed_nodes"] != 0][:limit - len(route_only)]
    return [entry for _, entry in sorted(route_only + cuts, key=lambda pair: pair[0])]
