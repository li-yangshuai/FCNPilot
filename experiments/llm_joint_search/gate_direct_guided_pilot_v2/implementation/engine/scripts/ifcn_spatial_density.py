"""Spatial, port-fixed internal neighborhoods; geometry observations only.

Windows are selected by XY proximity, independently of DAG depth/connectivity.
Density counts unique XY tile sites, separately for gates and recorded wires
(excluding gate sites). It is not QCA density, routing capacity, or a DRC test.
Recorded wires describe the incumbent, never obstacles or predicted new wires.
No evaluator, native executable, model, or clock/physical validator is invoked.
"""
from __future__ import annotations

from collections import deque

from ifcn_axis_compaction import SCHEMA, _bbox
from ifcn_internal_relocation import _input, _distance, _median, _step

_MAX_REGIONS = 24
_RADII = (3, 6, 12)
_MAX_ATTEMPTS = 96  # Per region and operator family.
_FAMILIES = ("spatial_anchor_relaxation", "spatial_gap_bridge", "spatial_site_permutation",
             "spatial_window_contraction", "single_anchor", "single_sparse_hotspot", "single_vacancy")


def _inside(point, box):
    return box["min_x"] <= point[0] <= box["max_x"] and box["min_y"] <= point[1] <= box["max_y"]


def _area(box):
    return (box["max_x"] - box["min_x"] + 1) * (box["max_y"] - box["min_y"] + 1)


def _wire_sites(routes, box):
    """Clip before expansion: even long polyline segments cost <=25 sites here."""
    sites = set()
    for route in routes:
        path = route["path"]
        if len(path) == 1 and _inside(path[0], box):
            sites.add(path[0])
        for a, b in zip(path, path[1:]):
            if a[0] == b[0] and box["min_x"] <= a[0] <= box["max_x"]:
                lo, hi = max(min(a[1], b[1]), box["min_y"]), min(max(a[1], b[1]), box["max_y"])
                sites.update((a[0], y) for y in range(lo, hi + 1))
            elif a[1] == b[1] and box["min_y"] <= a[1] <= box["max_y"]:
                lo, hi = max(min(a[0], b[0]), box["min_x"]), min(max(a[0], b[0]), box["max_x"])
                sites.update((x, a[1]) for x in range(lo, hi + 1))
    return sites


def _bands(box, sites, kind):
    result = []
    for axis, dim in (("x", 0), ("y", 1)):
        low, high = box["min_" + axis], box["max_" + axis]
        occupied = {point[dim] for point in sites}
        start = None
        for value in range(low, high + 2):
            if value <= high and value not in occupied:
                if start is None:
                    start = value
            elif start is not None:
                result.append({"axis": axis, "start": start, "end": value - 1,
                               "width": value - start, "occupancy_basis": kind,
                               "between_occupied_levels": any(item < start for item in occupied)
                               and any(item >= value for item in occupied)})
                start = None
    return sorted(result, key=lambda item: (-item["width"], item["axis"], item["start"]))[:6]


def _tiles(box):
    """A bounded 3x3 subdivision supplies meaningful sparse/dense subregions."""
    xs = list(range(box["min_x"], box["max_x"] + 1))
    ys = list(range(box["min_y"], box["max_y"] + 1))
    for row in range(3):
        yy = ys[len(ys) * row // 3:len(ys) * (row + 1) // 3]
        if not yy:
            continue
        for col in range(3):
            xx = xs[len(xs) * col // 3:len(xs) * (col + 1) // 3]
            if xx:
                yield {"min_x": xx[0], "max_x": xx[-1], "min_y": yy[0], "max_y": yy[-1]}


def _context(data):
    positions, edges, internal, neighbors, depth, bounds, routes = data
    ordered = sorted(internal, key=lambda node: (*positions[node], node))
    # Up to eight distributed spatial centers, each at three scales. This
    # avoids spending every context slot on the first/highest-degree DAG layer.
    seeds = (ordered if len(ordered) <= 8 else
             [ordered[index * (len(ordered) - 1) // 7] for index in range(8)])
    seen, regions = set(), []
    gates = set(positions.values())
    for radius in _RADII:
        for seed in seeds:
            x, y = positions[seed]
            box = {"min_x": max(bounds["min_x"], x - radius), "max_x": min(bounds["max_x"], x + radius),
                   "min_y": max(bounds["min_y"], y - radius), "max_y": min(bounds["max_y"], y + radius)}
            identity = tuple(box[key] for key in ("min_x", "max_x", "min_y", "max_y"))
            if identity in seen:
                continue
            seen.add(identity)
            node_ids = [node for node in positions if _inside(positions[node], box)]
            nearby = sorted((node for node in internal if _inside(positions[node], box)),
                            key=lambda node: (_distance(positions[node], (x, y)), node))[:8]
            movable = sorted(nearby)
            local_gates = {positions[node] for node in node_ids}
            wire = _wire_sites(routes, box) - gates
            occupied = local_gates | wire
            area = _area(box)
            grid = []
            for tile in _tiles(box):
                ga = sum(_inside(point, tile) for point in local_gates)
                wi = sum(_inside(point, tile) for point in wire)
                grid.append({"bounds": tile, "area_tiles": _area(tile), "gate_count": ga,
                             "old_wire_count": wi, "combined_density": (ga + wi) / _area(tile)})
            hotspots = sorted(grid, key=lambda tile: (tile["combined_density"], tile["gate_count"],
                                                     tile["bounds"]["min_x"], tile["bounds"]["min_y"]))[:4]
            anchors = []
            for node in movable:
                anchors.append({"node": node,
                                "external_neighbors": [{"node": other, "xy": list(positions[other])}
                                                       for other in neighbors[node] if other not in movable],
                                "all_neighbor_median": [int(_median(positions[other][axis] for other in neighbors[node]))
                                                        for axis in (0, 1)] if neighbors[node] else None})
            regions.append({"region_id": "window_" + "_".join(map(str, identity)), "bounds": box,
                            "center": [x, y], "area_tiles": area, "gate_count": len(local_gates),
                            "old_wire_count": len(wire), "gate_density": len(local_gates) / area,
                            "old_wire_density": len(wire) / area, "combined_density": len(occupied) / area,
                            "empty_fraction": 1 - len(occupied) / area,
                            "movable_internal_ids": movable,
                            "fixed_node_ids": [node for node in positions if node not in movable],
                            "nodes_in_window": [{"node": node, "xy": list(positions[node]),
                                                 "movable": node in movable, "dag_depth": depth[node]} for node in node_ids],
                            "neighbor_external_anchors": anchors,
                            "empty_bands": {"gate_only": _bands(box, local_gates, "gate_sites"),
                                            "gate_and_old_wire": _bands(box, occupied, "gate_and_old_wire_sites")},
                            "density_grid": grid, "vacancy_hotspots": hotspots})
    return {"schema": "ifcn.spatial_density.v1", "proxy_only": True,
            "scope": "XY tile occupancy of incumbent gates and recorded routes, not QCA density or a DRC certificate. "
                     "Old wire sites are observations, not obstacles for new placement.",
            "coordinate_bounds": dict(bounds), "regions": regions[:_MAX_REGIONS]}


def density_context(candidate):
    """Return <=24 stable-ID windows and incumbent occupancy/anchor observations.

    Each window is <=25x25 tiles with <=8 internal movable nodes. Other nodes,
    including any additional internal nodes inside the window, remain fixed.
    Stored candidate layers/cell summaries do not define the density or groups.
    Rectilinear recorded segments are expanded only inside each bounded window;
    shared route sites count once and gate endpoints are excluded from wires.
    """
    return _context(_input(candidate))


def spatial_proposals(candidate, region_ids=None, limit=128, max_operations=8):
    """Return diverse region-local moves with fixed ports/exterior coordinates.

    ``region_ids`` is None (all windows) or a unique list/tuple of known IDs; an
    empty list selects no windows. ``limit`` is 1..512, move budget is 1..8.
    Every destination remains in its selected window and native incumbent
    gate/route bounds+2. Final occupancy alone is tested, so atomic site swaps
    and moves onto old wires are allowed. A multi-node action must use differing
    displacement vectors: this module does not offer whole-group translations.
    Logical layers and connectivity impose no grouping restriction.

    Manhattan/box improvement is not required. Neighbor/hotspot moves step at
    most four tiles per axis; opposing gap moves may use up to eight, clipped
    by actual vacant gate-band width. No new routed-density claim is computed.
    ``features`` must be removed before a strict native v1 proposal submission.
    """
    if type(max_operations) is not int or not 1 <= max_operations <= 8:
        raise ValueError("max_operations must be an integer in 1..8")
    if type(limit) is not int or not 1 <= limit <= 512:
        raise ValueError("limit must be an integer in 1..512")
    data = _input(candidate)
    positions, edges, internal, neighbors, depth, bounds, routes = data
    context = _context(data)
    available = {region["region_id"]: region for region in context["regions"]}
    if region_ids is not None:
        if not isinstance(region_ids, (list, tuple)) or any(type(item) is not str for item in region_ids):
            raise ValueError("region_ids must be a list/tuple of known region strings")
        if len(region_ids) != len(set(region_ids)) or any(item not in available for item in region_ids):
            raise ValueError("region_ids contains duplicate or unknown windows")
        allowed = set(region_ids)
        regions = [region for region in context["regions"] if region["region_id"] in allowed]
    else:
        regions = context["regions"]
    before_lengths = {edge: _distance(positions[edge[0]], positions[edge[1]]) for edge in edges}
    total_before = sum(before_lengths.values())
    full_before, internal_before = _bbox(positions.values()), _bbox(positions[node] for node in internal)
    internal_set = set(internal)
    pools = {}
    for region in regions:
        region_id, window = region["region_id"], region["bounds"]
        movable = region["movable_internal_ids"]
        # Prefix windows and neighboring spatial pairs allow partial-region
        # actions, including nonadjacent DAG levels and disconnected branches.
        near = sorted(movable, key=lambda node: (_distance(positions[node], region["center"]), node))
        groups = [tuple(near[:size]) for size in range(2, min(max_operations, len(near)) + 1)]
        if max_operations >= 2:
            groups.extend((node, other) for node in near for other in
                          sorted((item for item in near if item > node),
                                 key=lambda item: (_distance(positions[node], positions[item]), item))[:2])
        groups = list(dict.fromkeys(tuple(sorted(group)) for group in groups))[:16]
        local_pools = {family: [] for family in _FAMILIES}
        attempts = dict.fromkeys(_FAMILIES, 0)
        seen = {family: set() for family in _FAMILIES}

        def offer(family, destinations, explanation):
            if attempts[family] >= _MAX_ATTEMPTS:
                return
            attempts[family] += 1
            moved = tuple(sorted(node for node, point in destinations.items() if point != positions[node]))
            if not moved or len(moved) > max_operations or any(node not in movable for node in moved):
                return
            if family.startswith("spatial_") and len(moved) < 2:
                return
            vectors = {(destinations[node][0] - positions[node][0], destinations[node][1] - positions[node][1]) for node in moved}
            if len(moved) > 1 and len(vectors) == 1:
                return
            trial = dict(positions)
            trial.update(destinations)
            if any(not _inside(trial[node], window) or not _inside(trial[node], bounds) for node in moved):
                return
            if len(set(trial.values())) != len(trial):
                return
            canonical = tuple((node, *trial[node]) for node in moved)
            if canonical in seen[family]:
                return
            seen[family].add(canonical)
            after_lengths = {edge: _distance(trial[edge[0]], trial[edge[1]]) for edge in edges}
            after_total = sum(after_lengths.values())
            extent = _bbox(trial[node] for node in internal)
            affected = [edge for edge in edges if any(node in moved for node in edge)]
            proposal = {"schema": SCHEMA,
                        "operations": [{"op": "move", "node": node, "to": list(trial[node])} for node in moved],
                        "rationale": explanation + " Only selected internal nodes move; PI/PO and all exterior nodes stay fixed. "
                                     "Occupancy/length proxies are not certificates; rerouting and clock/physical/logic checks remain required.",
                        "features": {"region_id": region_id, "region_bounds": dict(window), "operator_family": family,
                                     "proxy_only": True, "requires_reroute_and_certification": True,
                                     "port_coordinates_fixed": True, "moved_internal_ids": list(moved),
                                     "coordinated": len(moved) >= 2, "dag_depths": sorted({depth[node] for node in moved}),
                                     "displacements": [{"node": node, "dx": trial[node][0] - positions[node][0],
                                                        "dy": trial[node][1] - positions[node][1]} for node in moved],
                                     "incumbent_region_density": {key: region[key] for key in
                                                                  ("gate_density", "old_wire_density", "empty_fraction")},
                                     "edge_manhattan": {"before": total_before, "after": after_total,
                                                        "delta": after_total - total_before,
                                                        "affected": [{"edge": list(edge), "before": before_lengths[edge],
                                                                      "after": after_lengths[edge]} for edge in affected]},
                                     "internal_edge_manhattan": {
                                         "before": sum(before_lengths[edge] for edge in edges if all(node in internal_set for node in edge)),
                                         "after": sum(after_lengths[edge] for edge in edges if all(node in internal_set for node in edge))},
                                     "node_bbox": {"before": dict(full_before), "after": _bbox(trial.values())},
                                     "internal_extent": {"before": dict(internal_before), "after": extent}}}
            local_pools[family].append(((after_total, extent["area_tiles"], len(moved), canonical), canonical, proposal))

        for group in groups:
            for step in (1, 2, 4):
                for axes in ((0, 1), (0,), (1,)):
                    destinations = {}
                    for node in group:
                        point = list(positions[node])
                        for axis in axes:
                            if neighbors[node]:
                                point[axis] = _step(point[axis], _median(positions[other][axis] for other in neighbors[node]), step)
                        destinations[node] = tuple(point)
                    offer("spatial_anchor_relaxation", destinations,
                          "Move a spatially selected subset toward node-specific neighbor anchors using different local displacements.")
            for axis in (0, 1):
                levels = sorted({positions[node][axis] for node in group})
                for lo, hi in zip(levels, levels[1:]):
                    gap = hi - lo - 1
                    if gap < 2 or any(lo < point[axis] < hi for point in positions.values() if _inside(point, window)):
                        continue
                    for step in sorted({1, 2, 4, min(8, gap // 2)}):
                        if step > gap // 2:
                            continue
                        destinations = {}
                        for node in group:
                            point = list(positions[node])
                            point[axis] += step if point[axis] <= lo else -step
                            destinations[node] = tuple(point)
                        offer("spatial_gap_bridge", destinations,
                              "Bring opposite sides of a local gate-free " + "xy"[axis] +
                              f" gap inward by {step} tile(s), without translating the full layer.")
                for spacing in (2, 1):
                    if len(levels) < 2 or levels[-1] - levels[0] <= (len(levels) - 1) * spacing:
                        continue
                    origin = (levels[0] + levels[-1] - (len(levels) - 1) * spacing) // 2
                    targets = {level: origin + index * spacing for index, level in enumerate(levels)}
                    for step in (1, 2, 4):
                        destinations = {}
                        for node in group:
                            point = list(positions[node]); point[axis] = _step(point[axis], targets[point[axis]], step)
                            destinations[node] = tuple(point)
                        offer("spatial_window_contraction", destinations,
                              "Contract occupied levels inside a spatial subset, independently of logical layers.")
            # Identity-preserving swaps/rotations reuse sites atomically. They
            # may worsen Manhattan cost but open a different routing channel.
            for offset in (1, -1):
                destinations = {node: positions[group[(index + offset) % len(group)]] for index, node in enumerate(group)}
                offer("spatial_site_permutation", destinations,
                      "Reassign existing sites within a spatial subset; graph identities and edges are unchanged.")
        for node in near:
            point = positions[node]
            if neighbors[node]:
                for step in (1, 2, 4):
                    for axes in ((0, 1), (0,), (1,)):
                        destination = list(point)
                        for axis in axes:
                            destination[axis] = _step(point[axis], _median(positions[other][axis] for other in neighbors[node]), step)
                        offer("single_anchor", {node: tuple(destination)}, "Relocate one internal node toward its neighbor anchors.")
            for tile in region["vacancy_hotspots"][:3]:
                target = tuple((tile["bounds"]["min_" + axis] + tile["bounds"]["max_" + axis]) // 2 for axis in ("x", "y"))
                for step in (1, 2, 4):
                    destination = tuple(_step(point[axis], target[axis], step) for axis in (0, 1))
                    offer("single_sparse_hotspot", {node: destination},
                          "Explore a nearby sparse incumbent-occupancy patch; old wires will be rerouted.")
            for step in (1, 2, 3, 4):
                for dx, dy in ((-step, 0), (step, 0), (0, -step), (0, step)):
                    offer("single_vacancy", {node: (point[0] + dx, point[1] + dy)},
                          "Explore an unoccupied local gate site without requiring immediate proxy improvement.")
        pools[region_id] = {family: deque(sorted(local_pools[family], key=lambda item: item[0])) for family in _FAMILIES}
    # Alternate both windows and operator families; overlapping windows cannot
    # consume result slots with duplicate final placements.
    result, seen_states = [], set()
    while len(result) < limit and any(queue for local in pools.values() for queue in local.values()):
        for offset in range(len(_FAMILIES)):
            for index, region in enumerate(regions):
                family = _FAMILIES[(index + offset) % len(_FAMILIES)]
                queue = pools[region["region_id"]][family]
                while queue:
                    _, canonical, proposal = queue.popleft()
                    if canonical not in seen_states:
                        seen_states.add(canonical); result.append(proposal)
                        break
                if len(result) >= limit:
                    return result
    return result
