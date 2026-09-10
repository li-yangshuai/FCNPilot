#!/usr/bin/env python3
"""One-step TOY/MAJ transfer verification of the frozen joint-search algorithm.

Uses the previously declared baseline selection for every corpus entry, including
unavailable entries. Calls the real Pi model once per eligible circuit by default;
all policies share their case's certified starting layout and candidate menu.
"""
from __future__ import annotations
import argparse,copy,hashlib,json,shutil,sys,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import datetime,timezone
from collections import Counter
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'engine/scripts'))
import ifcn_agent as api
import ifcn_joint_search as search
from ifcn_joint_menu import candidate_menu
from ifcn_layout_optimization import choose_node
from run_study import prepare_baseline,run_policy
save=search.save

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def brief(result):
    return {k:v for k,v in result.items() if k!='rounds'}

def verify_completed(case_folder, reports):
    checks=[]
    for policy,result in reports.items():
        selected=result['selected_round']
        if selected is None:continue
        target=case_folder/policy/f'{selected:02d}'/'joint'
        physical=json.loads((target/'physical.json').read_text())
        clock=json.loads((target/'clock.json').read_text())
        logic=json.loads((target/'logic.json').read_text())
        if not all([physical['passed'],clock['passed'],logic['status']=='equivalent']):raise ValueError('Selected result has a failed certificate')
        if physical['ifcn_sha256']!=sha(target/'layout.ifcn') or physical['qca_sha256']!=sha(target/'device_energy_input.qca'):raise ValueError('Selected certificate not bound to actual files')
        if result['selected']['qca_cells']!=(target/'device_energy_input.qca').read_text().count('[TYPE:QCADCell]'):raise ValueError('Selected cell count mismatch')
        checks.append({'policy':policy,'selected_round':selected,'area_tiles':result['selected']['area_tiles'],'qca_cells':physical['cell_count'],'vectors_checked':logic.get('vectors_checked')})
    return checks

def run_case(case, prepared, case_folder, model, node, rounds, timeout):
    begin=time.monotonic();reports={}
    order=['deterministic_joint','llm_joint'] if case['ordinal']%2 else ['llm_joint','deterministic_joint']
    for policy in order:
        reports[policy]=run_policy(case_folder,policy,prepared['baseline'],prepared['metrics'],prepared['clock'],case_folder/'inputs',prepared['manifest']['frontend'],prepared['manifest']['configuration'],node,model,rounds,timeout,'menu')
    result={'case_id':case['case_id'],'source_sha256':case['source_sha256'],'baseline_run_id':case['run_id'],'status':'completed','elapsed_s':time.monotonic()-begin,'policy_order':order,'policies':{k:brief(v) for k,v in reports.items()},'selected_certificate_checks':verify_completed(case_folder,reports)}
    save(case_folder/'summary.json',result)
    return result

def aggregate(rows,out=None):
    eligible=sum(r.get('eligible') is True for r in rows)
    summary={'cases':len(rows),'eligible_cases':eligible,'statuses':dict(Counter(r['status'] for r in rows)),'policies':{}}
    for policy in ['deterministic_joint','llm_joint']:
        data=[r['policies'][policy] for r in rows if r.get('status')=='completed']
        area=[(v['initial']['area_tiles']-v['selected']['area_tiles'])/v['initial']['area_tiles']*100 for v in data]
        cells=[(v['initial']['qca_cells']-v['selected']['qca_cells'])/v['initial']['qca_cells']*100 for v in data]
        summary['policies'][policy]={'completed_cases':len(data),'improved_cases':sum(search.pareto(v['initial'],v['selected']) for v in data),'mean_area_reduction_pct':sum(area)/len(area) if area and len(data)==eligible else None,'mean_qca_reduction_pct':sum(cells)/len(cells) if cells and len(data)==eligible else None,'unknown_or_pending_cases':eligible-len(data),'live_native_evaluations':sum(v['live_native_evaluations'] for v in data),'real_model_requests':sum(v['real_model_requests'] for v in data),'paired_native_evaluations':sum(v['paired_native_evaluations'] for v in data),'outcomes':dict(sum((Counter(v['outcomes']) for v in data),Counter()))}
    if out is not None:
        for policy in ['deterministic_joint','llm_joint']:
            summary['policies'][policy].update(live_native_evaluations=len(list(out.glob(f'c*/{policy}/*/joint/evaluation.log'))),real_model_requests=len(list(out.glob(f'c*/{policy}/*/request.json'))),paired_native_evaluations=len(list(out.glob(f'c*/{policy}/*/placement_only/evaluation.log')))+len(list(out.glob(f'c*/{policy}/*/routing_only/evaluation.log'))))
    return summary

def usage_summary(out):
    known=0;unknown=0;parsed=0
    for request in out.glob('c*/llm_joint/*/request.json'):
        try:response=json.loads(request.with_name('response.json').read_text());parsed+=1
        except (OSError,ValueError):unknown+=1;continue
        usage=response.get('usage')
        value=usage.get('totalTokens') if isinstance(usage,dict) else None
        if type(value) in (int,float) and value>=0 and value<float('inf') and (value>0 or response.get('status')=='ok'):known+=value
        else:unknown+=1
    return {'known_reported_tokens':known,'requests_with_unknown_usage':unknown,'parseable_response_records':parsed}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',required=True)
    parser.add_argument('--rounds',type=int,default=1)
    parser.add_argument('--workers',type=int,default=2)
    args=parser.parse_args()
    if not 1<=args.rounds<=8 or not 1<=args.workers<=2:parser.error('rounds1..8/workers1..2')
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
    old=ROOT/'experiments/layout_llm_full'
    index=json.loads((old/'index.json').read_text());old_protocol=json.loads((old/'protocol.json').read_text())
    if json.loads((old/'audit.json').read_text()).get('index_sha256')!=sha(old/'index.json'):raise ValueError('Frozen source index audit mismatch')
    if index['protocol_sha256']!=sha(old/'protocol.json'):raise ValueError('Frozen corpus protocol hash changed')
    if set(index['selection'])!={c['id'] for c in old_protocol['cases']}:raise ValueError('Corpus/selection coverage mismatch')
    model={'provider':old_protocol['model']['provider'],'modelId':old_protocol['model']['model_id']}
    node=choose_node(ROOT/'engine');timeout=old_protocol['candidate_timeout_s']
    snapshots=out/'reference';snapshots.mkdir()
    for name in ['index.json','protocol.json','inventory.json','audit.json']:shutil.copy2(old/name,snapshots/name)
    entries=[];prepared={};watched={str(old/name):sha(old/name) for name in ['index.json','protocol.json','inventory.json','audit.json']}
    for ordinal,case in enumerate(old_protocol['cases'],1):
        selection=index['selection'][case['id']]
        row={'ordinal':ordinal,'case_id':case['id'],'group':case['group'],'source_sha256':case['source_sha256'],'run_id':selection.get('run_id'),'status':'unavailable','reasons':selection['reasons']}
        if selection['status']=='selected':
            row['folder']=f"c{ordinal:02d}_{case['group']}_{Path(case['id']).stem}"
            folder=out/row['folder'];folder.mkdir()
            origin=ROOT/'engine/output/pi-runs'/selection['run_id']
            for file in origin.rglob('*'):
                if file.is_file():watched[str(file)]=sha(file)
            try:
                bundle=prepare_baseline(origin,folder/'inputs')
                if sha(folder/'inputs/source.v')!=case['source_sha256']:raise ValueError('Copied baseline source differs from frozen corpus source')
                if sha(folder/'inputs/normalized.v')!=case['normalized_sha256']:raise ValueError('Normalized source differs from frozen protocol')
                menu=candidate_menu(bundle['baseline'])
                if not menu:raise ValueError('No joint menu candidate is available')
                for proposal in menu:
                    search.validate_proposal({'schema':'ifcn.layout_search.v2','operations':proposal['operations'],'routing_order':proposal['routing_order'],'rationale':proposal['description']},bundle['baseline'])
                row.update(status='eligible',reasons=[],nodes=len(bundle['baseline']['nodes']),routes=len(bundle['baseline']['routes']),inputs=len(bundle['manifest']['frontend']['inputs']),initial=bundle['metrics'],initial_menu_entries=len(menu))
                prepared[case['id']]=bundle
            except Exception as error:row.update(status='preflight_failed',reasons=[str(error)])
        entries.append(row)
    files=[Path(__file__),Path(__file__).with_name('run_study.py'),ROOT/'integrations/pi/layout-proposer.mjs',*sorted((ROOT/'engine/scripts').glob('*.py')),ROOT/'engine/src/app/ifcn_layout_edit.cpp',ROOT/'engine/include/autopr/graph/circuitGraph.cpp',ROOT/'engine/include/autopr/graph/circuitGraph.h']
    implementation={str(f):sha(f) for f in files}
    for file in files:
        dest=out/'implementation'/file.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,dest)
    binary_hashes={str(ROOT/'engine/build'/name):sha(ROOT/'engine/build'/name) for name in ['ifcn_layout_edit','ifcn_energy_analysis','ifcn_mapping_metrics']}
    plan={'schema':'fcn.llm_joint_transfer.v3','created_at':datetime.now(timezone.utc).isoformat(),'case_entries':entries,'rounds_per_policy':args.rounds,'workers':args.workers,'model':model,'candidate_timeout_s':timeout,'model_timeout_s':60,'source_protocol_sha256':sha(old/'protocol.json'),'source_selection_sha256':sha(old/'index.json'),'original_artifact_hashes':watched,'implementation_hashes':implementation,'binary_hashes':binary_hashes,'scope':'One-step transfer verification by default, not full optimization convergence or a corpus-level LLM superiority claim. All 30 named TOY/MAJ entries retained. Existing prespecified June-then-Compact baseline selection is reused.','controls':'Identical certified initial layout, menu generator/cap48, live candidate-slot budget, exact single routing-order attempt, <=8 coordinate edits, same clock/source/QCA certification and strict area/cell Pareto acceptance per case. Deterministic chooses first remaining menu entry; LLM chooses a recorded ID.','paired_ablations':'Every valid LLM proposal replayed from the identical incumbent as placement-only and routing-only; these results do not affect live selection or feedback.','policy_order':'Alternates per original ordinal. Cases execute independently in a bounded two-worker pool.','no_retries':'Real model requests submitted at most once per case/policy/round; failures retained. No hidden routing-order fallback or new baseline selection.','input_caveats':old_protocol.get('source_caveats'),'python':sys.version,'execution_environment_overrides':search.EXECUTION_ENV}
    save(out/'protocol.json',plan)
    results={e['case_id']:{'case_id':e['case_id'],'status':'pending' if e['status']=='eligible' else e['status'],'eligible':e['status']=='eligible','reasons':e['reasons']} for e in entries}
    save(out/'summary.json',{'aggregate':aggregate(list(results.values()),out),'cases':list(results.values())})
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        pending={executor.submit(run_case,e,prepared[e['case_id']],out/e['folder'],model,node,args.rounds,timeout):e for e in entries if e['status']=='eligible'}
        for future in as_completed(pending):
            case=pending[future]
            try:result=future.result()
            except Exception as error:
                result={'case_id':case['case_id'],'status':'execution_failed','error':str(error)}
                save(out/case['folder']/'failure.json',result)
            result['eligible']=True
            results[case['case_id']]=result
            ordered=sorted(results.values(),key=lambda x:next(e['ordinal'] for e in entries if e['case_id']==x['case_id']))
            save(out/'summary.json',{'aggregate':aggregate(ordered,out),'cases':ordered})
            print('CASE',case['case_id'],result['status'],flush=True)
    cases=sorted(results.values(),key=lambda x:next(e['ordinal'] for e in entries if e['case_id']==x['case_id']))
    save(out/'summary.json',{'aggregate':aggregate(cases,out),'cases':cases})
    audit={'completed_at':datetime.now(timezone.utc).isoformat(),'original_artifacts_unchanged':all(Path(p).exists() and sha(p)==h for p,h in watched.items()),'implementation_unchanged':all(sha(p)==h for p,h in {**implementation,**binary_hashes}.items()),'model_request_files':len(list(out.glob('c*/llm_joint/*/request.json'))),'model_response_files':len(list(out.glob('c*/llm_joint/*/response.json'))),**usage_summary(out),'artifact_hashes':{str(f.relative_to(out)):sha(f) for f in out.rglob('*') if f.is_file()}}
    save(out/'audit.json',audit)
    if not audit['original_artifacts_unchanged'] or not audit['implementation_unchanged']:raise ValueError('Baseline or implementation changed during study')
    print('COMPLETED',out,flush=True)
if __name__=='__main__':main()
