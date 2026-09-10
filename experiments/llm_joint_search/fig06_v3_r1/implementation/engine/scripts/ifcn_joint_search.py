"""LLM-guided joint placement/routing search with independently certified execution."""
from __future__ import annotations
import argparse, copy, hashlib, json, os, shutil, signal, subprocess, sys, time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
EXECUTION_ENV = {'IFCN_BUILD_DIR':str(ROOT/'engine/build'), 'IFCN_LAYOUT_EDIT':str(ROOT/'engine/build/ifcn_layout_edit'), 'IFCN_MAPPING_METRICS_EXE':str(ROOT/'engine/build/ifcn_mapping_metrics')}
sys.path.insert(0, str(ROOT/'engine/scripts'))
import ifcn_agent as api
from ifcn_agent_clock_validation import clock_arrival_report, read_clock_layout
from ifcn_agent_layout_validation import export_native_ifcn
from ifcn_layout_optimization import assert_graph_identity, assert_requested_moves
from ifcn_axis_compaction import cut_proposals, routed_extent, placement_metrics
from ifcn_layout_optimization import bounds

def save(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False)+'\n')

def invoke(command, out, deadline, name):
    remaining=deadline-time.monotonic()
    if remaining<=0: raise TimeoutError('Candidate budget exhausted before '+name)
    with (out/(name+'.log')).open('w') as log:
        process=subprocess.Popen([str(x) for x in command],cwd=out,env={**api.backend_environment(out),**EXECUTION_ENV},stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try: code=process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL);process.wait()
            raise TimeoutError('Candidate budget exhausted in '+name)
    if code: raise RuntimeError(name+' exited '+str(code)+'; '+(out/(name+'.log')).read_text(errors='replace')[-1400:])

def key(candidate):
    return tuple((n['id'],n['x'],n['y']) for n in sorted(candidate['nodes'],key=lambda n:n['id']))

def evaluate(start, proposal, target, source, normalized, frontend, config, timeout):
    validate_proposal(proposal,start)
    target.mkdir()
    save(target/'start.json',start);save(target/'proposal.json',proposal)
    begin=time.monotonic();deadline=begin+timeout
    row={'status':'failed','proposal':proposal,'start_sha256':api.digest(target/'start.json')}
    try:
        invoke([config['python'],config['backend'],'pnr','--input',normalized,'--output',target,'--algorithm',start['algorithm'],'--clock','irregular','--budget',max(1,timeout-2),'--edit-baseline',target/'start.json','--edit-proposal',target/'proposal.json'],target,deadline,'evaluation')
        summary=json.loads((target/'pnr.json').read_text());api.check_pnr(summary)
        if summary['algorithm']!=start['algorithm'] or summary['clock_scheme']!='irregular': raise ValueError('Clock family or native algorithm changed')
        after=json.loads((target/'layout_candidate.json').read_text())
        row['moves']=assert_requested_moves(proposal,start,after)
        routing=after.get('edit',{})
        row['routing_audit']={k:routing.get(k) for k in ['requested_order','executed_order','route_order_attempts','fallback_used','explicit_routing_order']}
        if routing.get('requested_order')!=proposal['routing_order'] or routing.get('executed_order')!=proposal['routing_order'] or type(routing.get('route_order_attempts')) is not int or routing.get('route_order_attempts')!=1 or routing.get('fallback_used') is not False or routing.get('explicit_routing_order') is not True:
            raise ValueError('Native execution did not honor the exact model/control route order')
        logic=api.logic_report(source,target/'routed_dag.json',target/'logic.json')
        if logic['status']!='equivalent': raise ValueError('No exhaustive source/DAG equivalence')
        clock=clock_arrival_report(target/'layout.ifcn',target/'routed_dag.json',target/'clock.json')
        invoke([config['energy_binary'],target/'layout.ifcn',target/'device','--qca-only'],target,deadline,'export')
        qca=target/'device_energy_input.qca'
        interface=api.qca_interface_report(qca,frontend,target/'interface.json')
        physical=api.physical_route_report(target/'device_physical_validation.json',qca,interface,target/'physical.json',target/'layout.ifcn')
        extent=routed_extent(after)
        if extent['area_tiles']!=summary['area_tiles']: raise ValueError('Routed bounds disagree with serialized layout area')
        row.update(status='certified',metrics={'width':summary['width'],'height':summary['height'],'area_tiles':summary['area_tiles'],'qca_cells':interface['cell_count'],'edge_steps':sum(len(r['path'])-1 for r in after['routes']), 'output_arrival_ticks':{str(n['id']):clock['arrival_tick_ranges'][str(n['id'])] for n in after['nodes'] if n['is_output']}},certificates={'logic':logic['status'],'clock':clock['passed'],'physical':physical['passed'],'interface':interface['passed']})
        if not all([clock['passed'],physical['passed'],interface['passed']]): raise ValueError('Certificate failed')
        if time.monotonic()>deadline: raise TimeoutError('Candidate budget exhausted during final certificate checks')
        old={(r['source'],r['target']):r['path'] for r in start['routes']}
        row['route_changes']=[{'source':r['source'],'target':r['target'],'before_steps':len(old[r['source'],r['target']])-1,'after_steps':len(r['path'])-1} for r in after['routes'] if old[r['source'],r['target']]!=r['path']]
    except Exception as e:
        row.update(status='failed',error=str(e))
        for name in ['layout_candidate.json','phase_repair.json','clock.json']:
            artifact=target/name
            if not artifact.exists(): continue
            try: data=json.loads(artifact.read_text())
            except (OSError,ValueError) as parse_error:
                row.setdefault('artifact_parse_errors',{})[name]=str(parse_error)
                continue
            if name=='layout_candidate.json':
                row['routing_audit']={k:data.get('edit',{}).get(k) for k in ['requested_order','executed_order','route_order_attempts','fallback_used','explicit_routing_order']}
                completed={(r['source'],r['target']) for r in data.get('routes',[])}
                row['unrouted_edges']=[e for e in start['edges'] if tuple(e) not in completed]
            else: row['phase_repair' if name=='phase_repair.json' else 'clock_diagnostics']=data
    row['elapsed_s']=time.monotonic()-begin
    save(target/'result.json',row)
    return row


def validate_proposal(proposal, candidate, max_operations=8):
    """Independent research contract: joint search always uses an explicit order."""
    if type(max_operations) is not int or not 1<=max_operations<=8: raise ValueError('Move limit must be an integer in 1..8')
    if not isinstance(proposal,dict) or set(proposal)!={'schema','operations','routing_order','rationale'} or proposal['schema']!='ifcn.layout_search.v2':
        raise ValueError('Expected the exact joint-search v2 schema')
    if not isinstance(proposal['rationale'],str) or not proposal['rationale'].strip() or len(proposal['rationale'])>1200:
        raise ValueError('A bounded observable design rationale is required')
    operations=proposal['operations']
    if not isinstance(operations,list) or not 0<=len(operations)<=max_operations: raise ValueError('Move budget exceeded')
    positions={n['id']:[n['x'],n['y']] for n in candidate['nodes']};touched=set();box=bounds(candidate)
    for op in operations:
        if not isinstance(op,dict):raise ValueError('Operation must be an object')
        if op.get('op')=='move' and set(op)=={'op','node','to'}:
            ids=[op['node']];dest=op['to']
            if type(op['node']) is not int or op['node'] not in positions:raise ValueError('Unknown node')
            if not isinstance(dest,list) or len(dest)!=2 or any(type(v) is not int for v in dest):raise ValueError('Integer destination required')
            if not (box['min_x']<=dest[0]<=box['max_x'] and box['min_y']<=dest[1]<=box['max_y']):raise ValueError('Move outside bounded action space')
            if positions[op['node']]==dest:raise ValueError('Move must change position')
            positions[op['node']]=list(dest)
        elif op.get('op')=='swap' and set(op)=={'op','nodes'}:
            ids=op['nodes']
            if not isinstance(ids,list) or len(ids)!=2 or any(type(n) is not int or n not in positions for n in ids) or ids[0]==ids[1]:raise ValueError('Swap needs distinct known nodes')
            positions[ids[0]],positions[ids[1]]=positions[ids[1]],positions[ids[0]]
        else:raise ValueError('Only exact moves or swaps are permitted')
        if any(n in touched for n in ids):raise ValueError('Node edited more than once')
        touched.update(ids)
    if len({tuple(p) for p in positions.values()})!=len(positions):raise ValueError('Node collision')
    order=proposal['routing_order'];edges={tuple(e) for e in candidate['edges']}
    if not isinstance(order,list) or any(not isinstance(e,list) or len(e)!=2 or any(type(n) is not int for n in e) for e in order) or len(order)!=len(edges) or {tuple(e) for e in order}!=edges:
        raise ValueError('Joint study requires a complete unique explicit DAG-edge order')
    return proposal

def apply_positions(candidate, operations):
    trial=copy.deepcopy(candidate);nodes={n['id']:n for n in trial['nodes']}
    for op in operations:
        if op['op']=='move':nodes[op['node']]['x'],nodes[op['node']]['y']=op['to']
        else:
            a,b=(nodes[n] for n in op['nodes'])
            a['x'],b['x']=b['x'],a['x'];a['y'],b['y']=b['y'],a['y']
    return trial

def control_order(candidate):
    """One fixed, fully disclosed routing order; no automatic portfolio retries."""
    nodes={n['id']:n for n in candidate['nodes']}
    layers={n:i for i,layer in enumerate(candidate.get('layers',[])) for n in layer}
    fanins=Counter(b for a,b in candidate['edges'])
    return [list(e) for e in sorted(candidate['edges'],key=lambda e:(-fanins[e[1]],layers.get(e[0],0),-(abs(nodes[e[0]]['x']-nodes[e[1]]['x'])+abs(nodes[e[0]]['y']-nodes[e[1]]['y'])),tuple(e)))]

def context_for(candidate, metrics, clock, history):
    nodes={n['id']:n for n in candidate['nodes']}
    extent=routed_extent(candidate)
    occupancy={}
    for r in candidate['routes']:
        for p in r['path']:occupancy.setdefault(tuple(p),set()).add(r['source'])
    features=[]
    for r in candidate['routes']:
        a,b=nodes[r['source']],nodes[r['target']]
        direct=abs(a['x']-b['x'])+abs(a['y']-b['y']);steps=len(r['path'])-1
        features.append({'edge':[r['source'],r['target']],'steps':steps,'manhattan_lower_bound':direct,'detour_steps':steps-direct,'multi_source_interior_sites':sum(len(occupancy[tuple(p)])>1 for p in r['path'][1:-1])})
    suggestions=[]
    for axis in ['x','y']:
        for proposal in cut_proposals(candidate,axes=(axis,),max_operations=8,max_shift=2)[:8]:
            trial=apply_positions(candidate,proposal['operations'])
            suggestions.append({'axis':axis,'operations':proposal['operations'],'placement_proxy':placement_metrics(trial),'description':proposal['rationale']})
    gaps={}
    for axis in ['x','y']:
        levels=sorted({n[axis] for n in nodes.values()})
        gaps[axis]=[{'level':level,'node_ids':[n['id'] for n in nodes.values() if n[axis]==level],'gap_from_previous':None if i==0 else level-levels[i-1]} for i,level in enumerate(levels)]
    return {'dag':{'nodes':[{k:n[k] for k in ['id','name','type','is_input','is_output']} for n in candidate['nodes']],'edges':candidate['edges'],'layers':candidate.get('layers',[])},
      'placement':{'nodes':[{k:n[k] for k in ['id','x','y']} for n in candidate['nodes']]},'routes':candidate['routes'],'metrics':metrics,
      'state_features':{'routed_extent':extent,'gate_levels':gaps,'route_costs':sorted(features,key=lambda f:-f['detour_steps']),'phase_map_native_1_based':candidate['cells'],'absolute_arrival_ticks':clock.get('arrival_tick_ranges',{}),'route_delay_ticks':clock.get('route_delays',[]),'geometric_cut_suggestions':suggestions,'suggestion_scope':'Optional unevaluated geometric actions only. You may propose other coordinated node moves, compress multiple layer gaps, or leave placement fixed to optimize routing order.'},
      'rules':{'clock_scheme':'irregular','phase_count':4,'input_launch':'cycle_zero_at_own_phase','dag_and_port_identities_fixed':True,'port_coordinates_movable':True,'four_connected_routes':True,'max_consecutive_same_phase_tiles':4 if candidate['algorithm']=='compact' else 10,'max_same_phase_step_fraction':None if candidate['algorithm']=='compact' else 0.3,'physical_net_isolation_and_gate_ports_required':True,'objective':'Reduce actual routed bounding area and exported QCA cells; both non-increasing, one strictly improved. Distinguish node-box proxy from actual routed area.','routing_execution':'The supplied complete routing_order is executed once by A*, with no order fallback. A failed candidate consumes the evaluation and returns diagnostics.','require_explicit_routing_order':True},
      'feedback':[{k:r.get(k) for k in ['round','status','decision','proposal','metrics','start_metrics','error','unrouted_edges','routing_audit','route_changes','phase_repair','clock_diagnostics']} for r in history[-4:]],
      'action_space':{'proposal_schema':'ifcn.layout_search.v2','movable_node_ids':list(nodes),'coordinate_bounds':bounds(candidate),'max_operations':8}}

def pareto(before, after):
    return after['area_tiles']<=before['area_tiles'] and after['qca_cells']<=before['qca_cells'] and (after['area_tiles']<before['area_tiles'] or after['qca_cells']<before['qca_cells'])
