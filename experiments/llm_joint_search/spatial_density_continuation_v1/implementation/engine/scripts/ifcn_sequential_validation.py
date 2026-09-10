"""Bounded next-state comparison of SeqIR against the actual parsed cut DAG.

This verifies the lowering seam, not the original RTL, initialization, multiple
clock-domain behavior, routed feedback, device waveforms, or physical sign-off.
All port correspondence comes from the explicit state manifest.
"""
from __future__ import annotations

import graphlib
import itertools
from typing import Any

SCOPE = "SeqIR_vs_cut_DAG_one_step_next_state"
SOURCE_PORTS = {
    "not": {"A"}, "buf": {"A"}, "and": {"A", "B"},
    "or": {"A", "B"}, "xor": {"A", "B"}, "mux": {"A", "B", "S"},
}
DAG_ARITY = {
    "input": 0, "and": 2, "or": 2, "not": 1,
    "wire": 1, "buf": 1, "buffer": 1, "output": 1,
    "fanout": 1, "redundancy": 1, "maj": 3, "majority": 3,
}
CONSTANTS = {"const.0": 0, "const.1": 1}


class InvalidComparison(ValueError):
    """Unsupported or inconsistent metadata cannot grant verification."""


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise InvalidComparison(reason)


def _object(value: Any, label: str) -> dict:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list:
    _require(isinstance(value, list), f"{label} must be an array")
    return value


def _name(value: Any, label: str) -> str:
    _require(isinstance(value, str) and bool(value), f"{label} must be a nonempty string")
    return value


def _unique_names(value: Any, label: str) -> list[str]:
    names = [_name(entry, label) for entry in _array(value, label)]
    _require(len(names) == len(set(names)), f"{label} contains duplicates")
    return names


def _source(seqir: dict, manifest: dict):
    _require(seqir.get("schema") == "ifcn.seqir.v0", "unsupported SeqIR schema")
    _require(manifest.get("schema") == "ifcn.state_manifest.v0", "unsupported state-manifest schema")
    registers = {}
    q_signals = set()
    for raw in _array(seqir.get("registers"), "SeqIR registers"):
        register = _object(raw, "SeqIR register")
        identifier = _name(register.get("id"), "register id")
        q = _name(register.get("q"), f"register {identifier} Q")
        d = _name(register.get("d"), f"register {identifier} D")
        _require(register.get("kind") == "plain_posedge_dff" and type(register.get("width")) is int and register["width"] == 1,
                 f"unsupported register model at {identifier}")
        _require(identifier not in registers and q not in q_signals, "duplicate register identity or Q driver")
        registers[identifier] = {"q": q, "d": d}
        q_signals.add(q)
    _require(bool(registers), "SeqIR contains no registers")

    clocks = set()
    for raw in _array(seqir.get("clock_domains"), "SeqIR clock domains"):
        domain = _object(raw, "clock domain")
        clocks.add(_name(domain.get("signal"), "clock-domain signal"))
    primary_signals = set()
    for raw in _array(seqir.get("ports"), "SeqIR ports"):
        port = _object(raw, "SeqIR port")
        _require(port.get("direction") in ("input", "output"), "unknown SeqIR port direction")
        bits = _unique_names(port.get("bits"), "SeqIR port bits")
        if port["direction"] == "input":
            for signal in bits:
                _require(signal not in primary_signals, f"aliased SeqIR primary input {signal}")
                primary_signals.add(signal)
    _require(not (q_signals & primary_signals), "register Q is also a primary-input driver")
    _require(not ((q_signals | primary_signals) & set(CONSTANTS)), "constant name reused by an input driver")

    producers, node_ids = {}, set()
    for raw in _array(seqir.get("combinational_nodes"), "SeqIR combinational nodes"):
        node = _object(raw, "SeqIR combinational node")
        identifier = _name(node.get("id"), "SeqIR node id")
        op = _name(node.get("op"), f"SeqIR node {identifier} op")
        _require(op in SOURCE_PORTS, f"unsupported SeqIR operation {op} at {identifier}")
        inputs = _object(node.get("inputs"), f"SeqIR node {identifier} inputs")
        _require(set(inputs) == SOURCE_PORTS[op], f"unsupported ports for SeqIR node {identifier}")
        inputs = {port: _name(signal, f"SeqIR node {identifier}.{port}") for port, signal in inputs.items()}
        output = _name(node.get("output"), f"SeqIR node {identifier} output")
        _require(identifier not in node_ids, f"duplicate SeqIR node id {identifier}")
        _require(output not in producers and output not in q_signals | primary_signals | set(CONSTANTS), f"multiple drivers for SeqIR signal {output}")
        node_ids.add(identifier)
        producers[output] = {"op": op, "inputs": inputs}
    known = set(producers) | q_signals | primary_signals | set(CONSTANTS)
    for signal, node in producers.items():
        _require(set(node["inputs"].values()) <= known, f"undriven input in SeqIR node driving {signal}")
    for register in registers.values():
        _require(register["d"] in known, f"undriven register D {register['d']}")
    try:
        order = list(graphlib.TopologicalSorter({signal: set(node["inputs"].values()) & set(producers) for signal, node in producers.items()}).static_order())
    except graphlib.CycleError as error:
        raise InvalidComparison("SeqIR D logic contains a combinational cycle") from error

    boundaries, used_registers, event_names = [], set(), set()
    for raw in _array(manifest.get("state_boundaries"), "state boundaries"):
        boundary = _object(raw, "state boundary")
        identifier = _name(boundary.get("id"), "state-boundary register id")
        _require(identifier in registers and identifier not in used_registers, "unknown or duplicate register in state boundaries")
        entry = {key: _name(boundary.get(key), f"boundary {identifier}.{key}") for key in ("q_signal", "data_signal", "q_event", "data_event")}
        register = registers[identifier]
        _require(entry["q_signal"] == register["q"] and entry["data_signal"] == register["d"], f"state-boundary signals disagree with register {identifier}")
        _require(type(boundary.get("iteration_distance")) is int and boundary["iteration_distance"] == 1, f"register {identifier} boundary lost its one-step state dependency")
        _require(entry["q_event"] != entry["data_event"] and not ({entry["q_event"], entry["data_event"]} & event_names), "ambiguous state event mapping")
        event_names.update((entry["q_event"], entry["data_event"]))
        used_registers.add(identifier)
        boundaries.append({"id": identifier, **entry})
    _require(used_registers == set(registers), "state manifest dropped one or more register boundaries")

    cut = _object(manifest.get("cut_dag"), "cut DAG manifest")
    primary, used_signals = [], set()
    for raw in _array(cut.get("primary_inputs"), "cut primary inputs"):
        item = _object(raw, "cut primary input")
        signal = _name(item.get("signal"), "cut primary input signal")
        event = _name(item.get("event"), "cut primary input event")
        _require(signal in primary_signals - clocks, f"cut input {signal} is not a nonclock SeqIR input")
        _require(signal not in used_signals and event not in event_names, "duplicate or aliased cut input mapping")
        primary.append({"signal": signal, "event": event})
        used_signals.add(signal)
        event_names.add(event)
    expected_inputs = {entry["q_event"] for entry in boundaries} | {entry["event"] for entry in primary}
    expected_outputs = {entry["data_event"] for entry in boundaries}
    _require(set(_unique_names(cut.get("inputs"), "cut inputs")) == expected_inputs, "cut manifest input list disagrees with mapped Q/data inputs")
    _require(set(_unique_names(cut.get("outputs"), "cut outputs")) == expected_outputs, "cut manifest output list disagrees with mapped D events")

    needed, pending = set(), [register["d"] for register in registers.values()]
    while pending:
        signal = pending.pop()
        if signal in needed:
            continue
        needed.add(signal)
        if signal in producers:
            pending.extend(producers[signal]["inputs"].values())
    _require(not (needed & clocks), "logical clock enters a next-state data cone")
    _require(needed & primary_signals == used_signals, "cut primary-input mapping differs from the SeqIR D-cone inputs")
    return producers, [signal for signal in order if signal in needed], boundaries, primary, expected_inputs, expected_outputs


def _dag(dag: dict, expected_inputs: set[str], expected_outputs: set[str]):
    _require(dag.get("schema") == "ifcn.dag.v1", "unsupported cut DAG schema")
    nodes = {}
    for raw in _array(dag.get("nodes"), "DAG nodes"):
        node = _object(raw, "DAG node")
        identifier = node.get("id")
        _require(type(identifier) is int and identifier not in nodes, "missing or duplicate DAG integer node id")
        name = _name(node.get("name"), "DAG node name")
        kind = _name(node.get("type"), "DAG node type").lower()
        _require(kind in DAG_ARITY, f"unsupported DAG operation {kind}; names do not imply constants or gates")
        _require(type(node.get("is_input")) is bool and type(node.get("is_output")) is bool, "DAG input/output flags must be explicit")
        _require((kind == "input") == node["is_input"], "DAG input type and flag disagree")
        nodes[identifier] = {**node, "name": name, "type": kind}
    _require(bool(nodes), "empty cut DAG")
    incoming, edges = {identifier: [] for identifier in nodes}, set()
    for edge in _array(dag.get("edges"), "DAG edges"):
        _require(isinstance(edge, list) and len(edge) == 2 and all(type(identifier) is int for identifier in edge), "DAG edges must be explicit non-inverting source/sink pairs")
        pair = tuple(edge)
        _require(pair not in edges and set(pair) <= set(nodes), "duplicate DAG edge or unknown endpoint")
        edges.add(pair)
        incoming[edge[1]].append(edge[0])
    order = _array(dag.get("topological_order"), "DAG topological order")
    _require(all(type(identifier) is int for identifier in order), "DAG topological order requires integer ids")
    _require(len(order) == len(nodes) and set(order) == set(nodes), "DAG topological order omits or duplicates nodes")
    rank = {identifier: index for index, identifier in enumerate(order)}
    _require(all(rank[source] < rank[sink] for source, sink in edges), "DAG order is invalid or contains a cycle")
    inputs, outputs = {}, {}
    for identifier, node in nodes.items():
        _require(len(incoming[identifier]) == DAG_ARITY[node["type"]], f"DAG node {identifier} has an unsupported fanin count")
        for field, mapping in (("is_input", inputs), ("is_output", outputs)):
            if node[field]:
                _require(node["name"] not in mapping, f"ambiguous repeated DAG port {node['name']}")
                mapping[node["name"]] = identifier
    _require(set(inputs) == expected_inputs, "DAG input names do not preserve every mapped Q/data input")
    _require(set(outputs) == expected_outputs, "DAG outputs do not preserve every mapped D boundary")
    for key, actual in (("input_count", len(inputs)), ("output_count", len(outputs))):
        if key in dag:
            _require(type(dag[key]) is int and dag[key] == actual, f"DAG {key} contradicts its flags")
    return nodes, incoming, order, inputs, outputs


def _evaluate_source(producers, order, assignments):
    values = {**CONSTANTS, **assignments}
    for signal in order:
        node = producers[signal]
        args = {port: values[parent] for port, parent in node["inputs"].items()}
        op = node["op"]
        if op == "not": value = 1 - args["A"]
        elif op == "buf": value = args["A"]
        elif op == "and": value = args["A"] & args["B"]
        elif op == "or": value = args["A"] | args["B"]
        elif op == "xor": value = args["A"] ^ args["B"]
        else: value = args["B"] if args["S"] else args["A"]
        values[signal] = value
    return values


def _evaluate_dag(nodes, incoming, order, inputs, assignments):
    values = {inputs[event]: value for event, value in assignments.items()}
    for identifier in order:
        kind = nodes[identifier]["type"]
        if kind == "input":
            continue
        operands = [values[parent] for parent in incoming[identifier]]
        if kind == "and": value = int(all(operands))
        elif kind == "or": value = int(any(operands))
        elif kind == "not": value = int(not operands[0])
        elif kind in ("maj", "majority"): value = int(sum(operands) >= 2)
        else: value = operands[0]
        values[identifier] = value
    return values


def verify_next_state(seqir: dict, state_manifest: dict, dag: dict, max_inputs: int = 11) -> dict:
    """Exhaust every mapped state/data valuation when within the bit limit.

    Only ``status == 'equivalent'`` grants this narrow lowering-seam check.
    ``input_bits`` counts retained nonclock data inputs, ``state_bits`` counts
    all register Q bits, and ``gate_nodes`` counts internal cut DAG nodes.
    """
    report = {"schema": "ifcn.sequential-next-state-validation.v1", "scope": SCOPE,
              "status": "invalid", "equivalent": None, "vectors_checked": 0,
              "state_bits": 0, "input_bits": 0, "gate_nodes": 0,
              "mismatch_count": 0, "counterexamples": [], "max_inputs": max_inputs,
              "excludes": ["original_RTL_equivalence", "initialization", "clock_domain_synchronization", "feedback_routing", "device_waveforms", "physical_state_signoff"]}
    try:
        _require(type(max_inputs) is int and max_inputs >= 0, "max_inputs must be a nonnegative integer")
        producers, source_order, boundaries, primary, expected_inputs, expected_outputs = _source(
            _object(seqir, "SeqIR"), _object(state_manifest, "state manifest"))
        report.update(state_bits=len(boundaries), input_bits=len(primary), source_gate_nodes=len(source_order))
        nodes, incoming, order, inputs, outputs = _dag(_object(dag, "cut DAG"), expected_inputs, expected_outputs)
        report["gate_nodes"] = sum(not node["is_input"] and not node["is_output"] for node in nodes.values())
        total = len(boundaries) + len(primary)
        report["total_inputs"] = total
        if total > max_inputs:
            report.update(status="not_performed", reason=f"{total} state/data bits exceed exhaustive limit {max_inputs}")
            return report
        bindings = [(entry["q_signal"], entry["q_event"]) for entry in boundaries] + [(entry["signal"], entry["event"]) for entry in primary]
        for bits in itertools.product((0, 1), repeat=total):
            source_inputs = {signal: bit for (signal, _), bit in zip(bindings, bits)}
            dag_inputs = {event: bit for (_, event), bit in zip(bindings, bits)}
            source_values = _evaluate_source(producers, source_order, source_inputs)
            dag_values = _evaluate_dag(nodes, incoming, order, inputs, dag_inputs)
            report["vectors_checked"] += 1
            for entry in boundaries:
                expected = source_values[entry["data_signal"]]
                observed = dag_values[outputs[entry["data_event"]]]
                if expected != observed:
                    report["mismatch_count"] += 1
                    if len(report["counterexamples"]) < 8:
                        report["counterexamples"].append({"register": entry["id"], "data_event": entry["data_event"],
                            "source_signals": source_inputs, "cut_inputs": dag_inputs, "expected": expected, "observed": observed})
        report["equivalent"] = report["mismatch_count"] == 0
        report["status"] = "equivalent" if report["equivalent"] else "mismatch"
    except InvalidComparison as error:
        report.update(status="invalid", equivalent=None, reason=str(error))
    return report
