"""Independent clock-zone arrival checks on the actual exported combinational IFCN.

A tick is one forward phase transition. Same-phase traversal and gate internals
add no ticks in this discrete model; electrical settling time is outside scope.
"""
from collections import defaultdict, deque
import graphlib
import hashlib
import json
from pathlib import Path
import re

POINT = r"\((-?\d+)\s*,\s*(-?\d+)\)"

def read_clock_layout(text):
    sections = {}
    for section in ("nodes info", "paths info", "phase map"):
        parts = re.split(r"(?m)^#" + section + r"\s*$", text)
        if len(parts) != 3:
            raise ValueError("Missing or repeated IFCN section: " + section)
        sections[section] = "\n".join(line for line in parts[1].splitlines()
                                       if line.strip() and not line.lstrip().startswith("#"))
    nodes, routes, phases = {}, {}, {}
    for line in sections["nodes info"].splitlines():
        m = re.fullmatch(r"\s*(\d+)\s*,\s*([^,]+)\s*,\s*(\w+)\s*,\s*" + POINT + r"\s*;\s*", line)
        if not m:
            raise ValueError("Malformed IFCN node")
        node, name, kind, x, y = m.groups()
        node = int(node)
        if node in nodes:
            raise ValueError("Duplicate IFCN node")
        nodes[node] = {"name": name.strip(), "type": kind, "position": (int(x), int(y))}
    for line in sections["paths info"].splitlines():
        m = re.fullmatch(r"\s*" + POINT + r"\s*:\s*(.*?)\s*;\s*", line)
        if not m:
            raise ValueError("Malformed IFCN route")
        source, target, body = m.groups()
        edge = (int(source), int(target))
        if edge in routes or re.sub(POINT, "", body).replace(",", "").strip():
            raise ValueError("Duplicate or malformed IFCN route")
        routes[edge] = [tuple(map(int, p)) for p in re.findall(POINT, body)]
    body = sections["phase map"]
    pattern = POINT + r"\s*:\s*([0-3])\s*;"
    if re.sub(pattern, "", body).strip():
        raise ValueError("Malformed IFCN phase")
    for x, y, phase in re.findall(pattern, body):
        point = (int(x), int(y))
        if point in phases:
            raise ValueError("Duplicate IFCN phase coordinate")
        phases[point] = int(phase)
    if not nodes or not routes:
        raise ValueError("Empty combinational clock layout")
    return nodes, routes, phases

def validate_clock_arrivals(text, dag):
    nodes, routes, phases = read_clock_layout(text)
    dag_nodes = {int(n["id"]): n for n in dag["nodes"]}
    edges = {tuple(map(int, e)) for e in dag["edges"]}
    if set(nodes) != set(dag_nodes) or set(routes) != edges:
        raise ValueError("IFCN nodes/edges disagree with the logic-checked routed DAG")
    for key, node in nodes.items():
        if node["name"] != dag_nodes[key]["name"] or node["type"] != dag_nodes[key]["type"]:
            raise ValueError("IFCN gate identity disagrees with the logic-checked DAG")
        if node["position"] not in phases:
            raise ValueError("IFCN gate has no phase")
    predecessors = {n: set() for n in nodes}
    neighbours = defaultdict(list)
    delays = {}
    for (source, target), path in routes.items():
        if len(path) < 2 or path[0] != nodes[source]["position"] or path[-1] != nodes[target]["position"]:
            raise ValueError("IFCN route endpoints disagree with the gate positions")
        delay = 0
        for a, b in zip(path, path[1:]):
            if a not in phases or b not in phases or abs(a[0]-b[0])+abs(a[1]-b[1]) != 1:
                raise ValueError("IFCN route has a missing phase or nonadjacent step")
            step = (phases[b]-phases[a]) % 4
            if step not in (0, 1):
                raise ValueError("IFCN route has a backward clock step")
            delay += step
        delays[(source, target)] = delay
        predecessors[target].add(source)
        neighbours[source].append((target, delay))
        neighbours[target].append((source, -delay))
    order = list(graphlib.TopologicalSorter(predecessors).static_order())
    inputs = {n for n, d in dag_nodes.items() if d.get("is_input")}
    if not inputs or inputs != {n for n in nodes if not predecessors[n]}:
        raise ValueError("IFCN roots do not match the declared primary inputs")
    arrivals, mismatches = {}, []
    for node in order:
        if node in inputs:
            tick = phases[nodes[node]["position"]]
            arrivals[node] = (tick, tick)
        else:
            incoming = [(src, arrivals[src][0]+delays[(src,node)], arrivals[src][1]+delays[(src,node)])
                        for src in sorted(predecessors[node])]
            low, high = min(a for _, a, _ in incoming), max(b for _, _, b in incoming)
            arrivals[node] = (low, high)
            if low != high and len(mismatches) < 20:
                mismatches.append({"node": node, "name": nodes[node]["name"],
                                   "incoming_ticks": [{"source": src, "min": a, "max": b} for src,a,b in incoming]})
    # Difference equalities distinguish a needed PI schedule from an intrinsically
    # unbalanced reconvergence. Such a schedule is diagnostic, never applied.
    potentials, conflicts, offsets = {}, [], {}
    for root in order:
        if root in potentials:
            continue
        potentials[root] = 0
        queue, component = deque([root]), []
        while queue:
            node = queue.popleft()
            component.append(node)
            for other, delta in neighbours[node]:
                expected = potentials[node] + delta
                if other not in potentials:
                    potentials[other] = expected
                    queue.append(other)
                elif potentials[other] != expected and len(conflicts) < 20:
                    conflicts.append({"from":node,"to":other,"expected":expected,"actual":potentials[other]})
        primary = [n for n in component if n in inputs]
        anchor = primary[0]
        shift = (phases[nodes[anchor]["position"]] - potentials[anchor]) % 4
        minimum = min(potentials[n]+shift for n in primary)
        if minimum < 0:
            shift += ((-minimum+3)//4)*4
        for node in primary:
            offsets[nodes[node]["name"]] = (potentials[node]+shift-phases[nodes[node]["position"]])//4
    return {
        "schema":"ifcn.clock_arrival.v1", "passed":not mismatches and not conflicts,
        "launch_policy":"cycle_zero_at_template_phase", "phase_count":4,
        "relative_schedule_consistent":not conflicts,
        "required_input_cycle_offsets":offsets if not conflicts else None,
        "input_schedule_applied":False, "mismatches":mismatches,
        "relative_schedule_conflicts":conflicts, "nodes_checked":len(nodes), "routes_checked":len(routes),
        "arrival_tick_ranges":{str(n):list(ticks) for n,ticks in arrivals.items()},
        "route_delays":[{"source":s,"target":t,"ticks":v} for (s,t),v in sorted(delays.items())],
        "scope":"Discrete clock-zone arrival at every gate, with each PI launched in cycle zero at its own phase. Different outputs may have different latency. Same-phase movement and gate internals add zero clock ticks; no electrical settling-time or waveform signoff."
    }

def clock_arrival_report(ifcn, dag, output):
    ifcn, dag, output = Path(ifcn), Path(dag), Path(output)
    report = {"schema":"ifcn.clock_arrival.v1","passed":False,
              "launch_policy":"cycle_zero_at_template_phase",
              "ifcn_sha256":hashlib.sha256(ifcn.read_bytes()).hexdigest(),
              "routed_dag_sha256":hashlib.sha256(dag.read_bytes()).hexdigest()}
    try:
        report.update(validate_clock_arrivals(ifcn.read_text(), json.loads(dag.read_text())))
    except (ValueError, KeyError, TypeError, graphlib.CycleError) as exc:
        report["error"] = str(exc)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False)+"\n")
    if not report["passed"]:
        raise ValueError("Clock arrival alignment failed under cycle-zero PI launch; see clock.json.")
    return report
