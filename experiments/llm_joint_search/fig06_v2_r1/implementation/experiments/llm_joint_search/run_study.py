#!/usr/bin/env python3
"""Frozen case study of real Pi LLM decisions and exact joint P&R execution."""
from __future__ import annotations
import argparse,copy,hashlib,json,os,shutil,signal,subprocess,sys,time
from pathlib import Path
from datetime import datetime,timezone
from collections import Counter
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'engine/scripts'))
import ifcn_agent as api
import ifcn_joint_search as search
from ifcn_axis_compaction import cut_proposals,routed_extent
from ifcn_layout_optimization import assert_graph_identity,choose_node
from ifcn_agent_clock_validation import clock_arrival_report,read_clock_layout
from ifcn_agent_layout_validation import export_native_ifcn
save=search.save

def model_call(node,context,model,target,request_id):
    request={'request_id':request_id,'context':context,'model':model,'timeout_ms':60000,'max_tokens':2200}
    save(target/'request.json',request)
    begin=time.monotonic()
    with (target/'request.json').open('r') as inp,(target/'response.json').open('w') as out,(target/'model.log').open('w') as err:
        process=subprocess.Popen([node,str(ROOT/'integrations/pi/layout-proposer.mjs')],stdin=inp,stdout=out,stderr=err,start_new_session=True)
        try:code=process.wait(timeout=64)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL);process.wait()
            raise TimeoutError('Real model request exceeded deadline; not retried')
    if not (target/'response.json').stat().st_size: raise ValueError('Real model returned no audit response; not retried')
    audit=json.loads((target/'response.json').read_text())
    if code or audit.get('status')!='ok':raise ValueError('Model proposal failed: '+json.dumps(audit.get('error',{'status':audit.get('status')})))
    return audit,time.monotonic()-begin

def measure(candidate,physical,clock):
    box=routed_extent(candidate)
    return {k:box[k] for k in ['width','height','area_tiles']}|{'qca_cells':physical['cell_count'],'edge_steps':sum(len(r['path'])-1 for r in candidate['routes']),'output_arrival_ticks':{str(n['id']):clock['arrival_tick_ranges'][str(n['id'])] for n in candidate['nodes'] if n['is_output']}}

def run_policy(out,policy,baseline,initial,clock,inputs,frontend,config,node,model,rounds,timeout):
    current=copy.deepcopy(baseline);metrics=copy.deepcopy(initial);timing=copy.deepcopy(clock)
    rows=[];seen=set();selected=None;folder=out/policy;folder.mkdir()
    for i in range(1,rounds+1):
        target=folder/f'{i:02d}';target.mkdir()
        row={'round':i,'status':'failed','start_metrics':copy.deepcopy(metrics),'start_placement':search.key(current)}
        begin=time.monotonic()
        try:
            context=search.context_for(current,metrics,timing,rows)
            if policy=='llm_joint':
                audit,latency=model_call(node,context,model,target,f'{out.name}:{policy}:{i}')
                row.update(model=audit['model'],usage=audit.get('usage'),model_latency_s=latency)
                proposal=search.validate_proposal(audit['proposal'],current)
            else:
                choices=cut_proposals(current,max_operations=8,max_shift=2)
                options=[]
                for item in choices:
                    placed=search.apply_positions(current,item['operations'])
                    options.append({'schema':'ifcn.layout_search.v2','operations':item['operations'],'routing_order':search.control_order(placed),'rationale':'Deterministic cut proxy ranking and sink-pressure/layer/long-edge routing control.'})
                options.append({'schema':'ifcn.layout_search.v2','operations':[],'routing_order':search.control_order(current),'rationale':'Deterministic route-only control, no candidate pooling evaluations.'})
                proposal=None
                for option in options:
                    signature=(search.key(current),json.dumps(option,sort_keys=True))
                    if signature not in seen:proposal=option;seen.add(signature);break
                if proposal is None:
                    row.update(status='not_attempted',error='No untried control proposals remain')
                    rows.append(row);save(target/'result.json',row);break
            row['proposal']=proposal;save(target/'proposal.json',proposal)
            result=search.evaluate(current,proposal,target/'joint',inputs/'source.v',inputs/'normalized.v',frontend,config,timeout)
            row.update(result);row['round']=i
            if result['status']=='certified':row['status']='accepted' if search.pareto(metrics,result['metrics']) else 'rejected'
            # Counterfactuals share this exact incumbent and explicit single-pass
            # router budget. They never affect the live trajectory/model feedback.
            if policy=='llm_joint':
                placement=copy.deepcopy(proposal)
                placement['routing_order']=search.control_order(search.apply_positions(current,proposal['operations']))
                placement['rationale']='Paired placement-only ablation: exact model coordinates with the fixed deterministic single-pass routing order.'
                routing=copy.deepcopy(proposal);routing['operations']=[]
                routing['rationale']='Paired routing-only ablation: exact model route order with unchanged incumbent coordinates.'
                row['paired_ablations']={}
                for name,variant in [('placement_only',placement),('routing_only',routing)]:
                    counter=search.evaluate(current,variant,target/name,inputs/'source.v',inputs/'normalized.v',frontend,config,timeout)
                    if counter['status']=='certified':counter['status']='accepted' if search.pareto(metrics,counter['metrics']) else 'rejected'
                    save(target/name/'result.json',counter)
                    row['paired_ablations'][name]={'status':counter['status'],'metrics':counter.get('metrics'),'error':counter.get('error'),'routing_audit':counter.get('routing_audit')}
            if row['status']=='accepted':
                selected=i;current=json.loads((target/'joint/layout_candidate.json').read_text());metrics=row['metrics'];timing=json.loads((target/'joint/clock.json').read_text())
        except Exception as e:row.update(status='failed',error=str(e))
        row['elapsed_s']=time.monotonic()-begin
        rows.append(row);save(target/'result.json',row)
        report={'policy':policy,'status':'running','initial':initial,'selected':metrics,'selected_round':selected,'rounds':rows,'outcomes':dict(Counter(r['status'] for r in rows))}
        save(folder/'result.json',report)
        print(policy,i,row['status'],row.get('metrics',{}),flush=True)
    report={'policy':policy,'status':'completed','initial':initial,'selected':metrics,'selected_round':selected,'rounds':rows,'outcomes':dict(Counter(r['status'] for r in rows)),'round_budget':rounds,'rounds_recorded':len(rows)}
    save(folder/'result.json',report)
    return report

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',required=True)
    parser.add_argument('--rounds',type=int,default=8)
    args=parser.parse_args()
    if not 1<=args.rounds<=8:parser.error('rounds must be 1..8')
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
    origin=ROOT/'engine/output/pi-runs/d2f281ad36bb4d668a951cd364173a26'
    manifest=api.load_run(origin);api.verify_artifacts(origin,manifest)
    watched={str(p):api.digest(p) for p in origin.rglob('*') if p.is_file()}
    inputs=out/'inputs';inputs.mkdir()
    for name in ['source.v','normalized.v']:shutil.copy2(origin/'baseline'/name,inputs/name)
    for name in ['layout_candidate.json','routed_dag.json','layout.ifcn','physical.json','clock.json','device_energy_input.qca']:shutil.copy2(origin/'rounds/02'/name,inputs/name)
    baseline=json.loads((inputs/'layout_candidate.json').read_text());physical=json.loads((inputs/'physical.json').read_text())
    assert_graph_identity(baseline,json.loads((inputs/'routed_dag.json').read_text()))
    export_native_ifcn(baseline,inputs/'snapshot_check.ifcn',baseline['algorithm'])
    if read_clock_layout((inputs/'snapshot_check.ifcn').read_text())!=read_clock_layout((inputs/'layout.ifcn').read_text()):raise ValueError('Certified snapshot mismatch')
    clock=clock_arrival_report(inputs/'layout.ifcn',inputs/'routed_dag.json',inputs/'checked_clock.json')
    logic=api.logic_report(inputs/'source.v',inputs/'routed_dag.json',inputs/'checked_logic.json')
    if logic['status']!='equivalent' or not physical['passed'] or physical['qca_sha256']!=api.digest(inputs/'device_energy_input.qca') or physical['ifcn_sha256']!=api.digest(inputs/'layout.ifcn'):raise ValueError('Invalid starting certificate')
    metrics=measure(baseline,physical,clock)
    config=manifest['configuration'];timeout=manifest['optimization']['candidate_timeout_s'];node=choose_node(ROOT/'engine');model=manifest['optimization']['model']
    files=[Path(__file__),ROOT/'integrations/pi/layout-proposer.mjs',*sorted((ROOT/'engine/scripts').glob('*.py')),ROOT/'engine/src/app/ifcn_layout_edit.cpp',ROOT/'engine/include/autopr/graph/circuitGraph.cpp',ROOT/'engine/include/autopr/graph/circuitGraph.h']
    implementations={str(p):api.digest(p) for p in files}
    binaries={str(config[k]):api.digest(Path(config[k])) for k in ['energy_binary','mapping_binary']}
    binaries[str(ROOT/'engine/build/ifcn_layout_edit')]=api.digest(ROOT/'engine/build/ifcn_layout_edit')
    for file in files:
        dest=out/'implementation'/file.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,dest)
    save(out/'protocol.json',{'schema':'fcn.llm_joint_search.case_study.v2','created_at':datetime.now(timezone.utc).isoformat(),'case':'MAJ/1bitAdderMaj.v','starting_run':origin.name,'starting_round':2,'starting_metrics':metrics,'model':model,'rounds':args.rounds,'candidate_timeout_s':timeout,'model_timeout_s':60,'model_request_max_retries':0,'max_node_operations':8,'max_routing_order_attempts_per_candidate':1,'routing_fallback':False,'clock_rules':'Unchanged June/irregular: four phases; cycle-zero launch at PI own phase; <=10 same-phase tiles, <=30% hold steps; full QCA port/path/source/layer checks','live_acceptance':'Both actual routed area and exported QCA cells non-increasing; at least one strict; each failure retains incumbent','control':'Same initial layout and live evaluation count, deterministic cut proxy ranking with one sink-pressure/layer/long-edge routing order; no LLM. Model may also propose arbitrary bounded coordinated moves, so this control does not match candidate-generation expressiveness.','paired_ablations':'Every valid model proposal replayed from its same incumbent as placement-only/fixed order and routing-only/fixed placement. All execute a single explicit order within20s. Counterfactuals never influence live model feedback or selection.','scope':'One circuit, one adaptive trajectory per policy. Not a corpus comparison, novelty proof, or electrical waveform/power result. Not pooled with old v1 3-round studies.','execution_environment_overrides':search.EXECUTION_ENV,'python':sys.version,'implementation_hashes':implementations,'binary_hashes':binaries,'original_artifact_hashes':watched})
    reports={}
    for policy in ['deterministic_joint','llm_joint']:
        reports[policy]=run_policy(out,policy,baseline,metrics,clock,inputs,manifest['frontend'],config,node,model,args.rounds,timeout)
        save(out/'summary.json',reports)
    audit={'original_artifacts_unchanged':all(api.digest(Path(p))==h for p,h in watched.items()),'implementation_unchanged':all(api.digest(Path(p))==h for p,h in {**implementations,**binaries}.items()),'real_model_requests':len(list((out/'llm_joint').glob('*/request.json'))),'response_records':len(list((out/'llm_joint').glob('*/response.json'))),'artifact_hashes':{str(p.relative_to(out)):api.digest(p) for p in out.rglob('*') if p.is_file()}}
    save(out/'audit.json',audit)
    if not audit['original_artifacts_unchanged'] or not audit['implementation_unchanged']:raise ValueError('Input/implementation hash changed during study')
    print('COMPLETED',out,flush=True)
if __name__=='__main__':main()
