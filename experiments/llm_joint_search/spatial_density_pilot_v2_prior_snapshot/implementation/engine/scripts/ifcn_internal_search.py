"""Internal-node search context and provenance; I/O node coordinates stay fixed.

The model may synthesize actions beyond the unevaluated geometric suggestions.
Neither suggestions nor Manhattan proxies certify clocking, routing or QCA gain.
"""
from __future__ import annotations
import copy
import hashlib
import json

import ifcn_joint_search as search
from ifcn_axis_compaction import placement_metrics
from ifcn_internal_relocation import internal_proposals


def action_key(candidate, proposal):
    final = search.key(search.apply_positions(candidate, proposal["operations"]))
    return hashlib.sha256(json.dumps([final, proposal["routing_order"]],
                                    separators=(",", ":")).encode()).hexdigest()


def fixed_ports(candidate):
    return {n["id"]: (n["x"], n["y"]) for n in candidate["nodes"]
            if n["is_input"] or n["is_output"]}


def internal_actions(candidate, excluded=(), limit=64):
    """Same deterministic, unevaluated suggestions visible to both policies."""
    excluded = set(excluded)
    result = []
    for item in internal_proposals(candidate, max_operations=8, limit=limit):
        placed = search.apply_positions(candidate, item["operations"])
        proposal = {"schema": "ifcn.layout_search.v2",
                    "operations": copy.deepcopy(item["operations"]),
                    "routing_order": search.control_order(placed),
                    "rationale": item["rationale"][:1200]}
        search.validate_proposal(proposal, candidate, lock_io=True)
        identifier = action_key(candidate, proposal)
        if identifier in excluded:
            continue
        result.append({"id": identifier, **proposal,
                       "features": copy.deepcopy(item.get("features", {}))})
    return result


def context_for(candidate, metrics, clock, history, suggestions):
    context = search.context_for(candidate, metrics, clock, history, lock_io=True)
    context["state_features"].pop("geometric_cut_suggestions", None)
    # Avoid repeating full DAG edge orders and unchanged boxes for every suggestion.
    # The model still sees each exact geometric action and every current route.
    context["state_features"]["internal_relocation_suggestions"] = [
        {"operations": copy.deepcopy(item["operations"]),
         "family": item.get("features", {}).get("operator_family"),
         "manhattan_proxy": {k:v for k,v in item.get("features", {}).get("edge_manhattan", {}).items()
                             if k != "affected"},
         "internal_extent_after": copy.deepcopy(item.get("features", {}).get("internal_extent", {}).get("after")),
         "scope": "Unevaluated geometry only"}
        for item in suggestions]
    context["state_features"]["reference_routing_order"] = {
        "order": search.control_order(candidate),
        "policy": "Deterministic control ranks target fanin descending, source logical layer, Manhattan length descending, edge IDs; recomputed after a move. You may select a different complete order."}
    context["state_features"]["suggestion_scope"] = (
        "Unevaluated internal-node actions, shared with the deterministic control. "
        "You may modify, combine or replace them within the action-space contract. "
        "No native candidate scores or other policy results are available.")
    ports = fixed_ports(candidate)
    xs = [xy[0] for xy in ports.values()]
    ys = [xy[1] for xy in ports.values()]
    context["state_features"]["fixed_port_envelope"] = {
        "coordinates": [{"id": n, "x": xy[0], "y": xy[1]} for n, xy in sorted(ports.items())],
        "area_lower_bound_tiles": (max(xs)-min(xs)+1)*(max(ys)-min(ys)+1) if ports else 1,
        "scope": "Lower bound only, not a promise of routable area. Port phases are not fixed."
    }
    context["state_features"]["evaluated_placement_outcomes"] = [
        {"round": r.get("round"), "status": r.get("status"),
         "operations": copy.deepcopy(r.get("proposal", {}).get("operations", [])),
         "area_change_tiles": (r["metrics"]["area_tiles"]-r["start_metrics"]["area_tiles"])
                              if r.get("metrics") else None,
         "qca_change_cells": (r["metrics"]["qca_cells"]-r["start_metrics"]["qca_cells"])
                             if r.get("metrics") else None,
         "interpretation": ("Certified but not an improvement; positive deltas are WORSE."
                            if r.get("status") == "rejected" else
                            "Failed certification or proposal: this is not a valid improvement."
                            if r.get("status") == "failed" else
                            "Accepted: independent certificates and actual area/cell objective passed.")}
        for r in history[-4:]]
    context["rules"]["internal_optimization"] = (
        "Keep every input/output XY fixed; relocate only internal logical nodes. "
        "Logical layers describe dependency, not immutable physical rows. "
        "Permit X and Y changes, local reordering and coordinated connected-group moves. "
        "Preserve every logical node and edge. A smaller internal envelope or Manhattan "
        "sum is a proxy: accept only independently certified actual area/QCA Pareto gains.")
    context["action_space"]["selection_mode"] = "direct_internal"
    return context


def change_record(before, after):
    ports = fixed_ports(before)
    if fixed_ports(after) != ports:
        raise ValueError("Fixed input/output node coordinates changed")
    old = {n["id"]: n for n in before["nodes"]}
    moved = [{"id": n["id"], "type": n["type"],
              "from": [old[n["id"]]["x"], old[n["id"]]["y"]],
              "to": [n["x"], n["y"]]}
             for n in sorted(after["nodes"], key=lambda n:n["id"])
             if (n["x"], n["y"]) != (old[n["id"]]["x"], old[n["id"]]["y"])]
    if any(n["id"] in ports for n in moved):
        raise ValueError("An internal-only result moved a port")
    previous_routes = {(r["source"],r["target"]):r["path"] for r in before["routes"]}
    route_changes = [{"edge":[r["source"],r["target"]],
                      "before_steps":len(previous_routes[r["source"],r["target"]])-1,
                      "after_steps":len(r["path"])-1}
                     for r in after["routes"]
                     if r["path"] != previous_routes[r["source"],r["target"]]]
    return {"fixed_port_count": len(ports), "all_port_coordinates_unchanged": True,
            "moved_internal_nodes": moved, "changed_route_count": len(route_changes),
            "route_changes": route_changes,
            "placement_proxy_before": placement_metrics(before),
            "placement_proxy_after": placement_metrics(after)}

