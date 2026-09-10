"""Direct gate-level LLM context and certified, nonmonotone search states.

The model proposes placement and edge-order edits; the native evaluator alone
routes, assigns clocks, maps devices and certifies them. Density is observation,
not a candidate menu or a legality test. Retained results remain Pareto monotone.
"""
from __future__ import annotations

import copy
import hashlib
import json

import ifcn_joint_search as search
from ifcn_axis_compaction import placement_metrics
from ifcn_density_search import compact_path
from ifcn_spatial_density import density_context

_METRICS = ("width", "height", "area_tiles", "qca_cells", "edge_steps")


def state_key(candidate):
    """Hash physical state, including routing and clocks, not just placement.

    Artifact ordering and descriptive metadata do not change the key. Route
    paths remain directed; distinct routes/phases at identical gate positions
    must still be eligible for a subsequent expansion.
    """
    state = {
        "algorithm": candidate.get("algorithm"),
        "nodes": sorted((n["id"], n["x"], n["y"], n.get("type"),
                         n.get("is_input"), n.get("is_output"))
                        for n in candidate["nodes"]),
        "edges": sorted(tuple(edge) for edge in candidate["edges"]),
        "routes": sorted((r["source"], r["target"], compact_path(r["path"]))
                         for r in candidate["routes"]),
        "phases": sorted((c["x"], c["y"], c["phase"])
                         for c in candidate["cells"]),
    }
    return hashlib.sha256(json.dumps(state, separators=(",", ":"),
                                     sort_keys=True).encode()).hexdigest()


def _bounded(value, depth=0):
    """Bound historical diagnostics without copying whole candidate artifacts."""
    if isinstance(value, str):
        return value[:700]
    if depth >= 4:
        return str(value)[:300]
    if isinstance(value, dict):
        return {str(key): _bounded(item, depth + 1)
                for key, item in list(value.items())[:12]}
    if isinstance(value, (list, tuple)):
        return [_bounded(item, depth + 1) for item in value[:12]]
    return value


def _feedback(history):
    rows = []
    for round_row in history[-4:]:
        # Density records contain separately evaluated candidates; direct
        # studies may instead put their one result on the round itself.
        children = round_row.get("candidates")
        if not isinstance(children, list) or not children:
            children = [round_row]
        for child in children:
            result = child.get("result", child)
            if not isinstance(result, dict):
                continue
            before = result.get("start_metrics") or round_row.get("start_metrics", {})
            metrics = result.get("metrics") or {}
            row = {
                "round": round_row.get("round"),
                "candidate_id": child.get("candidate_id"),
                "origin": child.get("origin"),
                "status": result.get("status"),
                "round_decision": round_row.get("decision", round_row.get("status")),
                "proposal": _bounded(child.get("proposal", result.get("proposal"))),
                "metrics": {k: metrics[k] for k in _METRICS if k in metrics},
                "metric_delta_from_start": {
                    k: metrics[k] - before[k] for k in _METRICS
                    if type(metrics.get(k)) in (int, float)
                    and type(before.get(k)) in (int, float)},
                "certificates": _bounded(result.get("certificates", {})),
            }
            for field in ("error", "unrouted_edges", "routing_audit", "route_changes",
                          "phase_repair", "clock_diagnostics"):
                if field in result:
                    row[field] = _bounded(result[field])
            rows.append(row)
    return rows[-12:]


def gate_context(candidate, metrics, clock, history, best_metrics, lock_io=True):
    """Observe the current gate-level state and request a free joint proposal.

    The caller supplies past evaluations only. No unevaluated candidate score,
    other policy result, or future result is looked up by this function.
    """
    context = search.context_for(candidate, metrics, clock, [], lock_io=lock_io)
    features = context["state_features"]
    for key in ("geometric_cut_suggestions", "gate_levels", "phase_map_native_1_based"):
        features.pop(key, None)
    density = density_context(candidate)
    features["spatial_regions"] = [
        {"id": region["region_id"], "bounds": copy.deepcopy(region["bounds"]),
         "gate_density": region["gate_density"],
         "old_wire_density": region["old_wire_density"],
         "empty_fraction": region["empty_fraction"],
         "nearby_internal_ids": list(region["movable_internal_ids"]),
         "empty_bands": {k: copy.deepcopy(v[:2]) for k, v in region["empty_bands"].items()},
         "vacancy_hotspots": copy.deepcopy(region["vacancy_hotspots"][:2])}
        for region in density["regions"]]
    nodes = {node["id"]: node for node in candidate["nodes"]}
    neighbors = {node: set() for node in nodes}
    for source, target in candidate["edges"]:
        neighbors[source].add(target); neighbors[target].add(source)
    anchors = []
    for node, connected in sorted(neighbors.items()):
        if nodes[node]["is_input"] or nodes[node]["is_output"] or not connected:
            continue
        anchors.append({"node": node, "neighbor_ids": sorted(connected),
                        "neighbor_median_xy": [sorted(nodes[n][axis] for n in connected)
                                               [(len(connected) - 1) // 2]
                                               for axis in ("x", "y")]})
    features["internal_neighbor_anchors"] = anchors
    features["phase_tiles_xy_phase"] = [[c["x"], c["y"], c["phase"]]
                                       for c in candidate["cells"]]
    context["routes"] = [{"source": r["source"], "target": r["target"],
                          "path": compact_path(r["path"])} for r in candidate["routes"]]
    features["route_path_encoding"] = "Exact rectilinear bend points; route_costs contain unit-step costs."
    features["best_retained_metrics"] = copy.deepcopy(best_metrics)
    features["current_state_id"] = state_key(candidate)
    ports = search._io_positions(candidate)
    xs, ys = [p[0] for p in ports.values()], [p[1] for p in ports.values()]
    width = max(xs) - min(xs) + 1 if xs else 1
    height = max(ys) - min(ys) + 1 if ys else 1
    envelope = {
        "coordinates": [{"id": node, "x": xy[0], "y": xy[1]}
                        for node, xy in sorted(ports.items())],
        "width_tiles": width, "height_tiles": height, "area_tiles": width * height,
        "coordinates_locked": lock_io}
    if lock_io:
        envelope.update(width_lower_bound_tiles=width, height_lower_bound_tiles=height,
                        area_lower_bound_tiles=width * height,
                        current_area_equals_lower_bound=metrics["area_tiles"] == width * height,
                        scope="Inclusive fixed PI/PO XY envelope: an area lower bound, not a routability guarantee. "
                              "If already attained, internal edits can reduce devices or detours but cannot reduce area.")
        features["fixed_port_envelope"] = envelope
    else:
        envelope["scope"] = "Current PI/PO XY envelope only; movable ports mean this is NOT an area lower bound."
        features["incumbent_port_envelope"] = envelope
    features["suggestion_scope"] = (
        "Regions and neighbor anchors are observations only. They do not restrict node choice, "
        "displacement, or grouping. Generate your own coordinated gate moves/swaps and edge order.")
    context.pop("candidate_menu", None)
    context["feedback"] = _feedback(history)
    context["feedback_scope"] = "At most 12 actual past evaluations from the last four rounds; positive metric deltas mean worse."
    context["action_space"].update(selection_mode="direct", max_operations=8,
                                  cross_region_moves_allowed=True,
                                  permitted_operations=["move", "swap"],
                                  empty_operations_allow_routing_only=False,
                                  must_change_internal_node=True)
    identity_contract = ("Keep PI/PO XY, all logical identities and edges fixed. " if lock_io else
                         "Keep all logical identities and edges, including every PI/PO identity, fixed. "
                         "PI/PO XY may move. ")
    context["rules"]["search_contract"] = (
        "Return ifcn.layout_search.v2 with your own operations, a complete unique routing_order, "
        "and a concise observable rationale. " + identity_contract +
        "At least one true internal node must change XY; port-only compaction and routing-only "
        "proposals are excluded in this experiment. "
        "Logical layers are dependencies, not fixed physical rows. Use independent X/Y internal "
        "moves or swaps and choose a complete routing order. Every exact proposal is rerouted, assigned clocks, "
        "mapped to QCA and independently certified. Retained best changes only on actual area/cell "
        "Pareto improvement. A separate fully certified exploration state can temporarily increase "
        "area and cells by at most 10% relative to the retained best, to cross a local plateau. "
        "A failed route is not evidence that the whole region is exhausted.")
    return copy.deepcopy(context)


def _certified(row):
    certificates = row.get("certificates", {})
    metrics = row.get("metrics", {})
    if not (row.get("status") == "certified"
            and certificates.get("logic") == "equivalent"
            and all(certificates.get(k) is True for k in ("clock", "physical", "interface"))
            and all(type(metrics.get(k)) is int and metrics[k] > 0
                    for k in ("area_tiles", "qca_cells"))):
        return False
    try:
        state_key(row["candidate"])
    except (KeyError, TypeError, ValueError):
        return False
    return True


def select_state(best_candidate, best_metrics, best_clock, certified_rows, expanded_states):
    """Select an incumbent improvement or a separate bounded exploration state.

    This function never mutates the best. The caller may replace its retained
    best only for ``improved_retained``; exploration changes current state only.
    ``expanded_states`` contains state_key strings of already expanded states.
    """
    valid = [row for row in certified_rows if _certified(row)]
    improving = [row for row in valid if search.pareto(best_metrics, row["metrics"])]
    if improving:
        selected = min(improving, key=lambda row: (row["metrics"]["area_tiles"],
                       row["metrics"]["qca_cells"], row["metrics"].get("edge_steps", 0),
                       state_key(row["candidate"])))
        return copy.deepcopy(selected), "improved_retained"
    expanded = set(expanded_states)
    options = [row for row in valid if state_key(row["candidate"]) not in expanded
               and all(row["metrics"][key] * 10 <= best_metrics[key] * 11
                       for key in ("area_tiles", "qca_cells"))]
    if options:
        selected = min(options, key=lambda row: (
            row["metrics"]["area_tiles"] / best_metrics["area_tiles"]
            + row["metrics"]["qca_cells"] / best_metrics["qca_cells"],
            placement_metrics(row["candidate"])["manhattan_edges"],
            state_key(row["candidate"])))
        return copy.deepcopy(selected), "certified_exploration"
    return {"candidate": copy.deepcopy(best_candidate), "metrics": copy.deepcopy(best_metrics),
            "clock": copy.deepcopy(best_clock)}, "retain_best"
