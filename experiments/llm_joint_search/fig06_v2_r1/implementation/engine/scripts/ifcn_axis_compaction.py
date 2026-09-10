"""Deterministic axis-cut placement proposals for isolated layout experiments.

This module neither routes nor certifies a layout. Gate-box area and Manhattan
edge length are placement proxies; only a later native execution and independent
validation can establish routed area, QCA cells, and legality. The research API
permits up to eight explicit moves without changing the existing three-operation
LLM proposal contract.
"""
from __future__ import annotations

SCHEMA = "ifcn.layout_edit.v1"
COORDINATE_MAX = 4095
PADDING = 2


def _coordinate(value):
    if type(value) is not int or not 0 <= value <= COORDINATE_MAX:
        raise ValueError("Native XY coordinates must be integers in 0..4095")
    return value


def _graph(candidate):
    if not isinstance(candidate, dict) or not isinstance(candidate.get("nodes"), list) or not candidate["nodes"]:
        raise ValueError("Candidate must contain a nonempty node list")
    positions = {}
    for node in candidate["nodes"]:
        if not isinstance(node, dict) or type(node.get("id")) is not int or node["id"] < 0:
            raise ValueError("Node identities must be nonnegative integers")
        node_id = node["id"]
        if node_id in positions:
            raise ValueError("Duplicate node identity")
        positions[node_id] = (_coordinate(node.get("x")), _coordinate(node.get("y")))
    if len(set(positions.values())) != len(positions):
        raise ValueError("Candidate has colliding node positions")
    if not isinstance(candidate.get("edges"), list):
        raise ValueError("Candidate must contain its actual edge list")
    edges = []
    for edge in candidate["edges"]:
        if not isinstance(edge, (list, tuple)) or len(edge) != 2 or any(type(node) is not int or node not in positions for node in edge):
            raise ValueError("Edge references an unknown or malformed node identity")
        edges.append(tuple(edge))
    if len(set(edges)) != len(edges):
        raise ValueError("Duplicate graph edge")
    return dict(sorted(positions.items())), tuple(sorted(edges))


def _bbox(points):
    points = list(points)
    if not points:
        return None
    xs, ys = zip(*points)
    low_x, high_x, low_y, high_y = min(xs), max(xs), min(ys), max(ys)
    width, height = high_x - low_x + 1, high_y - low_y + 1
    return {"min_x": low_x, "max_x": high_x, "min_y": low_y, "max_y": high_y,
            "width": width, "height": height, "area_tiles": width * height}


def _metrics(positions, edges):
    box = _bbox(positions.values())
    return dict(box, manhattan_edges=sum(abs(positions[a][0] - positions[b][0]) +
                                        abs(positions[a][1] - positions[b][1]) for a, b in edges))


def placement_metrics(candidate):
    """Return the inclusive gate-node box and total Manhattan edge length.

    ``area_tiles`` here is a placement proxy, not routed or device area. Routes,
    cells, phases, and stored summary metrics do not influence these values.
    Malformed identities, coordinates, edges, or overlapping nodes raise ValueError.
    """
    positions, edges = _graph(candidate)
    return _metrics(positions, edges)


def _route_points(candidate):
    routes = candidate.get("routes", [])
    if not isinstance(routes, list):
        raise ValueError("Routes must be a list")
    points = []
    for route in routes:
        if not isinstance(route, dict) or not isinstance(route.get("path"), list) or not route["path"]:
            raise ValueError("Each recorded route must have a nonempty XY path")
        for point in route["path"]:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise ValueError("A native route site must contain exactly X and Y")
            points.append((_coordinate(point[0]), _coordinate(point[1])))
    return points


def routed_extent(candidate):
    """Return the inclusive union box of gates and recorded route.path sites.

    ``route_bbox`` is the box of actual route sites alone (None if absent). This
    is a geometric XY extent; route continuity, phase, layer and physical rules
    are not certified here. Stored cell/summary boxes are never substituted.
    """
    positions, _ = _graph(candidate)
    points = _route_points(candidate)
    return dict(_bbox([*positions.values(), *points]), route_bbox=_bbox(points))


def cut_proposals(candidate, axes=("x", "y"), max_operations=8, max_shift=2):
    """Enumerate inward prefix/suffix translations across empty gate-level gaps.

    For consecutive occupied levels lo < hi, translate all gates at >= hi down,
    or all gates at <= lo up, by 1..min(max_shift, hi-lo-1). The other axis and
    every graph identity are unchanged. Final level separation is at least one.
    Proposals only pass geometric proposal filters, never DRC or timing checks.

    Ordering: gate-box area, total Manhattan edge length, number of moved gates,
    then the canonical tuple (node_id, destination_x, destination_y). Duplicate
    final placements are removed. No input objects are mutated.
    """
    if type(max_operations) is not int or not 1 <= max_operations <= 8:
        raise ValueError("Research move budget must be an integer in 1..8")
    if type(max_shift) is not int or max_shift < 1:
        raise ValueError("max_shift must be a positive integer")
    try:
        axes = tuple(axes)
    except TypeError as error:
        raise ValueError("axes must contain x and/or y") from error
    if any(axis not in ("x", "y") for axis in axes):
        raise ValueError("axes must contain only x and y")
    positions, edges = _graph(candidate)
    extent = routed_extent(candidate)
    limits = (max(0, extent["min_x"] - PADDING), min(COORDINATE_MAX, extent["max_x"] + PADDING),
              max(0, extent["min_y"] - PADDING), min(COORDINATE_MAX, extent["max_y"] + PADDING))
    baseline_area = _metrics(positions, edges)["area_tiles"]
    scored, seen = [], set()
    for axis in sorted(set(axes)):
        dimension = 0 if axis == "x" else 1
        levels = sorted({point[dimension] for point in positions.values()})
        for lo, hi in zip(levels, levels[1:]):
            for side in ("suffix", "prefix"):
                selected = [node for node, point in positions.items()
                            if (point[dimension] >= hi if side == "suffix" else point[dimension] <= lo)]
                if not selected or len(selected) > max_operations:
                    continue
                direction = -1 if side == "suffix" else 1
                for shift in range(1, min(max_shift, hi - lo - 1) + 1):
                    trial = dict(positions)
                    for node in selected:
                        destination = list(positions[node]); destination[dimension] += direction * shift
                        trial[node] = tuple(destination)
                    if len(set(trial.values())) != len(trial):
                        continue
                    if any(not (limits[0] <= x <= limits[1] and limits[2] <= y <= limits[3]) for x, y in trial.values()):
                        continue
                    size = _metrics(trial, edges)
                    if size["area_tiles"] >= baseline_area:
                        continue
                    state = tuple((node, *point) for node, point in trial.items())
                    if state in seen:
                        continue
                    seen.add(state)
                    canonical = tuple((node, *trial[node]) for node in selected)
                    proposal = {"schema": SCHEMA,
                                "operations": [{"op": "move", "node": node, "to": list(trial[node])} for node in selected],
                                "rationale": f"Axis {axis} cut at {lo}: translate the {side} by {direction * shift} tile(s). "
                                             "Gate bounding-box proxy only; rerouting and DRC have not been evaluated."}
                    scored.append(((size["area_tiles"], size["manhattan_edges"], len(selected), canonical), proposal))
    return [proposal for _, proposal in sorted(scored, key=lambda item: item[0])]
