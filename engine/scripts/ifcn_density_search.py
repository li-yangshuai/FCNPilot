"""Spatially local search directed by a model-selected, unevaluated seed."""
from __future__ import annotations
import copy
import hashlib
import json
from collections import defaultdict

import ifcn_joint_search as search
import ifcn_internal_search as interior
from ifcn_axis_compaction import placement_metrics
from ifcn_spatial_density import density_context, spatial_proposals


def signature(candidate, proposal):
    placed=search.apply_positions(candidate,proposal["operations"])
    data=[search.key(placed),proposal["routing_order"],search.bounds(candidate)]
    return hashlib.sha256(json.dumps(data,separators=(",",":")).encode()).hexdigest()[:20]


def build_pool(candidate, excluded=()):
    excluded=set(excluded)
    density=density_context(candidate)
    entries=[]
    seen=set()
    for item in spatial_proposals(candidate,limit=128,max_operations=8):
        placed=search.apply_positions(candidate,item["operations"])
        proposal={"schema":"ifcn.layout_search.v2","operations":copy.deepcopy(item["operations"]),
                  "routing_order":search.control_order(placed),"rationale":item["rationale"][:1200]}
        search.validate_proposal(proposal,candidate,lock_io=True)
        identifier=signature(candidate,proposal)
        if identifier in seen or identifier in excluded:continue
        seen.add(identifier)
        features=item["features"]
        entries.append({"id":identifier,"operations":proposal["operations"],
                        "routing_order":proposal["routing_order"],
                        "features":{"region_id":features.get("region_id"),
                                    "operator_family":features.get("operator_family"),
                                    "placement_proxy":placement_metrics(placed),
                                    "changed_nodes":len(item["operations"]),
                                    "scope":"Unevaluated node box/Manhattan proxy, not QCA gain"},
                        "description":proposal["rationale"]})
    # Preserve spatial diversity. Within a region, use an explicit wire-length
    # proxy ordering; round-robin across regions rather than exhaust one row.
    pools=defaultdict(list)
    for entry in entries:pools[entry["features"]["region_id"]].append(entry)
    for pool in pools.values():
        pool.sort(key=lambda e:(e["features"]["placement_proxy"]["manhattan_edges"],
                                e["features"]["placement_proxy"]["area_tiles"],
                                len(e["operations"]),e["id"]))
    region_rank={r["region_id"]:i for i,r in enumerate(density["regions"])}
    order=sorted(pools,key=lambda r:(region_rank.get(r,999),str(r)))
    ranked=[]
    for index in range(max(map(len,pools.values()),default=0)):
        for region in order:
            if index<len(pools[region]):ranked.append(pools[region][index])
    return density,ranked


def compact_path(path):
    if len(path)<3:return copy.deepcopy(path)
    return [list(path[0])]+[list(b) for a,b,c in zip(path,path[1:],path[2:])
                          if ((b[0]-a[0])*(c[1]-b[1]) != (b[1]-a[1])*(c[0]-b[0])
                              or (b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1]) <= 0)]+[list(path[-1])]


_FEEDBACK_METRICS = ("width", "height", "area_tiles", "qca_cells", "edge_steps")


def _feedback_metrics(value):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in _FEEDBACK_METRICS
            if type(value.get(key)) in (int, float) and abs(value[key]) < 1e15}


def _feedback_delta(before, after):
    # Signed measured changes: negative means fewer tiles/cells/steps.
    return {key: after[key] - before[key] for key in _FEEDBACK_METRICS if key in before and key in after}


def _feedback_order(value):
    if not isinstance(value, list):
        return None
    return {"edge_count": len(value), "first_edges": copy.deepcopy(value[:8]),
            "sha256": hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()}


def _feedback_proposal(value):
    if not isinstance(value, dict):
        return None
    operations = []
    for operation in value.get("operations", [])[:8]:
        if not isinstance(operation, dict):
            continue
        if operation.get("op") == "move":
            operations.append({"op": "move", "node": operation.get("node"),
                               "to": copy.deepcopy(operation.get("to", [])[:2])})
        elif operation.get("op") == "swap":
            operations.append({"op": "swap", "nodes": copy.deepcopy(operation.get("nodes", [])[:2])})
    return {"operations": operations, "routing_order": _feedback_order(value.get("routing_order")),
            "rationale": str(value.get("rationale", ""))[:240]}


def _feedback_diagnostics(value):
    diagnostic = {}
    if value.get("error"):
        diagnostic["error"] = str(value["error"])[:600]
    if isinstance(value.get("unrouted_edges"), list):
        diagnostic["unrouted_edges"] = copy.deepcopy(value["unrouted_edges"][:8])
    audit = value.get("routing_audit")
    if isinstance(audit, dict):
        diagnostic["routing_audit"] = {key: audit[key] for key in
            ("route_order_attempts", "fallback_used", "explicit_routing_order", "io_locked")
            if key in audit and type(audit[key]) in (int, bool)}
    for key in ("phase_repair", "clock_diagnostics"):
        report = value.get(key)
        if isinstance(report, dict):
            diagnostic[key] = {name: (item[:400] if isinstance(item, str) else item)
                               for name in ("status", "reason", "error", "passed", "validation_passed",
                                            "actual_max_same_phase_tiles", "same_phase_steps")
                               if type(item := report.get(name)) in (str, int, float, bool)}
    return diagnostic


def _density_feedback(history, round_number):
    """Project completed past rounds only; never expose current/future trial results.

    The density driver nests native results under candidates. Older joint-search
    histories store one proposal/result at round level and remain readable.
    Bounds keep rich diagnostics from dominating the model's layout context.
    """
    past = [row for row in history if isinstance(row, dict)
            and row.get("status") not in ("running", "pending", "planned")
            and (type(row.get("round")) is not int or row["round"] < round_number)]
    feedback = []
    for row in past[-4:]:
        before = _feedback_metrics(row.get("start_metrics"))
        retained = _feedback_metrics(row.get("retained_metrics"))
        if not retained and row.get("status") == "accepted":
            retained = _feedback_metrics(row.get("metrics"))
        record = {"round": row.get("round"), "status": str(row.get("status", "unknown"))[:80],
                  "start_metrics": before, "retained_metrics": retained,
                  "retained_delta_from_start": _feedback_delta(before, retained), "candidates": []}
        for key in ("seed_id", "accepted_candidate_id", "accepted_origin"):
            if row.get(key) is not None:
                record[key] = str(row[key])[:160]
        selection = row.get("selection", row.get("decision"))
        if isinstance(selection, dict):
            record["selection"] = {key: str(selection[key])[:240] for key in
                                   ("source", "candidate_id", "rationale") if key in selection}
        record.update(_feedback_diagnostics(row))
        trials = row.get("candidates")
        legacy = not isinstance(trials, list)
        if legacy:
            trials = [{"candidate_id": row.get("candidate_id"), "proposal": row.get("proposal"),
                       "result": row}] if isinstance(row.get("proposal"), dict) else []
        for trial in trials[:6]:
            if not isinstance(trial, dict) or not isinstance(trial.get("result"), dict):
                continue
            result = trial["result"]
            if not result.get("status") or result["status"] in ("running", "pending", "planned"):
                continue
            metrics = _feedback_metrics(result.get("metrics"))
            candidate_id = trial.get("candidate_id")
            entry = {"candidate_id": str(candidate_id)[:160] if candidate_id is not None else None,
                     "status": str(result["status"])[:80],
                     "accepted": (legacy and row.get("status") == "accepted") or
                                 (candidate_id is not None and candidate_id == row.get("accepted_candidate_id")),
                     "proposal": _feedback_proposal(trial.get("proposal", result.get("proposal"))),
                     "metrics": metrics, "metric_delta_from_start": _feedback_delta(before, metrics)}
            for key in ("seed_id", "origin"):
                if trial.get(key) is not None:
                    entry[key] = str(trial[key])[:160]
            certificates = result.get("certificates")
            if isinstance(certificates, dict):
                entry["certificates"] = {key: (certificates[key][:80] if isinstance(certificates[key], str) else certificates[key])
                                         for key in ("logic", "clock", "physical", "interface")
                                         if type(certificates.get(key)) in (str, bool)}
            entry.update(_feedback_diagnostics(result))
            record["candidates"].append(entry)
        feedback.append(record)
    return feedback


def context_for(candidate,metrics,clock,history,density,menu,round_number,batch_size,best_metrics):
    context=search.context_for(candidate,metrics,clock,history,lock_io=True)
    context["feedback"] = _density_feedback(history, round_number)
    features=context["state_features"]
    features.pop("geometric_cut_suggestions",None)
    features.pop("gate_levels",None)
    features.pop("phase_map_native_1_based",None)
    features["phase_tiles_xy_phase"]=[[c["x"],c["y"],c["phase"]] for c in candidate["cells"]]
    features["spatial_regions"]=[
        {"id":r["region_id"],"image_label":f"R{i}" if i<=8 else None,
         **{k:copy.deepcopy(r.get(k)) for k in
            ("bounds","gate_density","old_wire_density","empty_fraction","movable_internal_ids")},
         "empty_bands":{k:copy.deepcopy(v[:3]) for k,v in r.get("empty_bands",{}).items()}}
        for i,r in enumerate(density["regions"],1)]
    features["layout_scope"]="Gate-level tiles and prior routes; low density does not certify a legal move."
    features["best_retained_metrics"]=copy.deepcopy(best_metrics)
    features["suggestion_scope"]="Model selects a spatial seed. Independent bounded neighboring candidates may move different subsets of nodes; no logical layer is translated as a requirement."
    context["routes"]=[{"source":r["source"],"target":r["target"],"path":compact_path(r["path"])}
                       for r in candidate["routes"]]
    features["route_path_encoding"]="Exact rectilinear polyline bend points, not a unit-step list."
    # Deliberately hide the heuristic rank; avoid presenting candidate 0 as advice.
    context["candidate_menu"]=sorted(copy.deepcopy(menu),key=lambda e:hashlib.sha256(
        f"{round_number}:{e['id']}".encode()).hexdigest())
    context["action_space"]["selection_mode"]="candidate_menu"
    context["rules"]["local_search_guidance"]=True
    context["rules"]["local_search_batch_size"]=batch_size
    context["rules"]["search_contract"]=(
        "Select a seed whose internal region has room for local node relocation or detour removal. "
        "The selected exact seed is tried first, followed by up to batch_size-1 explicitly logged "
        "deterministic neighboring placements/orders. Each native call runs its exact order once. "
        "All original hard rules apply. A failed candidate is not an exhausted region. "
        "Only certified strict Pareto improvements replace the current and retained layout: "
        "actual routed area and exported QCA cells must both be non-increasing and at least one strictly lower. "
        "Failed or non-improving trials retain the same incumbent; no regressing exploration state is used. "
        "Feedback contains only completed earlier rounds (at most four rounds and six candidates per round). "
        "Metric deltas are candidate minus that round's start; negative means reduction. "
        "A candidate's measured reduction is not acceptance unless its accepted flag is true.")
    return context


def proposal_from_entry(entry,rationale=None):
    return {"schema":"ifcn.layout_search.v2","operations":copy.deepcopy(entry["operations"]),
            "routing_order":copy.deepcopy(entry["routing_order"]),
            "rationale":(rationale or entry["description"])[:1200]}


def neighborhood(candidate,seed,pool,excluded=(),limit=6):
    """All actions are constructed before native evaluations; no hidden retries."""
    excluded=set(excluded);result=[];used=set()
    seed_proposal=proposal_from_entry(seed)
    def offer(proposal,origin):
        if len(result)>=limit:return
        try:search.validate_proposal(proposal,candidate,lock_io=True)
        except ValueError:return
        identifier=signature(candidate,proposal)
        if identifier in excluded or identifier in used:return
        used.add(identifier)
        result.append({"id":identifier,"proposal":proposal,"origin":origin,"seed_id":seed["id"]})
    offer(seed_proposal,"exact_selected_seed")
    operations=seed_proposal["operations"]
    # Evaluate subsets in the unchanged exterior, rather than assuming the whole
    # selected group must move together. Swaps encoded as paired moves may make
    # an individual subset invalid; validation then omits it without routing.
    singles=[]
    if len(operations)>1:
        for op in operations:
            proposal={**seed_proposal,"operations":[copy.deepcopy(op)],
                      "rationale":"Single internal member of the selected spatial seed."}
            try:search.validate_proposal(proposal,candidate,lock_io=True)
            except ValueError:continue
            singles.append(proposal)
        singles.sort(key=lambda p:(placement_metrics(search.apply_positions(candidate,p["operations"]))["manhattan_edges"],
                                   p["operations"][0]["node"]))
    if singles:offer(singles[0],"single_member")
    # Half-displacement joint move leaves more routing space than the full seed.
    old={n["id"]:(n["x"],n["y"]) for n in candidate["nodes"]}
    half=[]
    for op in operations:
        if op["op"]!="move":continue
        initial=old[op["node"]]
        dest=[a+(1 if b>a else -1)*max(1,abs(b-a)//2) if a!=b else a
              for a,b in zip(initial,op["to"])]
        if tuple(dest)!=initial:half.append({"op":"move","node":op["node"],"to":dest})
    if half:offer({**seed_proposal,"operations":half,"rationale":"Reduced displacement inside the selected spatial seed."},"reduced_displacement")
    # Another complete edge order is a separate, budgeted candidate.
    offer({**seed_proposal,"routing_order":sorted(copy.deepcopy(candidate["edges"])),
           "rationale":"The exact seed geometry with ascending directed-edge priority."},"explicit_alternate_order")
    for proposal in singles[1:2]:offer(proposal,"single_member")
    members={op["node"] for op in operations if op["op"]=="move"}
    adjacent=sorted(pool,key=lambda e:(
        e["features"]["region_id"]!=seed["features"]["region_id"],
        -len(members & {op["node"] for op in e["operations"]}),
        e["features"]["placement_proxy"]["manhattan_edges"],e["id"]))
    for entry in adjacent:
        # Stay in the selected region or touch its chosen nodes.
        if entry["features"]["region_id"]==seed["features"]["region_id"] or members & {op["node"] for op in entry["operations"]}:
            offer(proposal_from_entry(entry),"spatial_neighbor")
    for proposal in singles[2:]:offer(proposal,"single_member")
    return result


def select_next(best_candidate,best_metrics,best_clock,certified,expanded_states):
    """Monotone retained solution; a separate certified state may explore a plateau."""
    certified=[row for row in certified if row.get("status") == "certified"
               and row.get("certificates",{}).get("logic") == "equivalent"
               and all(row.get("certificates",{}).get(k) is True for k in ("clock","physical","interface"))]
    improving=[row for row in certified if search.pareto(best_metrics,row["metrics"])]
    if improving:
        chosen=min(improving,key=lambda r:(r["metrics"]["area_tiles"],r["metrics"]["qca_cells"],r["metrics"]["edge_steps"]))
        return chosen,"improved_retained"
    options=[r for r in certified if search.key(r["candidate"]) not in expanded_states
             and r["metrics"]["area_tiles"]<=best_metrics["area_tiles"]*1.1
             and r["metrics"]["qca_cells"]<=best_metrics["qca_cells"]*1.1]
    if options:
        chosen=min(options,key=lambda r:(
            r["metrics"]["area_tiles"]/best_metrics["area_tiles"]+
            r["metrics"]["qca_cells"]/best_metrics["qca_cells"],
            placement_metrics(r["candidate"])["manhattan_edges"]))
        return chosen,"certified_exploration"
    return {"candidate":best_candidate,"metrics":best_metrics,"clock":best_clock},"retain_best"

