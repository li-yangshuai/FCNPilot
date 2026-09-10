"""Auditable, bounded model-guided placement experiments over certified layouts.

Models propose coordinates only. The existing parser, router, clock solver and
physical exporter are the sole executors and all acceptance gates stay mandatory.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import time
import uuid

from ifcn_agent_clock_validation import read_clock_layout, clock_arrival_report, validate_clock_arrivals
from ifcn_agent_layout_validation import export_native_ifcn

SCHEMA = "ifcn.layout_optimization.v1"
POLICIES = ("llm", "random", "noop", "heuristic")
CERTIFICATES = {"clock_arrival":"cycle_zero_at_template_phase_passed",
                "physical_routes":"source_isolation_and_ordered_paths_passed"}

def bounds(candidate):
    used = [tuple(p) for route in candidate["routes"] for p in route["path"]]
    used += [(n["x"],n["y"]) for n in candidate["nodes"]]
    return {"min_x":max(0,min(p[0] for p in used)-2),"max_x":max(p[0] for p in used)+2,
            "min_y":max(0,min(p[1] for p in used)-2),"max_y":max(p[1] for p in used)+2}

def origin(candidate):
    used = [tuple(p) for r in candidate["routes"] for p in r["path"]]
    used += [(n["x"],n["y"]) for n in candidate["nodes"]]
    return [min(p[0] for p in used),min(p[1] for p in used)]

def validate_proposal(proposal, candidate, allow_noop=False):
    if not isinstance(proposal,dict) or proposal.get("schema") != "ifcn.layout_edit.v1":
        raise ValueError("Unknown placement proposal schema")
    if set(proposal)-{"schema","operations","rationale"}:
        raise ValueError("Unknown placement proposal fields")
    operations = proposal.get("operations")
    if not isinstance(operations,list) or not (0 if allow_noop else 1) <= len(operations) <= 3:
        raise ValueError("A proposal must contain 1..3 operations (zero only for reroute control)")
    if not isinstance(proposal.get("rationale",""),str) or len(proposal.get("rationale","")) > 4000:
        raise ValueError("Invalid proposal rationale")
    nodes={n["id"]:(n["x"],n["y"]) for n in candidate["nodes"]}
    box=bounds(candidate); touched=set()
    for op in operations:
        if not isinstance(op,dict):
            raise ValueError("Malformed operation")
        if op.get("op")=="move" and set(op)=={"op","node","to"}:
            ids=[op["node"]]; dest=op["to"]
            if not isinstance(dest,list) or len(dest)!=2 or any(type(v) is not int for v in dest):
                raise ValueError("Coordinates must be two integers")
            if not box["min_x"]<=dest[0]<=box["max_x"] or not box["min_y"]<=dest[1]<=box["max_y"]:
                raise ValueError("Move lies outside the declared action space")
            if nodes.get(ids[0])==tuple(dest):
                raise ValueError("A move must change its node position")
        elif op.get("op")=="swap" and set(op)=={"op","nodes"} and isinstance(op["nodes"],list) and len(op["nodes"])==2:
            ids=op["nodes"]
            if ids[0]==ids[1]:
                raise ValueError("A swap needs two distinct nodes")
        else:
            raise ValueError("Only bounded move and swap operations are allowed")
        if any(type(n) is not int or n not in nodes or n in touched for n in ids):
            raise ValueError("Unknown or repeated node identity")
        touched.update(ids)
    return proposal

def control_proposal(candidate, policy, seed):
    rng=random.Random(seed)
    nodes={n["id"]:(n["x"],n["y"]) for n in candidate["nodes"]}
    box=bounds(candidate)
    proposal={"schema":"ifcn.layout_edit.v1","operations":[],"rationale":""}
    if policy=="noop":
        proposal["rationale"]="Reroute the unchanged placement using the identical executor."
        return proposal
    edges=[tuple(e) for e in candidate["edges"]]
    def proxy(positions):
        xs,ys=zip(*positions.values())
        return ((max(xs)-min(xs)+1)*(max(ys)-min(ys)+1),
                sum(abs(positions[a][0]-positions[b][0])+abs(positions[a][1]-positions[b][1]) for a,b in edges))
    if policy=="random":
        available=list(nodes)
        for _ in range(rng.randint(1,min(3,len(nodes)))):
            node=rng.choice(available);available.remove(node)
            free=[(x,y) for x in range(box["min_x"],box["max_x"]+1)
                  for y in range(box["min_y"],box["max_y"]+1) if (x,y) not in nodes.values()]
            if not free:break
            destination=rng.choice(free);nodes[node]=destination
            proposal["operations"].append({"op":"move","node":node,"to":list(destination)})
        proposal["rationale"]="Seeded uniform non-overlapping moves in the same bounded coordinate space."
    else:
        used=set()
        for _ in range(min(3,len(nodes))):
            best=None; baseline=proxy(nodes)
            for node in sorted(nodes):
                if node in used:continue
                for x in range(box["min_x"],box["max_x"]+1):
                    for y in range(box["min_y"],box["max_y"]+1):
                        if (x,y) in nodes.values():continue
                        trial=dict(nodes);trial[node]=(x,y);score=proxy(trial)
                        if score < baseline and (best is None or (score,node,x,y) < best):
                            best=(score,node,x,y)
            if best is None:break
            _,node,x,y=best;nodes[node]=(x,y);used.add(node)
            proposal["operations"].append({"op":"move","node":node,"to":[x,y]})
        # A control with no proxy-improving move submits a valid swap. It still
        # uses one validator evaluation, rather than silently gaining retries.
        if not proposal["operations"]:
            proposal["operations"]=[{"op":"swap","nodes":sorted(nodes)[:2]}]
        proposal["rationale"]="Deterministic greedy node-box area, then Manhattan edge-length proxy; no LLM."
    return proposal

def assert_graph_identity(candidate, dag):
    """Bind unlisted legacy snapshots to the independently certified routed DAG."""
    def identity(graph):
        nodes=graph.get("nodes",[]); edges=graph.get("edges",[])
        if not nodes or any(type(n.get("id")) is not int for n in nodes):
            raise ValueError("Snapshot has malformed node identities")
        ids=[n["id"] for n in nodes]
        if len(set(ids))!=len(ids):
            raise ValueError("Snapshot has duplicate node identities")
        if any(not isinstance(e,list) or len(e)!=2 or any(type(v) is not int or v not in ids for v in e) for e in edges):
            raise ValueError("Snapshot has malformed graph edges")
        pairs=[tuple(e) for e in edges]
        if len(set(pairs))!=len(pairs):
            raise ValueError("Snapshot has duplicate graph edges")
        return ({n["id"]:tuple(n.get(k) for k in ("name","type","is_input","is_output")) for n in nodes},set(pairs))
    if identity(candidate)!=identity(dag):
        raise ValueError("Native snapshot disagrees with certified routed DAG gate/port identities or edges")
    routes=[(r.get("source"),r.get("target")) for r in candidate.get("routes",[])]
    if len(routes)!=len(set(routes)) or set(routes)!={tuple(e) for e in dag["edges"]}:
        raise ValueError("Native snapshot route coverage disagrees with certified routed DAG")

def node_delta(before, after):
    a={n["id"]:n for n in before["nodes"]};b={n["id"]:n for n in after["nodes"]}
    if set(a)!=set(b) or {tuple(e) for e in before["edges"]}!={tuple(e) for e in after["edges"]}:
        raise ValueError("Executor changed the logical graph")
    assert_graph_identity(after,before)
    changes=[]
    for key,n in a.items():
        if any(n.get(k)!=b[key].get(k) for k in ("name","type","is_input","is_output")):
            raise ValueError("Executor changed a gate or port identity")
        old,new=[n["x"],n["y"]],[b[key]["x"],b[key]["y"]]
        if old!=new:changes.append({"node_id":key,"name":n["name"],"from":old,"to":new})
    return changes

def assert_requested_moves(proposal, before, after):
    expected={n["id"]:[n["x"],n["y"]] for n in before["nodes"]}
    for operation in proposal["operations"]:
        if operation["op"]=="move":expected[operation["node"]]=operation["to"]
        else:
            a,b=operation["nodes"];expected[a],expected[b]=expected[b],expected[a]
    if expected!={n["id"]:[n["x"],n["y"]] for n in after["nodes"]}:
        raise ValueError("Executor moved nodes beyond the recorded proposal")
    return node_delta(before,after)

def choose_node(root):
    candidates=[os.environ.get("IFCN_NODE"),shutil.which("node")]
    candidates += [str(p) for p in sorted((Path.home()/".nvm/versions/node").glob("*/bin/node"),reverse=True)]
    for name in dict.fromkeys(n for n in candidates if n):
        try:
            major=int(subprocess.check_output([name,"--version"],text=True,timeout=3).strip().lstrip("v").split(".")[0])
            if major>=22:return str(Path(name).resolve())
        except (ValueError,OSError,subprocess.SubprocessError):pass
    raise ValueError("Layout proposals require the existing Node 22+ runtime")

def create_run(api,args,base):
    if not 1<=args.rounds<=8 or not 1<=args.candidate_timeout<=120 or not 1<=args.model_timeout<=120:
        raise ValueError("Use 1..8 rounds, 1..120 s candidate/model timeouts")
    if bool(args.provider)!=bool(args.model_id):
        raise ValueError("Model selection requires both provider and model id")
    source_path=api.run_path(base,args.run_id); baseline=api.load_run(source_path)
    api.verify_artifacts(source_path,baseline)
    if baseline.get("design_type")!="combinational" or any(baseline.get("validation",{}).get(k)!=v for k,v in CERTIFICATES.items()):
        raise ValueError("Optimization requires a certified combinational baseline with current clock and physical checks")
    if baseline.get("validation",{}).get("rtl_equivalence") != "exhaustive_scalar_source_vs_routed_dag":
        raise ValueError("Pilot optimization requires exhaustive source/DAG equivalence evidence")
    algorithm=baseline.get("metrics",{}).get("pnr",{}).get("algorithm")
    if algorithm not in ("compact","june_random") or baseline.get("metrics",{}).get("pnr",{}).get("clock_scheme")!="irregular":
        raise ValueError("This placement-edit experiment supports only existing irregular-clock native layouts; no silent clock-family switch")
    config=api.configuration()
    if not (Path(config["build_dir"])/"ifcn_layout_edit").is_file():
        raise ValueError("Build the ifcn_layout_edit target before starting optimization")
    node=choose_node(api.ROOT)
    get=lambda name:api.artifact_path(source_path,baseline["artifacts"][name])
    if not validate_clock_arrivals(get("layout.ifcn").read_text(),json.loads(get("routed_dag.json").read_text()))["passed"]:
        raise ValueError("The actual baseline IFCN fails current absolute clock arrival validation")
    qca=get("device.qca" if "device.qca" in baseline["artifacts"] else "validated_device.qca")
    physical=json.loads(get("physical.json").read_text())
    if physical.get("qca_sha256")!=api.digest(qca) or physical.get("ifcn_sha256")!=api.digest(get("layout.ifcn")):
        raise ValueError("Baseline physical certificate is not bound to its actual IFCN/QCA")
    candidate_file=(get("layout_candidate.json") if "layout_candidate.json" in baseline["artifacts"]
                    else get("layout.ifcn").parent/"layout_candidate.json")
    # Older certified runs predate registration of the native snapshot. Verify
    # it against the certified serialized layout before copying it, never trust
    # an unlisted sibling merely because its filename looks right.
    candidate=json.loads(candidate_file.read_text())
    assert_graph_identity(candidate,json.loads(get("routed_dag.json").read_text()))
    if len(candidate.get("nodes",[]))>50 or len(candidate.get("routes",[]))>100:
        raise ValueError("Pilot optimization is limited to 50 nodes and 100 routes")
    identifier=uuid.uuid4().hex;path=api.run_path(base,identifier);path.mkdir(mode=0o700)
    saved=path/"baseline";saved.mkdir()
    export_native_ifcn(candidate,saved/"candidate_check.ifcn",algorithm)
    if read_clock_layout((saved/"candidate_check.ifcn").read_text())!=read_clock_layout(get("layout.ifcn").read_text()):
        raise ValueError("Native snapshot disagrees with certified IFCN nodes, routes or phases")
    manifest={"schema":api.SCHEMA,"run_id":identifier,"created_at":api.now(),"updated_at":api.now(),
              "status":"created","source":baseline["source"],"design_type":"combinational",
              "configuration":config,"frontend":copy.deepcopy(baseline["frontend"]),
              "parameters":{**baseline["parameters"],"algorithm":algorithm,"clock_scheme":"irregular","seed":args.seed,
                            "timeout_s":args.candidate_timeout},
              "requested_until":"map","current_stage":None,
              "stages":{"parse":{"status":"completed","source_run_id":args.run_id}},
              "artifacts":{},"metrics":{},"validation":{},
              "optimization":{"status":"pending","policy":args.policy,"rounds":args.rounds,"seed":args.seed,
                              "candidate_timeout_s":args.candidate_timeout,"model_timeout_s":args.model_timeout,
                              "node":node,"source_run_id":args.run_id,
                              "model":({"provider":args.provider,"modelId":args.model_id} if args.provider else None)}}
    for name in ("source.v","normalized.v","dag.json","routed_dag.json","layout.ifcn","clock.json","physical.json","interface.json","logic.json"):
        shutil.copyfile(get(name),saved/name)
        api.register_artifact(path,manifest,"baseline/"+name,saved/name)
        api.register_artifact(path,manifest,name,saved/name)
    shutil.copyfile(qca,saved/"device.qca")
    for name in ("baseline/device.qca","validated_device.qca","device.qca"):api.register_artifact(path,manifest,name,saved/"device.qca")
    api.write_json(saved/"layout_candidate.json",candidate)
    for name in ("baseline/layout_candidate.json","layout_candidate.json"):api.register_artifact(path,manifest,name,saved/"layout_candidate.json")
    pnr=copy.deepcopy(baseline["metrics"]["pnr"]);pnr["ifcn"]=str(saved/"layout.ifcn")
    api.write_json(saved/"pnr.json",pnr)
    for name in ("baseline/pnr.json","pnr.json"):api.register_artifact(path,manifest,name,saved/"pnr.json")
    manifest["metrics"]={k:copy.deepcopy(baseline["metrics"][k]) for k in ("dag","logic","mapping","device_interface","clock_arrival","physical_routes") if k in baseline["metrics"]}
    manifest["metrics"]["pnr"]=pnr
    manifest["validation"]=copy.deepcopy(baseline["validation"])
    snapshot={"source_run_id":args.run_id,"layout_artifact":"baseline/layout.ifcn","candidate_artifact":"baseline/layout_candidate.json",
              "origin":origin(candidate),"metrics":{"area_tiles":pnr["area_tiles"],"qca_cells":physical["cell_count"]},
              "validation":{"clock_arrival":True,"physical_routes":True,"rtl_equivalence":baseline["validation"]["rtl_equivalence"]}}
    campaign={"schema":SCHEMA,"id":identifier,"status":"pending","policy":args.policy,"goal":"pareto_area_qca",
              "budget":{"rounds":args.rounds,"candidate_timeout_s":args.candidate_timeout,"model_timeout_s":args.model_timeout},
              "baseline":snapshot,"selected":copy.deepcopy(snapshot),"selected_round":None,"rounds":[],
              "action_space":{"max_operations":3,"padding":2,"port_identities_fixed":True,"port_positions_fixed":False},
              "attribution":"The model proposes bounded coordinates only. Routing and any clock repair are deterministic executors. Accepted means all certificates passed and both area and actual QCA count are non-increasing with a strict improvement. No-op and non-LLM policies use the same baseline and validation budget. LLM latency and tokens are reported separately; equal evaluation count does not mean equal wall-clock cost."}
    # Freeze the implementation used by this pilot, including uncommitted code.
    code_dir=path/"implementation";code_dir.mkdir()
    sources=[*api.ROOT.joinpath("scripts").glob("*.py"),
             api.ROOT.parent/"integrations/pi/layout-proposer.mjs",
             api.ROOT/"src/app/ifcn_layout_edit.cpp",api.ROOT/"include/autopr/graph/circuitGraph.cpp",
             api.ROOT/"include/autopr/graph/circuitGraph.h",api.ROOT/"src/app/ifcn_energy_analysis.cpp"]
    fingerprints={}
    for source in sources:
        if not source.is_file():continue
        relative=source.relative_to(api.ROOT.parent);target=code_dir/relative;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,target);fingerprints[str(relative)]=api.digest(target)
    binaries={name:api.digest(Path(config["build_dir"])/name) for name in ("ifcn_layout_edit","ifcn_mapping_metrics","ifcn_energy_analysis")}
    environment={"schema":"ifcn.optimization.environment.v1","source_run_id":args.run_id,
                 "source_sha256":baseline["artifacts"]["source.v"]["sha256"],"clock_scheme":"irregular",
                 "python":config["python"],"driver_python":sys.version,"node":node,
                 "source_files":fingerprints,"binaries":binaries,
                 "git_head":subprocess.check_output(["git","rev-parse","HEAD"],cwd=api.ROOT,text=True).strip(),
                 "dirty_checkout":True,"source_snapshot":"implementation/"}
    api.write_json(path/"environment.json",environment);api.register_artifact(path,manifest,"environment.json",path/"environment.json")
    api.write_json(path/"campaign.json",campaign);api.register_artifact(path,manifest,"campaign.json",path/"campaign.json")
    api.write_json(path/"manifest.json",manifest)
    return api.start_worker(path,"map")

def snapshot_from_target(api,path,manifest,target,candidate,summary=None,valid=False):
    layout=target/"layout.ifcn"
    return {"layout_artifact":str(layout.relative_to(path)) if layout.is_file() else None,
            "candidate_artifact":str((target/"layout_candidate.json").relative_to(path)),
            "origin":origin(candidate),"metrics":({"area_tiles":summary["area_tiles"],"qca_cells":summary["qca_cells"]} if summary else None),
            "validation":({"clock_arrival":True,"physical_routes":True,"rtl_equivalence":"exhaustive_scalar_source_vs_routed_dag"} if valid else None)}

def register_tree(api,path,manifest,target):
    for file in sorted(target.rglob("*")):
        if file.is_file() and file.stat().st_size and file.suffix in (".json",".ifcn",".qca",".log",".txt",".v"):
            api.register_artifact(path,manifest,str(file.relative_to(path)),file)

def checkpoint(api,path,manifest,campaign):
    manifest["updated_at"]=api.now()
    api.write_json(path/"campaign.json",campaign)
    api.register_artifact(path,manifest,"campaign.json",path/"campaign.json")
    api.write_json(path/"manifest.json",manifest)

def context_for(candidate,snapshot,campaign):
    return {"dag":{"nodes":[{k:n[k] for k in ("id","name","type","is_input","is_output")} for n in candidate["nodes"]],
                   "edges":candidate["edges"]},
            "placement":{"nodes":[{k:n[k] for k in ("id","x","y")} for n in candidate["nodes"]]},
            "routes":candidate["routes"],"metrics":snapshot["metrics"],
            "rules":{"clock_scheme":"irregular","phase_count":4,"input_launch":"cycle_zero_at_own_phase",
                     "dag_and_port_identities_fixed":True,"four_connected_routes":True,
                     "max_consecutive_same_phase_tiles":4 if candidate["algorithm"]=="compact" else 10,
                     "max_same_phase_step_fraction":None if candidate["algorithm"]=="compact" else 0.3,
                     "physical_net_isolation_and_gate_ports_required":True,
                     "objective":"Reduce gate grid area and actual QCA cells without increasing either.",
                     "acceptance":"Only exact proposed node coordinates change; all routes and phases are freshly validated."},
            "feedback":[{"round":r["id"],"proposal":r.get("proposal",{}).get("operations"),
                         "outcome":r.get("acceptance"),"candidate_metrics":r.get("execution",{}).get("candidate",{}).get("metrics")}
                        for r in campaign["rounds"][-3:]],
            "action_space":{"movable_node_ids":[n["id"] for n in candidate["nodes"]],
                            "coordinate_bounds":bounds(candidate),"max_operations":3}}

def run_worker(api,path,fd):
    manifest=api.load_run(path);campaign=json.loads((path/"campaign.json").read_text())
    config=manifest["configuration"];settings=manifest["optimization"]
    manifest.update(status="running",worker_pid=os.getpid(),current_stage="pnr")
    log=path/"optimization.log";log.touch(exist_ok=True)
    manifest["stages"]["pnr"]={"status":"running","log":"optimization.log","started_at":api.now()}
    campaign["status"]="running";settings["status"]="running"
    try:
        api.verify_artifacts(path,manifest)
        if manifest["requested_until"]!="map":
            raise ValueError("Complete this optimization through map before requesting downstream simulation")
        # An interrupted paid request is retained, not silently repeated.
        for row in campaign["rounds"]:
            if row.get("status") not in ("accepted","rejected","failed","cancelled"):
                row.update(status="cancelled",acceptance={"status":"cancelled","reasons":["Worker interrupted before a completed evaluation; this round is not retried"]})
                register_tree(api,path,manifest,path/"rounds"/f"{row['id']:02d}")
        checkpoint(api,path,manifest,campaign)
        for index in range(len(campaign["rounds"])+1,settings["rounds"]+1):
            if api.STOP or (path/"cancel.request").exists():raise InterruptedError("Cancellation requested")
            selected=campaign["selected"];start=copy.deepcopy(selected)
            candidate=json.loads(api.artifact_path(path,manifest["artifacts"][selected["candidate_artifact"]]).read_text())
            target=path/"rounds"/f"{index:02d}";target.mkdir(parents=True)
            row={"id":index,"status":"proposing","start":start,
                 "execution":{"executor":"native placement edit + deterministic routing + bounded clock repair + independent certificates",
                              "actual_moves":[],"rerouted_edges":[],"automatic_changes":{},"logs":[]}}
            campaign["rounds"].append(row);begin=time.monotonic()
            checkpoint(api,path,manifest,campaign)
            try:
                if settings["policy"]=="llm":
                    payload={"request_id":f"{manifest['run_id']}:{index}","timeout_ms":settings["model_timeout_s"]*1000,
                             "max_tokens":1200,"context":context_for(candidate,start,{**campaign,"rounds":campaign["rounds"][:-1]})}
                    if settings.get("model"):payload["model"]=settings["model"]
                    api.write_json(target/"request.json",payload)
                    api.register_artifact(path,manifest,str((target/"request.json").relative_to(path)),target/"request.json")
                    request_error=None
                    try:
                        api.execute([settings["node"],api.ROOT.parent/"integrations/pi/layout-proposer.mjs"],
                                    path,"pnr",manifest,timeout_s=settings["model_timeout_s"]+3,
                                    input_path=target/"request.json",output_path=target/"response.json")
                    except InterruptedError:
                        raise
                    except Exception as exc:
                        request_error=exc
                    if not (target/"response.json").is_file() or not (target/"response.json").stat().st_size:
                        raise request_error or ValueError("Model returned no audit response")
                    audit=json.loads((target/"response.json").read_text())
                    row["proposal"]={"source":"llm","request_artifact":str((target/"request.json").relative_to(path)),
                                     "response_artifact":str((target/"response.json").relative_to(path)),
                                     "model":audit.get("model"),"usage":audit.get("usage"),"latency_ms":audit.get("latency_ms")}
                    if audit.get("status")!="ok" or request_error:
                        raise ValueError("Model proposal rejected: "+json.dumps(audit.get("error",audit.get("status")),ensure_ascii=False))
                    proposal=audit["proposal"]
                else:
                    proposal=control_proposal(candidate,settings["policy"],settings["seed"]*1000+index)
                    row["proposal"]={"source":settings["policy"]}
                validate_proposal(proposal,candidate,allow_noop=settings["policy"]=="noop")
                api.write_json(target/"proposal.json",proposal)
                row["proposal"].update(artifact=str((target/"proposal.json").relative_to(path)),
                                       operations=proposal["operations"],rationale=proposal.get("rationale",""))
                row["status"]="evaluating";checkpoint(api,path,manifest,campaign)
                eval_started=time.monotonic();deadline=eval_started+settings["candidate_timeout_s"]
                api.execute([config["python"],config["backend"],"pnr","--input",api.artifact_path(path,manifest["artifacts"]["normalized.v"]),
                             "--output",target,"--algorithm",manifest["parameters"]["algorithm"],"--clock","irregular",
                             "--budget",max(1,settings["candidate_timeout_s"]-2),
                             "--edit-baseline",api.artifact_path(path,manifest["artifacts"][selected["candidate_artifact"]]),
                             "--edit-proposal",target/"proposal.json"],path,"pnr",manifest,timeout_s=max(.1,deadline-time.monotonic()))
                summary=json.loads((target/"pnr.json").read_text());api.check_pnr(summary)
                if summary.get("algorithm")!=manifest["parameters"]["algorithm"] or summary.get("clock_scheme")!="irregular":
                    raise ValueError("Edited layout changed the locked algorithm or clock family")
                after=json.loads((target/"layout_candidate.json").read_text())
                row["execution"]["actual_moves"]=assert_requested_moves(proposal,candidate,after)
                before_routes={(r["source"],r["target"]):r["path"] for r in candidate["routes"]}
                row["execution"]["rerouted_edges"]=[{"source":r["source"],"target":r["target"],
                    "before_length":len(before_routes[(r["source"],r["target"])])-1,"after_length":len(r["path"])-1}
                    for r in after["routes"] if r["path"]!=before_routes[(r["source"],r["target"])]]
                old_phases={(c["x"],c["y"]):c["phase"] for c in candidate["cells"]}
                row["execution"]["automatic_changes"]={"phase_repaired":bool(summary.get("phase_repair")),
                    "phase_changed_tiles":sum(old_phases.get((c["x"],c["y"]))!=c["phase"] for c in after["cells"]),"topology_changed":False}
                logic=api.logic_report(api.artifact_path(path,manifest["artifacts"]["source.v"]),target/"routed_dag.json",target/"logic.json")
                if logic["status"]!="equivalent":
                    raise ValueError("This pilot requires exhaustive source/DAG equivalence, not an unverified input-limit result")
                clock=clock_arrival_report(target/"layout.ifcn",target/"routed_dag.json",target/"clock.json")
                left=deadline-time.monotonic()
                if left<=0:raise TimeoutError("Candidate budget exhausted before physical export")
                api.execute([config["energy_binary"],target/"layout.ifcn",target/"device","--qca-only"],
                            path,"pnr",manifest,timeout_s=left)
                qca=target/"device_energy_input.qca"
                interface=api.qca_interface_report(qca,manifest["frontend"],target/"interface.json")
                physical=api.physical_route_report(target/"device_physical_validation.json",qca,interface,target/"physical.json",target/"layout.ifcn")
                summary["qca_cells"]=interface["cell_count"]
                snapshot=snapshot_from_target(api,path,manifest,target,after,summary,True)
                row["execution"]["candidate"]=snapshot
                a,b=snapshot["metrics"],start["metrics"]
                accepted=a["area_tiles"]<=b["area_tiles"] and a["qca_cells"]<=b["qca_cells"] and a!=b
                row["status"]="accepted" if accepted else "rejected"
                row["acceptance"]={"status":row["status"],"reasons":["Strict Pareto improvement after all certificates" if accepted else "Requires both objectives non-increasing and at least one strictly improved"]}
                if accepted:
                    for name,file in [("layout.ifcn","layout.ifcn"),("layout_candidate.json","layout_candidate.json"),
                                      ("pnr.json","pnr.json"),("routed_dag.json","routed_dag.json"),("logic.json","logic.json"),
                                      ("clock.json","clock.json"),("physical.json","physical.json"),("interface.json","interface.json"),
                                      ("validated_device.qca","device_energy_input.qca"),("device.qca","device_energy_input.qca")]:
                        api.register_artifact(path,manifest,name,target/file)
                    manifest["metrics"].update(pnr=summary,mapping={"cell_count":a["qca_cells"],"io_contraction":False},
                                               device_interface=interface,clock_arrival=clock,physical_routes=physical)
                    api.record_logic(manifest,logic)
                    campaign["selected"]=snapshot;campaign["selected_round"]=index
            except InterruptedError:
                row.update(status="cancelled",acceptance={"status":"cancelled","reasons":["Cancellation requested"]})
                raise
            except Exception as exc:
                row.update(status="failed",acceptance={"status":"failed","reasons":[str(exc)[-2500:]]})
                if (target/"layout_candidate.json").is_file():
                    try:
                        failed=json.loads((target/"layout_candidate.json").read_text())
                        row["execution"]["actual_moves"]=node_delta(candidate,failed)
                        row["execution"]["candidate"]=snapshot_from_target(api,path,manifest,target,failed)
                    except (ValueError,KeyError,TypeError):pass
            finally:
                row["elapsed_s"]=time.monotonic()-begin
                row["execution"]["logs"]=[str(f.relative_to(path)) for f in target.glob("*.log")]
                register_tree(api,path,manifest,target)
                checkpoint(api,path,manifest,campaign)
        if api.STOP or (path/"cancel.request").exists():raise InterruptedError("Cancellation requested")
        settings["status"]="completed";campaign["status"]="completed"
        manifest["stages"]["pnr"].update(status="completed",completed_at=api.now())
        manifest["stages"]["map"]={"status":"completed","completed_at":api.now(),"note":"Selected certified QCA is preserved verbatim"}
        manifest.update(status="completed",error=None)
    except Exception as exc:
        state="cancelled" if isinstance(exc,InterruptedError) else "failed"
        campaign["status"]=state;settings["status"]=state
        manifest.update(status=state,error=str(exc))
        manifest["stages"]["pnr"].update(status=state,error=str(exc))
    finally:
        manifest["metrics"]["optimization"]={"policy":settings["policy"],"rounds":len(campaign["rounds"]),
             "accepted":sum(r["status"]=="accepted" for r in campaign["rounds"]),
             "baseline":campaign["baseline"]["metrics"],"selected":campaign["selected"]["metrics"],
             "selected_round":campaign["selected_round"]}
        checkpoint(api,path,manifest,campaign)
        api.result_report(path,manifest)
        api.write_json(path/"manifest.json",manifest)
        os.close(fd)
