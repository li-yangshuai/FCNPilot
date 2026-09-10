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


def context_for(candidate,metrics,clock,history,density,menu,round_number,batch_size,best_metrics):
    context=search.context_for(candidate,metrics,clock,history,lock_io=True)
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
        "The best retained result never regresses. A separately recorded certified exploration "
        "state can temporarily increase area/cells by at most 10% relative to that best result.")
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

