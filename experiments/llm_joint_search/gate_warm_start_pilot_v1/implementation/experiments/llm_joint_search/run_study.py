#!/usr/bin/env python3
"""Frozen case study of real Pi LLM decisions and exact joint P&R execution."""
from __future__ import annotations
import argparse,copy,hashlib,json,os,re,shutil,signal,subprocess,sys,time
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
from ifcn_agent_layout_validation import export_native_ifcn,validate_candidate
save=search.save

def model_call(node,context,model,target,request_id):
    request={'request_id':request_id,'context':context,'timeout_ms':60000,'max_tokens':2200}
    if model is not None:request['model']=model
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

def prepare_baseline(origin:Path,inputs:Path)->dict:
    """Copy the manifest-selected certified layout into a new study input folder.

    All checks are read-only on the original run. Recorded hashes/sizes and
    source/DAG/layout/certificate bindings are checked again after copying;
    no native router, model request or device generator is invoked here.
    """
    origin=Path(origin).resolve();inputs=Path(inputs).absolute()
    if inputs.exists() or inputs.is_symlink():raise ValueError('Refusing to overwrite existing inputs')
    if inputs.resolve().is_relative_to(origin):raise ValueError('Study inputs must be outside the original run')
    manifest=api.load_run(origin)
    if not re.fullmatch(r'[0-9a-f]{32}',origin.name) or manifest.get('run_id')!=origin.name:raise ValueError('Run ID does not match its directory')
    if manifest.get('status')!='completed' or manifest.get('active') is True or manifest.get('design_type')!='combinational':raise ValueError('Baseline must be a completed combinational run')
    if any(manifest.get('stages',{}).get(stage,{}).get('status')!='completed' for stage in ('pnr','map')):raise ValueError('Baseline P&R and mapping stages must be completed')
    required={'clock_arrival':'cycle_zero_at_template_phase_passed',
              'physical_routes':'source_isolation_and_ordered_paths_passed',
              'rtl_equivalence':'exhaustive_scalar_source_vs_routed_dag',
              'device_terminal_counts':'match_source_declarations'}
    if any(manifest.get('validation',{}).get(k)!=v for k,v in required.items()):raise ValueError('Baseline lacks the required current certificates')
    parameters=manifest.get('parameters',{});pnr=manifest.get('metrics',{}).get('pnr',{});algorithm=pnr.get('algorithm')
    if algorithm not in ('june_random','compact') or pnr.get('clock_scheme')!='irregular':raise ValueError('Baseline must use certified June/Compact irregular clocking')
    if parameters.get('algorithm') not in (None,'auto',algorithm) or parameters.get('clock_scheme') not in (None,'irregular'):raise ValueError('Requested algorithm/clock disagrees with the selected baseline')
    artifacts=manifest.get('artifacts')
    if not isinstance(artifacts,dict) or not artifacts:raise ValueError('Baseline has no registered artifacts')
    # The shared verifier checks SHA-256; enforce declared byte counts too.
    for key,item in artifacts.items():
        if not isinstance(item,dict) or not isinstance(item.get('path'),str) or not isinstance(item.get('sha256'),str) or not re.fullmatch(r'[0-9a-f]{64}',item['sha256']):raise ValueError('Malformed registered artifact: '+str(key))
        if type(item.get('bytes')) is not int or item['bytes']<0:raise ValueError('Malformed artifact byte count: '+str(key))
        path=api.artifact_path(origin,item)
        if not path.is_file() or path.stat().st_size!=item['bytes']:raise ValueError('Artifact byte count changed: '+str(key))
    api.verify_artifacts(origin,manifest)
    names={name:name for name in ('source.v','normalized.v','layout_candidate.json','routed_dag.json','layout.ifcn','physical.json','clock.json')}
    names['device_energy_input.qca']='validated_device.qca' if 'validated_device.qca' in artifacts else 'device.qca'
    missing=[key for key in names.values() if key not in artifacts]
    if missing:raise ValueError('Missing registered baseline artifacts: '+', '.join(missing))
    sources={name:api.artifact_path(origin,artifacts[key]) for name,key in names.items()}
    baseline=json.loads(sources['layout_candidate.json'].read_text())
    if baseline.get('schema')!='ifcn.native_candidate.v1' or baseline.get('routed') is not True or baseline.get('algorithm')!=algorithm or ('clock_scheme' in baseline and baseline['clock_scheme']!='irregular'):raise ValueError('Candidate disagrees with the completed irregular baseline')
    ifcn_text=sources['layout.ifcn'].read_text()
    if not re.search(r'(?m)^#clock scheme:\s*irregular\s*$',ifcn_text) or not re.search(r'(?m)^#phase count:\s*4\s*$',ifcn_text):raise ValueError('Registered IFCN is not a four-phase irregular layout')
    topology=baseline.get('topology')
    if topology not in ('optimized_buffers','layer_redundancy_buffers') or algorithm=='compact' and topology!='optimized_buffers':raise ValueError('Unsupported fixed-DAG baseline topology')
    nodes=baseline.get('nodes',[]);routes=baseline.get('routes',[])
    if not isinstance(nodes,list) or not isinstance(routes,list) or not 1<=len(nodes)<=50 or not 1<=len(routes)<=100:raise ValueError('Baseline exceeds the 50-node / 100-route optimization limit')
    _,frontend=api.normalize_verilog(sources['source.v'].read_text())
    if not 1<=len(frontend['inputs'])<=11:raise ValueError('Baseline exceeds the 11-input exhaustive-equivalence limit')
    if any(manifest.get('frontend',{}).get(k)!=frontend[k] for k in ('module','inputs','outputs')):raise ValueError('Manifest frontend does not match registered source declarations')
    dag=json.loads(sources['routed_dag.json'].read_text());assert_graph_identity(baseline,dag)
    validation=validate_candidate(baseline,source_crossings=algorithm=='june_random')
    if not validation['passed']:raise ValueError('Baseline geometry invalid: '+ '; '.join(validation['errors'][:4]))
    phases={(c['x'],c['y']):c['phase'] for c in baseline['cells']};holds=steps=0;longest=1
    for route in routes:
        run=1
        for a,b in zip(route['path'],route['path'][1:]):
            same=phases[tuple(a)]==phases[tuple(b)];holds+=same;steps+=1;run=run+1 if same else 1;longest=max(longest,run)
    if longest>(4 if algorithm=='compact' else 10) or algorithm=='june_random' and holds*10>steps*3:raise ValueError('Baseline violates its original same-phase clock constraints')
    physical=json.loads(sources['physical.json'].read_text());stored_clock=json.loads(sources['clock.json'].read_text())
    if physical.get('passed') is not True or physical.get('qca_sha256')!=api.digest(sources['device_energy_input.qca']) or physical.get('ifcn_sha256')!=api.digest(sources['layout.ifcn']):raise ValueError('Invalid physical certificate file binding')
    if stored_clock.get('passed') is not True or stored_clock.get('ifcn_sha256')!=api.digest(sources['layout.ifcn']) or stored_clock.get('routed_dag_sha256')!=api.digest(sources['routed_dag.json']):raise ValueError('Invalid clock certificate file binding')
    source_artifacts={str(file):api.digest(file) for file in sources.values()}
    source_artifacts[str(origin/'manifest.json')]=api.digest(origin/'manifest.json')
    inputs.mkdir(parents=True,exist_ok=False)
    for name,file in sources.items():
        with (inputs/name).open('xb') as output:output.write(file.read_bytes())
        if api.digest(inputs/name)!=artifacts[names[name]]['sha256']:raise ValueError('Baseline artifact changed while copying: '+name)
    export_native_ifcn(baseline,inputs/'snapshot_check.ifcn',algorithm)
    if read_clock_layout((inputs/'snapshot_check.ifcn').read_text())!=read_clock_layout((inputs/'layout.ifcn').read_text()):raise ValueError('Candidate does not match the certified IFCN layout')
    clock=clock_arrival_report(inputs/'layout.ifcn',inputs/'routed_dag.json',inputs/'checked_clock.json')
    for name,label in [('source.v','checked_logic.json'),('normalized.v','checked_normalized_logic.json')]:
        logic=api.logic_report(inputs/name,inputs/'routed_dag.json',inputs/label)
        if logic['status']!='equivalent':raise ValueError('Registered '+name+' is not exhaustively equivalent to the routed DAG')
    interface=api.qca_interface_report(inputs/'device_energy_input.qca',frontend,inputs/'checked_interface.json')
    checked_physical=api.physical_route_report(inputs/'physical.json',inputs/'device_energy_input.qca',interface,inputs/'checked_physical.json',inputs/'layout.ifcn')
    if any(api.digest(Path(file))!=digest for file,digest in source_artifacts.items()):raise ValueError('Original baseline changed during verification')
    source=manifest.get('source',{})
    if isinstance(source,dict):source=source.get('path') or source.get('name') or origin.name
    path=Path(str(source or origin.name))
    case_id=str(Path(path.parent.name)/path.name) if path.parent.name in ('TOY','MAJ') else path.name
    return {'manifest':manifest,'baseline':baseline,'clock':clock,'metrics':measure(baseline,checked_physical,clock),'case_id':case_id,'source_artifacts':source_artifacts}

def parse_arguments(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',required=True)
    parser.add_argument('--run-id',required=True)
    parser.add_argument('--provider')
    parser.add_argument('--model-id')
    parser.add_argument('--rounds',type=int,default=8)
    parser.add_argument('--mode',choices=['direct','menu'],default='menu')
    args=parser.parse_args(argv)
    if not re.fullmatch(r'[0-9a-f]{32}',args.run_id):parser.error('run-id must be exactly 32 lowercase hexadecimal characters')
    if not 1<=args.rounds<=8:parser.error('rounds must be 1..8')
    if (args.provider is None)!=(args.model_id is None) or args.provider is not None and (not args.provider.strip() or not args.model_id.strip()):parser.error('provider and model-id must be supplied together and nonempty')
    return args

def selected_model(manifest,provider=None,model_id=None):
    if provider is not None:return {'provider':provider,'modelId':model_id}
    model=manifest.get('optimization',{}).get('model')
    if model is None:return None  # The existing proposer runtime chooses its configured model.
    if not isinstance(model,dict) or not all(isinstance(model.get(k),str) and model[k].strip() for k in ('provider','modelId')):raise ValueError('Recorded optimization model is malformed; provide an explicit provider/model-id pair')
    return {k:model[k] for k in ('provider','modelId')}

def run_policy(out,policy,baseline,initial,clock,inputs,frontend,config,node,model,rounds,timeout,mode="direct"):
    current=copy.deepcopy(baseline);metrics=copy.deepcopy(initial);timing=copy.deepcopy(clock)
    rows=[];seen=set();selected=None;folder=out/policy;folder.mkdir()
    for i in range(1,rounds+1):
        target=folder/f'{i:02d}';target.mkdir()
        row={'round':i,'status':'failed','start_metrics':copy.deepcopy(metrics),'start_placement':search.key(current)}
        begin=time.monotonic()
        try:
            context=search.context_for(current,metrics,timing,rows)
            menu=None
            if mode=='menu':
                from ifcn_joint_menu import candidate_menu
                menu=candidate_menu(current,excluded_ids=seen,limit=48)
                if not menu:
                    row.update(status='not_attempted',error='All remaining geometric/routing menu candidates exhausted')
                    rows.append(row);save(target/'result.json',row);break
                context['state_features'].pop('geometric_cut_suggestions',None)
                context['candidate_menu']=menu
                context['action_space']['selection_mode']='candidate_menu'
                save(target/'candidate_menu.json',menu)
            if policy=='llm_joint':
                audit,latency=model_call(node,context,model,target,f'{out.name}:{policy}:{i}')
                row.update(model=audit['model'],usage=audit.get('usage'),model_latency_s=latency)
                row['proposal']=audit['proposal']
                proposal=search.validate_proposal(audit['proposal'],current)
                if mode=='menu':
                    decision=json.loads(audit['response']['raw_text'])
                    if set(decision)!={'schema','candidate_id','rationale'} or decision['schema']!='ifcn.layout_choice.v1':raise ValueError('Expected exact menu decision')
                    choice=next((item for item in menu if item['id']==decision['candidate_id']),None)
                    if choice is None or choice['operations']!=proposal['operations'] or choice['routing_order']!=proposal['routing_order']:raise ValueError('Lowered proposal did not match the exact model-selected menu candidate')
                    row['decision']=decision;seen.add(choice['id'])
            elif mode=='menu':
                choice=menu[0];seen.add(choice['id'])
                row['decision']={'schema':'ifcn.layout_choice.v1','candidate_id':choice['id'],'rationale':'Deterministic first remaining menu entry; same menu and single-pass evaluator as LLM.'}
                proposal={'schema':'ifcn.layout_search.v2','operations':choice['operations'],'routing_order':choice['routing_order'],'rationale':row['decision']['rationale']}
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
                    try:
                        counter=search.evaluate(current,variant,target/name,inputs/'source.v',inputs/'normalized.v',frontend,config,timeout)
                        if counter['status']=='certified':counter['status']='accepted' if search.pareto(metrics,counter['metrics']) else 'rejected'
                    except Exception as ablation_error:
                        counter={'status':'failed','error':str(ablation_error)}
                        (target/name).mkdir(exist_ok=True)
                    save(target/name/'result.json',counter)
                    row['paired_ablations'][name]={'status':counter['status'],'metrics':counter.get('metrics'),'error':counter.get('error'),'routing_audit':counter.get('routing_audit')}
            if row['status']=='accepted':
                selected=i;current=json.loads((target/'joint/layout_candidate.json').read_text());metrics=row['metrics'];timing=json.loads((target/'joint/clock.json').read_text())
        except Exception as e:
            row.update(status='failed',error=str(e))
            response=target/'response.json'
            if response.is_file():
                try:
                    failed_audit=json.loads(response.read_text())
                    row.update(model=failed_audit.get('model'),usage=failed_audit.get('usage'))
                    if not row.get('proposal'):
                        row['proposal']=failed_audit.get('proposal') or json.loads(failed_audit.get('response',{}).get('raw_text','null'))
                except (OSError,ValueError,TypeError):pass
        row['elapsed_s']=time.monotonic()-begin
        rows.append(row);save(target/'result.json',row)
        report={'policy':policy,'status':'running','initial':initial,'selected':metrics,'selected_round':selected,'rounds':rows,'outcomes':dict(Counter(r['status'] for r in rows))}
        save(folder/'result.json',report)
        print(policy,i,row['status'],row.get('metrics',{}),flush=True)
    report={'policy':policy,'status':'completed','initial':initial,'selected':metrics,'selected_round':selected,'rounds':rows,'outcomes':dict(Counter(r['status'] for r in rows)),'round_budget':rounds,'rounds_recorded':len(rows),'search_mode':mode,'live_native_evaluations':len(list(folder.glob('*/joint/evaluation.log'))),'real_model_requests':len(list(folder.glob('*/request.json'))),'paired_native_evaluations':len(list(folder.glob('*/placement_only/evaluation.log')))+len(list(folder.glob('*/routing_only/evaluation.log')))}
    save(folder/'result.json',report)
    return report

def main():
    args=parse_arguments()
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
    origin=ROOT/'engine/output/pi-runs'/args.run_id
    prepared=prepare_baseline(origin,out/'inputs')
    manifest=prepared['manifest'];baseline=prepared['baseline'];clock=prepared['clock'];metrics=prepared['metrics'];inputs=out/'inputs'
    watched={str(p):api.digest(p) for p in origin.rglob('*') if p.is_file()}
    config=manifest['configuration'];timeout=manifest.get('optimization',{}).get('candidate_timeout_s',20)
    if not isinstance(timeout,(int,float)) or not 1<=timeout<=600:raise ValueError('Candidate timeout must be 1..600 seconds')
    node=choose_node(ROOT/'engine');model=selected_model(manifest,args.provider,args.model_id)
    files=[Path(__file__),ROOT/'integrations/pi/layout-proposer.mjs',*sorted((ROOT/'engine/scripts').glob('*.py')),ROOT/'engine/src/app/ifcn_layout_edit.cpp',ROOT/'engine/include/autopr/graph/circuitGraph.cpp',ROOT/'engine/include/autopr/graph/circuitGraph.h']
    implementations={str(p):api.digest(p) for p in files}
    binaries={str(config[k]):api.digest(Path(config[k])) for k in ['energy_binary','mapping_binary']}
    binaries[str(ROOT/'engine/build/ifcn_layout_edit')]=api.digest(ROOT/'engine/build/ifcn_layout_edit')
    for file in files:
        dest=out/'implementation'/file.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,dest)
    algorithm=baseline['algorithm']
    save(out/'protocol.json',{'schema':'fcn.llm_joint_search.case_study.v4','search_mode':args.mode,'created_at':datetime.now(timezone.utc).isoformat(),'case':prepared['case_id'],'starting_run':origin.name,'starting_layout_artifact':manifest['artifacts']['layout_candidate.json']['path'],'starting_metrics':metrics,'source_artifacts':prepared['source_artifacts'],'model':model,'model_selection':'explicit_or_recorded' if model else 'configured_proposer_runtime','rounds':args.rounds,'candidate_timeout_s':timeout,'model_timeout_s':60,'model_request_max_retries':0,'max_node_operations':8,'max_routing_order_attempts_per_candidate':1,'routing_fallback':False,'clock_rules':{'algorithm':algorithm,'clock_scheme':'irregular','phase_count':4,'input_launch':'cycle_zero_at_own_phase','max_same_phase_tiles':4 if algorithm=='compact' else 10,'max_same_phase_step_fraction':None if algorithm=='compact' else 0.3,'physical_checks':'QCA port/path/source/layer checks with current IFCN/QCA binding'},'live_acceptance':'Both actual routed area and exported QCA cells non-increasing; at least one strict; each failure retains incumbent','control':('Same initial layout, menu generator, candidate-slot budget, and exact single-pass executor. Deterministic selects first remaining menu entry; LLM selects an entry ID from the same menu construction. No evaluator calls occur during menu generation.' if args.mode=='menu' else 'Same initial layout and candidate-slot budget; deterministic cut/control-order generation differs from free-coordinate LLM generation.'),'deduplication':('Candidate IDs bind final coordinates and exact edge order; evaluated IDs excluded from all later menus; up to four route-only entries reserved within cap48; no silent retry/fallback.' if args.mode=='menu' else 'Direct LLM may repeat actions; repeats consume evaluations.'),'paired_ablations':f'Every valid model proposal replayed from its same incumbent as placement-only/fixed order and routing-only/fixed placement. Each executes a single explicit order within {timeout}s. Counterfactuals never influence live model feedback or selection.','scope':'One registered circuit, one adaptive trajectory per policy. Not a corpus comparison, novelty proof, or electrical waveform/power result. Not pooled with old studies.','execution_environment_overrides':search.EXECUTION_ENV,'python':sys.version,'implementation_hashes':implementations,'binary_hashes':binaries,'original_artifact_hashes':watched})
    reports={}
    for policy in ['deterministic_joint','llm_joint']:
        reports[policy]=run_policy(out,policy,baseline,metrics,clock,inputs,manifest['frontend'],config,node,model,args.rounds,timeout,args.mode)
        save(out/'summary.json',reports)
    audit={'original_artifacts_unchanged':all(api.digest(Path(p))==h for p,h in watched.items()),'implementation_unchanged':all(api.digest(Path(p))==h for p,h in {**implementations,**binaries}.items()),'real_model_requests':len(list((out/'llm_joint').glob('*/request.json'))),'response_records':len(list((out/'llm_joint').glob('*/response.json'))),'artifact_hashes':{str(p.relative_to(out)):api.digest(p) for p in out.rglob('*') if p.is_file()}}
    save(out/'audit.json',audit)
    if not audit['original_artifacts_unchanged'] or not audit['implementation_unchanged']:raise ValueError('Input/implementation hash changed during study')
    print('COMPLETED',out,flush=True)
if __name__=='__main__':main()
