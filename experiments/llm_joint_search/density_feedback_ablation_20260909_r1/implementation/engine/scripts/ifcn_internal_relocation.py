"""Port-fixed internal placement neighborhoods for subsequent certified search.

This is a proposal generator, not a router or a legality certificate. It keeps
node/edge identities and PI/PO coordinates fixed, but may move internal gates
onto old wire sites: the executor must discard and reroute those wires. Gate
boxes, Manhattan lengths and recorded route detours are only geometric proxies.
No clock, port-direction, physical, source-equivalence or device checks run here.

The coordinated neighborhoods supplement familiar single-gate local/median
moves. They do not claim that single-gate compaction is a new algorithm. In
particular, unlike global axis cuts, neither shrinking the full gate box nor
improving a placement proxy is a prerequisite for proposing an internal move.
"""
from __future__ import annotations

from collections import defaultdict, deque
from heapq import heappop, heappush

from ifcn_axis_compaction import COORDINATE_MAX, PADDING, SCHEMA, _bbox, _graph, _route_points

# Fixed work caps, independent of coordinate range and requested result count.
# Each family gets its own budget, so local moves cannot starve joint moves.
_FAMILY_ATTEMPTS = 1024
_MAX_SEEDS = 64
_MAX_GROUPS = 128
_FAMILIES = (
    "connected_contraction", "connected_relaxation", "layer_permutation",
    "connected_translation", "neighbor_median", "route_detour", "local_vacancy",
)


def _distance(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def _step(origin, target, distance=1):
    return origin + max(-distance, min(distance, target - origin))


def _median(values):
    values = sorted(values)
    return values[(len(values) - 1) // 2]


def _input(candidate):
    positions, edges = _graph(candidate)
    # Without explicit booleans it is unsafe to infer which coordinates are ports.
    nodes = {node["id"]: node for node in candidate["nodes"]}
    for node in nodes.values():
        if any(type(node.get(role)) is not bool for role in ("is_input", "is_output")):
            raise ValueError("Every node needs explicit boolean is_input/is_output roles")
        if node.get("type") == "input" and not node["is_input"]:
            raise ValueError("An input node cannot be marked as an internal node")
        if node.get("type") == "output" and not node["is_output"]:
            raise ValueError("An output node cannot be marked as an internal node")
    internal = tuple(node for node in positions
                     if not nodes[node]["is_input"] and not nodes[node]["is_output"])
    predecessors = {node: [] for node in positions}
    successors = {node: [] for node in positions}
    for source, target in edges:
        successors[source].append(target)
        predecessors[target].append(source)
    # Use actual edges rather than trusting a possibly stale stored layers array.
    pending = {node: len(predecessors[node]) for node in positions}
    ready, depth = [], dict.fromkeys(positions, 0)
    for node, count in pending.items():
        if count == 0:
            heappush(ready, node)
    visited = 0
    while ready:
        source = heappop(ready)
        visited += 1
        for target in successors[source]:
            depth[target] = max(depth[target], depth[source] + 1)
            pending[target] -= 1
            if not pending[target]:
                heappush(ready, target)
    if visited != len(positions):
        raise ValueError("Internal relocation requires an acyclic source graph")
    neighbors = {node: tuple(sorted(set(predecessors[node] + successors[node])))
                 for node in positions}
    points = _route_points(candidate)
    box = _bbox([*positions.values(), *points])
    bounds = {"min_x": max(0, box["min_x"] - PADDING),
              "max_x": min(COORDINATE_MAX, box["max_x"] + PADDING),
              "min_y": max(0, box["min_y"] - PADDING),
              "max_y": min(COORDINATE_MAX, box["max_y"] + PADDING)}
    routes, seen = [], set()
    edge_set = set(edges)
    for route in candidate.get("routes", []):
        edge = (route.get("source"), route.get("target"))
        if any(type(node) is not int for node in edge) or edge not in edge_set or edge in seen:
            raise ValueError("Recorded routes must refer to distinct actual DAG edges")
        seen.add(edge)
        path = tuple(tuple(point) for point in route["path"])
        if path[0] != positions[edge[0]] or path[-1] != positions[edge[1]]:
            raise ValueError("Recorded route endpoints must match their source/target nodes")
        # A proxy can also read rectilinear polylines; it does not certify unit
        # steps, crossings, clocks or whether the recorded route is legal.
        if any(a == b or (a[0] != b[0] and a[1] != b[1]) for a, b in zip(path, path[1:])):
            raise ValueError("Recorded route segments must be nonzero and rectilinear")
        length = sum(_distance(a, b) for a, b in zip(path, path[1:]))
        turns = tuple(b for a, b, c in zip(path, path[1:], path[2:])
                      if (b[0] - a[0]) * (c[1] - b[1]) != (b[1] - a[1]) * (c[0] - b[0]))
        direct = _distance(positions[edge[0]], positions[edge[1]])
        routes.append({"edge": edge, "path": path, "length": length,
                       "manhattan": direct, "detour": length - direct, "turns": turns})
    routes.sort(key=lambda route: (-route["detour"], -route["length"], route["edge"]))
    return positions, edges, internal, neighbors, depth, bounds, routes


def internal_proposals(candidate, max_operations=8, limit=64):
    """Return deterministic, diverse atomic move proposals with fixed PI/POs.

    ``max_operations`` is an integer in 1..8 and counts distinct moved nodes.
    ``limit`` is an integer in 1..256. Input records are not modified or aliased.
    All coordinates must fit the original gate/route union plus two tiles,
    clipped to 0..4095. Only *final* gate occupancy is checked, allowing swaps
    encoded as two moves; old routes/cells are never obstacles at this stage.

    Connected groups are bounded BFS neighborhoods in the internal induced DAG
    (viewed undirected), including up to eight support nodes. A contraction may
    leave some support nodes stationary. Layer permutations use equal longest-
    path depth from the DAG, not equal geometric Y or unverified stored layers.
    Selection cycles through operator families after proxy ranking within each
    family. No gain threshold is applied: coordinated worsening/equal-proxy
    reorderings remain available for the later router and certificate checks.

    ``features`` is observation metadata, not part of the native edit schema;
    callers should pass only schema/operations/rationale to a strict v1 executor.
    """
    if type(max_operations) is not int or not 1 <= max_operations <= 8:
        raise ValueError("max_operations must be an integer in 1..8")
    if type(limit) is not int or not 1 <= limit <= 256:
        raise ValueError("limit must be an integer in 1..256")
    positions, edges, internal, neighbors, depth, bounds, routes = _input(candidate)
    if not internal:
        return []
    internal_set = set(internal)
    adjacency = {node: tuple(other for other in neighbors[node] if other in internal_set)
                 for node in internal}
    detour = dict.fromkeys(internal, 0)
    incident_routes = defaultdict(list)
    for route in routes:
        for node in route["edge"]:
            if node in internal_set:
                detour[node] += route["detour"]
                incident_routes[node].append(route)
    seeds = sorted(internal, key=lambda node: (-detour[node], -len(neighbors[node]), node))[:_MAX_SEEDS]
    groups, group_seen = [], set()
    if max_operations >= 2:
        for seed in seeds:
            queue, selected, enqueued = deque([seed]), [], {seed}
            while queue and len(selected) < max_operations:
                node = queue.popleft()
                selected.append(node)
                if len(selected) >= 2:
                    group = tuple(sorted(selected))
                    if group not in group_seen:
                        groups.append(group)
                        group_seen.add(group)
                for other in sorted(adjacency[node], key=lambda item: (-detour[item], item)):
                    if other not in enqueued:
                        queue.append(other)
                        enqueued.add(other)
            if len(groups) >= _MAX_GROUPS:
                groups = groups[:_MAX_GROUPS]
                break
    before_lengths = {edge: _distance(positions[edge[0]], positions[edge[1]]) for edge in edges}
    internal_edges = tuple(edge for edge in edges if all(node in internal_set for node in edge))
    before_total = sum(before_lengths.values())
    before_internal = sum(before_lengths[edge] for edge in internal_edges)
    before_box, before_internal_box = _bbox(positions.values()), _bbox(positions[node] for node in internal)
    pools = {family: [] for family in _FAMILIES}
    attempts = dict.fromkeys(_FAMILIES, 0)
    seen = {family: set() for family in _FAMILIES}

    def offer(family, destinations, group, explanation):
        if attempts[family] >= _FAMILY_ATTEMPTS:
            return
        attempts[family] += 1
        moved = tuple(sorted(node for node, point in destinations.items() if point != positions[node]))
        if not moved or len(moved) > max_operations or any(node not in internal_set for node in moved):
            return
        if family.startswith("connected_") or family == "layer_permutation":
            if len(moved) < 2:
                return
        trial = dict(positions)
        trial.update(destinations)
        if any(not (bounds["min_x"] <= x <= bounds["max_x"] and
                    bounds["min_y"] <= y <= bounds["max_y"]) for x, y in trial.values()):
            return
        if len(set(trial.values())) != len(trial):
            return
        canonical = tuple((node, *trial[node]) for node in moved)
        if canonical in seen[family]:
            return
        seen[family].add(canonical)
        after_lengths = {edge: _distance(trial[edge[0]], trial[edge[1]]) for edge in edges}
        total = sum(after_lengths.values())
        affected = [edge for edge in edges if any(node in moved for node in edge)]
        after_box = _bbox(trial.values())
        after_internal_box = _bbox(trial[node] for node in internal)
        features = {
            "operator_family": family, "proxy_only": True, "requires_reroute_and_certification": True,
            "port_coordinates_fixed": True, "coordinated": len(moved) >= 2,
            "internal_node_ids": list(internal), "moved_internal_ids": list(moved),
            "support_internal_ids": list(sorted(group)),
            "dag_depths": [{"node": node, "depth": depth[node]} for node in sorted(group)],
            "edge_manhattan": {"before": before_total, "after": total, "delta": total - before_total,
                               "affected": [{"edge": list(edge), "before": before_lengths[edge],
                                             "after": after_lengths[edge]} for edge in affected]},
            "internal_edge_manhattan": {"before": before_internal,
                                        "after": sum(after_lengths[edge] for edge in internal_edges)},
            "node_bbox": {"before": dict(before_box), "after": after_box},
            "internal_extent": {"before": dict(before_internal_box), "after": after_internal_box},
            "coordinate_bounds": dict(bounds),
            "recorded_route_hints": [{"edge": list(route["edge"]), "length": route["length"],
                                      "manhattan": route["manhattan"], "detour": route["detour"]}
                                     for route in routes if route["edge"] in affected][:4],
        }
        proposal = {"schema": SCHEMA,
                    "operations": [{"op": "move", "node": node, "to": list(trial[node])} for node in moved],
                    "rationale": explanation + " PI/PO coordinates stay fixed. Geometry proxies only; "
                                 "rerouting, clock repair and independent certification are required.",
                    "features": features}
        pools[family].append(((total, after_internal_box["area_tiles"], len(moved), canonical), canonical, proposal))

    # Contract each connected internal window toward a centered, rank-preserving
    # packing. No port or gate outside the support window follows this motion.
    for group in groups:
        for axis in (0, 1):
            levels = sorted({positions[node][axis] for node in group})
            for spacing in (2, 1):
                span = (len(levels) - 1) * spacing
                if len(levels) < 2 or levels[-1] - levels[0] <= span:
                    continue
                origin = (levels[0] + levels[-1] - span) // 2
                packed = {level: origin + index * spacing for index, level in enumerate(levels)}
                for step in (1, 2):
                    destinations = {}
                    for node in group:
                        point = list(positions[node])
                        point[axis] = _step(point[axis], packed[point[axis]], step)
                        destinations[node] = tuple(point)
                    offer("connected_contraction", destinations, group,
                          "Contract a connected internal window along " + "xy"[axis] +
                          f" toward {spacing}-tile level spacing; the exterior remains fixed.")
        # Jacobi-style simultaneous neighbor relaxation, as opposed to greedily
        # committing individual gates in sequence. Final occupancy is atomic.
        for step in (1, 2):
            for axes in ((0,), (1,), (0, 1)):
                destinations = {}
                for node in group:
                    point = list(positions[node])
                    for axis in axes:
                        target = _median(positions[other][axis] for other in neighbors[node])
                        point[axis] = _step(point[axis], target, step)
                    destinations[node] = tuple(point)
                offer("connected_relaxation", destinations, group,
                      "Relax a connected internal group toward simultaneous neighbor medians.")
        outside = sorted({other for node in group for other in neighbors[node] if other not in group})
        for axis in (0, 1):
            if not outside:
                continue
            target = _median(positions[node][axis] for node in outside)
            center = _median(positions[node][axis] for node in group)
            for step in (1, 2):
                shift = _step(center, target, step) - center
                destinations = {node: tuple(value + (shift if dim == axis else 0)
                                            for dim, value in enumerate(positions[node])) for node in group}
                offer("connected_translation", destinations, group,
                      "Translate a connected internal group toward its fixed exterior neighbors.")

    # Reuse occupied sites atomically: same-DAG-depth swaps and small rotations
    # can alter route congestion without changing either the full or layer box.
    layers = defaultdict(list)
    for node in internal:
        layers[depth[node]].append(node)
    layer_windows = []
    for layer in sorted(layers):
        row = sorted(layers[layer], key=lambda node: (*positions[node], node))
        if max_operations < 2:
            break
        for index in range(len(row) - 1):
            layer_windows.append(tuple(row[index:index + max_operations]))
        if len(row) >= 2:
            layer_windows.append((row[0], row[-1]))
    for window in layer_windows[:_MAX_GROUPS]:
        for group in (window[:2], window):
            if len(group) < 2:
                continue
            for offset in (1, -1):
                destinations = {node: positions[group[(index + offset) % len(group)]]
                                for index, node in enumerate(group)}
                offer("layer_permutation", destinations, group,
                      "Permute internal gates at equal DAG depth across their existing sites.")
            for axis in (0, 1):
                slots = sorted((positions[node] for node in group), key=lambda point: (point[axis], point[1 - axis]))
                ordered = sorted(group, key=lambda node: (
                    _median(positions[other][axis] for other in neighbors[node]) if neighbors[node] else positions[node][axis], node))
                offer("layer_permutation", dict(zip(ordered, slots)), group,
                      "Reassign occupied internal layer sites using exterior-neighbor order.")

    for node in seeds:
        point = positions[node]
        if neighbors[node]:
            for step in (1, 2):
                for axes in ((0,), (1,), (0, 1)):
                    destination = list(point)
                    for axis in axes:
                        target = _median(positions[other][axis] for other in neighbors[node])
                        destination[axis] = _step(point[axis], target, step)
                    offer("neighbor_median", {node: tuple(destination)}, (node,),
                          "Move one internal gate toward its graph-neighbor median.")
        for route in incident_routes[node][:2]:
            if route["detour"] <= 0:
                continue
            targets = sorted(set(route["turns"]), key=lambda target: (_distance(point, target), target))[:2]
            for target in targets:
                for step in (1, 2):
                    for axis in (0, 1):
                        destination = list(point)
                        destination[axis] = _step(point[axis], target[axis], step)
                        offer("route_detour", {node: tuple(destination)}, (node,),
                              "Relocate an internal endpoint toward a bend of a recorded detouring route.")
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-2, 0), (2, 0), (0, -2), (0, 2),
                       (-1, -1), (-1, 1), (1, -1), (1, 1)):
            offer("local_vacancy", {node: (point[0] + dx, point[1] + dy)}, (node,),
                  "Explore a nearby unoccupied gate site for an internal node.")

    queues = {family: deque(sorted(pools[family], key=lambda item: item[0])) for family in _FAMILIES}
    result, selected_states = [], set()
    while len(result) < limit and any(queues.values()):
        for family in _FAMILIES:
            while queues[family]:
                _, canonical, proposal = queues[family].popleft()
                if canonical not in selected_states:
                    selected_states.add(canonical)
                    result.append(proposal)
                    break
            if len(result) == limit:
                break
    return result
