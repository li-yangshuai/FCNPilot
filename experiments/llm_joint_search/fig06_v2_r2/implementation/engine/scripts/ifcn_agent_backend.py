"""Isolated, validated entry points into existing Python/native P&R algorithms."""
import argparse
import graphlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

from ifcn_agent_layout_validation import dag_from_candidate, export_native_ifcn, validate_candidate
from ifcn_agent_clock_validation import validate_clock_arrivals, clock_arrival_report

ROOT = Path(__file__).resolve().parents[1]
ALGORITHM = ROOT / 'python/placement'
ALGORITHMS = ('normal_2ddwave', 'compact', 'june_random', 'regular_clock_ga')
sys.path[:0] = [str(ALGORITHM), str(ALGORITHM / 'main')]
os.environ.setdefault('MPLBACKEND', 'Agg')
os.environ.setdefault('IFCN_GCN_RL_PARSE_MODE', 'compact')


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def write_dag(parsed, output):
    nodes = [{'id': int(node), 'name': parsed.parser.getNodeName(int(node)),
              'type': parsed.getNodeTypeString(int(node)),
              'is_input': node in parsed.getInputNodesIndex,
              'is_output': node in parsed.getOutputNodesIndex}
             for node in sorted(parsed.effective_nodes)]
    edges = [[int(a), int(b)] for a, b in parsed.effective_edges]
    dependencies = {node['id']: set() for node in nodes}
    for src, dst in edges:
        dependencies[dst].add(src)
    order = list(graphlib.TopologicalSorter(dependencies).static_order())
    if not nodes or not parsed.InputNodesNum or not parsed.OutputNodesNum:
        raise ValueError('Native parser produced an empty/incomplete circuit.')
    data = {'schema': 'ifcn.dag.v1', 'nodes': nodes, 'edges': edges,
            'layers': parsed.layer_nodes, 'topological_order': order,
            'input_count': parsed.InputNodesNum, 'output_count': parsed.OutputNodesNum}
    write_json(output, data)
    dot = ['digraph circuit {']
    dot += [f'  n{n["id"]} [label={json.dumps(n["name"] + ": " + n["type"])}];' for n in nodes]
    dot += [f'  n{src} -> n{dst};' for src, dst in edges]
    output.with_suffix('.dot').write_text('\n'.join(dot + ['}', '']))


def native_binary(algorithm=None):
    if algorithm == "regular_clock_ga":
        return Path(os.environ.get("IFCN_REGULAR_PNR", str(Path(os.environ.get("IFCN_BUILD_DIR", str(ROOT / "build"))) / "ifcn_regular_clock_pnr")))
    return Path(os.environ.get('IFCN_NATIVE_PNR', str(Path(os.environ.get('IFCN_BUILD_DIR', str(ROOT / 'build'))) / 'ifcn_combinational_pnr')))


def normal_candidate(draw):
    nodes = [{'id': int(node), 'name': draw.parse.parser.getNodeName(int(node)),
              'type': draw.parse.getNodeTypeString(int(node)),
              'is_input': node in draw.parse.getInputNodesIndex,
              'is_output': node in draw.parse.getOutputNodesIndex,
              'x': int(draw.get_node_coord(node)[0]), 'y': int(draw.get_node_coord(node)[1])}
             for node in sorted(draw.parse.effective_nodes)]
    routes = [{'source': int(src), 'target': int(dst), 'path': [[int(x), int(y)] for x,y in path]}
              for (src,dst),path in draw.mapChessboard.nodePairRoutes.items()]
    coords = {tuple(p) for route in routes for p in route['path']}
    coords.update((n['x'],n['y']) for n in nodes)
    # Fixed-clock phases are defined by the 2DDWave template, including retained
    # nodes that no longer have an explicit phase entry after contraction.
    cells = [{'x':x,'y':y,'phase':(x+y)%4+1} for x,y in sorted(coords)]
    layers = draw.parse.layer_nodes
    if isinstance(layers,dict):
        layers = [layers[key] for key in sorted(layers)]
    return {'nodes':nodes, 'edges':[[int(a),int(b)] for a,b in draw.parse.effective_edges],
            'routes':routes, 'cells':cells, 'layers':[[int(n) for n in layer] for layer in layers]}


def run_normal(args, out, summary):
    from normal_layout import run_layout_trial
    from src.toolkit import generate_gate_level_mapping_file
    options = SimpleNamespace(seed_retries=0, skip_training_curve=True,
                              max_expansion_rounds=96, route_expansion_timeout_sec=args.budget,
                              template_expansion_rounds=24, verbose=False, route_repair_iters=3,
                              phase_repair_iters=2, global_place_iters=5, compact_iters=64)
    summary['algorithm_parameters'] = vars(options) | {'seed':args.seed, 'phase_count':4, 'initial_placement':args.initial_placement or 'environment_default'}
    trial = run_layout_trial(options, args.input, str(out), '', args.seed, 0)
    draw = trial['draw']
    candidate = normal_candidate(draw)
    write_json(out/'layout_candidate.json',candidate)
    validation = validate_candidate(candidate)
    port_ok, port_violations, _ = draw.validate_gate_port_directions()
    validation['checks'].append('fixed_clock_gate_port_directions')
    if not port_ok:
        validation['errors'].extend(f'Gate port: {edge}: {message}' for edge,message in port_violations)
        validation['passed'] = False
    legal = trial['failed_count'] == 0 and trial['template_ok'] and validation['passed']
    summary.update(layout_legal=bool(legal), failed_edge_count=trial['failed_count'],
                   clock_template_ok=bool(trial['template_ok']), clock_template_conflicts=trial['template_conflicts'],
                   clock_legal=bool(trial['template_ok']), clock_validation_kind='2ddwave_template',
                   clock_scheme='2DDWave', validation=validation, width=int(draw.width), height=int(draw.height),
                   area_tiles=int(draw.width)*int(draw.height), run_time_s=trial['run_time'],
                   resolved_verilog=trial['resolved_benchmark_path'], boolean_canonicalization=bool(trial['parser_safe_generated']))
    write_json(out/'pnr.json',summary)
    if not legal:
        raise RuntimeError('P&R did not produce a fully routed, clock-legal, port-valid layout.')
    write_dag(draw.parse,out/'routed_dag.json')
    artifact = generate_gate_level_mapping_file(draw, output_dir=str(out), filename_stem='layout', verbose=False)
    if not artifact or not Path(artifact).is_file():
        raise RuntimeError('P&R exporter did not produce an IFCN file.')
    summary['ifcn'] = str(Path(artifact).resolve())
    draw.show_circuit_figure(dir_path=str(out))
    draw.print_latex(str(out))


def run_native(args, out, summary):
    native_started = time.monotonic()
    executable = (Path(os.environ.get("IFCN_LAYOUT_EDIT", str(Path(os.environ.get("IFCN_BUILD_DIR", str(ROOT/"build")))/"ifcn_layout_edit")))
                  if getattr(args,"edit_baseline",None) else native_binary(args.algorithm))
    if not executable.is_file() or not os.access(executable,os.X_OK):
        raise RuntimeError(f'Native P&R executable is unavailable: {executable}; build target ifcn_combinational_pnr.')
    summary['algorithm_parameters'] = (
        {'layer_order':'barycenter_4_sweeps', 'initial_spacing':[1,1], 'padding':[2,2],
         'route_order_retries':12, 'max_expansion_rounds':8, 'search_cost':240, 'max_same_phase':4,
         'topology':'optimized_buffers'} if args.algorithm=='compact' else
        {'graphviz_grid_size':40, 'route_order_retries':24, 'search_cost':40,
         'max_same_phase':None, 'topology':args.topology or 'layer_redundancy_buffers'})
    if args.algorithm == 'regular_clock_ga':
        summary['algorithm_parameters'] = {'clock_scheme':args.clock, 'seed':args.seed, 'objective':'area_and_device_cells_after_hard_drc'}
    if getattr(args,'edit_baseline',None):
        summary['algorithm_parameters'] = {'initial_placement':'exact_recorded_proposal',
            'route_order_retries':24,'search_cost':40,'padding':2,'topology':'fixed_baseline_dag',
            'max_same_phase':4 if args.algorithm=='compact' else 10,
            'max_same_phase_step_fraction':None if args.algorithm=='compact' else 0.3,
            'automatic_node_placement':False,'node_expansion_or_compression':False}
    summary['algorithm_parameters'].update(phase_count=4, timeout_s=args.budget,
                                           seed_control='exposed' if args.algorithm=='regular_clock_ga' else 'not_exposed_by_native_algorithm')
    candidate_path = out/'layout_candidate.json'
    with (out/'native.log').open('w') as log:
        try:
            command = ([str(executable), args.input, args.edit_baseline, args.edit_proposal, str(candidate_path)]
                       if getattr(args,'edit_baseline',None) else
                       [str(executable), args.input, str(candidate_path), '--clock', args.clock, '--seed', str(args.seed), '--budget', str(args.budget)]
                       if args.algorithm=='regular_clock_ga' else [str(executable),args.algorithm,args.input,str(candidate_path), *(['--topology',args.topology] if args.topology else [])])
            result = subprocess.run(command,
                                    cwd=out,stdout=log,stderr=subprocess.STDOUT,timeout=args.budget,check=False)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f'{args.algorithm} exceeded its {args.budget}s native routing budget; see native.log.') from exc
    if not candidate_path.is_file():
        raise RuntimeError(f'{args.algorithm} exited {result.returncode} without a candidate; see native.log.')
    candidate = json.loads(candidate_path.read_text())
    if candidate.get('algorithm') != args.algorithm:
        raise ValueError('Edited candidate changed the requested algorithm/clock family')
    validation = validate_candidate(candidate,source_crossings=args.algorithm in ('june_random','regular_clock_ga'))
    if args.algorithm == 'regular_clock_ga':
        validation['checks'].append('regular_clock_template_and_arrival_alignment')
        if candidate.get('clock_scheme') != args.clock or candidate.get('regular_clock_valid') is not True:
            validation['errors'].append('Native regular clock validation is missing or disagrees with the selected template')
        if candidate.get('synchronization_valid') is not True:
            validation['errors'].append('Native regular-clock arrival alignment validation is missing or failed')
    validation['checks'].append('native_node_and_crossover_mapping')
    if candidate.get('native_mapping_valid') is not True:
        validation['errors'].append(candidate.get('native_validation_error') or 'Native mapping validation failed')
    if result.returncode != 0:
        validation['errors'].append(f'Native process exited with {result.returncode}')
    validation['passed'] = not validation['errors']
    legal = candidate.get('routed') is True and validation['passed']
    expected = {tuple(e) for e in candidate['edges']}
    actual = {(r['source'],r['target']) for r in candidate['routes']}
    summary.update(layout_legal=legal, failed_edge_count=len(expected-actual), clock_scheme=args.clock,
                   clock_template_ok=None, clock_template_conflicts=None, clock_legal=legal,
                   clock_validation_kind='regular_template_and_arrival' if args.algorithm=='regular_clock_ga' else 'route_phase_contract', validation=validation,
                   run_time_s=candidate['run_time_s'], resolved_verilog=args.input,
                   boolean_canonicalization=False, expansion=candidate.get('expansion'))
    write_json(out/'pnr.json',summary)
    if not legal:
        raise RuntimeError(f'{args.algorithm} candidate failed validation: '+ '; '.join(validation['errors'][:5]))
    width,height = export_native_ifcn(candidate,out/'layout.ifcn',args.algorithm)
    summary.update(width=width,height=height,area_tiles=width*height,ifcn=str((out/'layout.ifcn').resolve()))
    dag = dag_from_candidate(candidate,validation)
    write_json(out/'routed_dag.json',dag)
    if args.algorithm in ('compact','june_random'):
        original_clock = validate_clock_arrivals((out/'layout.ifcn').read_text(), dag)
        if not original_clock['passed']:
            # Keep the original geometry and phases as failure evidence. Free
            # clock assignment may repair epochs; fixed templates never change.
            from ifcn_combinational_rephase import rephase_candidate
            write_json(out/'original_layout_candidate.json',candidate)
            write_json(out/'original_clock.json',original_clock)
            (out/'original_layout.ifcn').write_text((out/'layout.ifcn').read_text())
            remaining = args.budget - (time.monotonic()-native_started) - 0.5
            if remaining <= 0:
                raise TimeoutError('No budget remains for clock arrival repair')
            repaired, repair_report = rephase_candidate(candidate,args.algorithm,remaining)
            write_json(out/'phase_repair.json',repair_report)
            summary['phase_repair'] = repair_report
            if repaired is None:
                raise RuntimeError('Free clock assignment could not align arrivals within the unchanged design rules; see phase_repair.json')
            repaired_geometry = validate_candidate(repaired,source_crossings=args.algorithm=='june_random')
            if not repaired_geometry['passed']:
                raise RuntimeError('Rephased candidate failed geometric validation')
            candidate = repaired
            write_json(out/'layout_candidate.json',candidate)
            export_native_ifcn(candidate,out/'layout.ifcn',args.algorithm)
            validation['checks'].remove('native_node_and_crossover_mapping')
            validation['checks'].extend(['original_native_geometry_mapping','rephased_geometry_and_clock_contract'])
            summary['clock_validation_kind'] = 'free_phase_with_absolute_arrival_alignment'


def check_export_mapping(args,out,summary):
    build = Path(os.environ.get('IFCN_BUILD_DIR',str(ROOT/'build')))
    executable = Path(os.environ.get('IFCN_MAPPING_METRICS_EXE',str(build/'ifcn_mapping_metrics')))
    with (out/'mapping_validation.log').open('w') as log:
        result = subprocess.run([str(executable),summary['ifcn'],'--no-io-contraction'],
                                stdout=subprocess.PIPE,stderr=log,text=True,timeout=min(30,args.budget),check=False)
        log.write(result.stdout)
    try:
        cell_count,cross_count = map(int,result.stdout.strip().split()[-2:])
    except ValueError:
        cell_count,cross_count = 0,0
    if result.returncode or cell_count<=0:
        raise RuntimeError(f'Exported IFCN failed native device mapping validation (exit {result.returncode}); see mapping_validation.log.')
    summary['validation']['checks'].append('exported_ifcn_device_mapping')
    summary['mapping_validation'] = {'passed':True, 'cell_count':cell_count,'cross_count':cross_count,'io_contraction':False}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('stage',choices=['probe','parse','pnr'])
    parser.add_argument('--input')
    parser.add_argument('--output',required=True)
    parser.add_argument('--seed',type=int,default=1)
    parser.add_argument('--budget',type=int,default=240)
    parser.add_argument('--algorithm',choices=ALGORITHMS,default='normal_2ddwave')
    parser.add_argument('--clock',choices=('2DDWave','USE','RES','irregular'))
    parser.add_argument('--initial-placement',choices=('original','transposed'))
    parser.add_argument('--topology',choices=('optimized_buffers','layer_redundancy_buffers'))
    parser.add_argument('--edit-baseline')
    parser.add_argument('--edit-proposal')
    parser.add_argument('--preserve-output-boundaries', action='store_true',
                        help='Preserve named output vertices when parsing a sequential cut DAG')
    args=parser.parse_args()
    if bool(args.edit_baseline) != bool(args.edit_proposal):
        parser.error('Placement edits require both baseline candidate and proposal')
    if args.edit_baseline and (args.stage != 'pnr' or args.algorithm not in ('compact','june_random')):
        parser.error('Placement edits only support native irregular combinational layouts')
    supported_clocks = {'normal_2ddwave':('2DDWave',), 'compact':('irregular',), 'june_random':('irregular',),
                        'regular_clock_ga':('2DDWave','USE','RES')}
    if args.initial_placement:
        if args.algorithm != 'normal_2ddwave':
            parser.error('Initial-placement variant only applies to fixed 2DDWave graph compression')
        os.environ['IFCN_TRANSPOSE_INITIAL_PLACEMENT'] = '1' if args.initial_placement == 'transposed' else '0'
    if args.topology and args.algorithm not in ('compact','june_random'):
        parser.error('Topology variant only applies to native graph drawing')
    args.clock = args.clock or supported_clocks[args.algorithm][0]
    if args.clock not in supported_clocks[args.algorithm]:
        parser.error('The chosen algorithm does not support this clock scheme')
    if args.preserve_output_boundaries and args.stage != 'parse':
        parser.error('--preserve-output-boundaries is supported only by the parse stage')
    if args.budget<1:
        parser.error('--budget must be positive')
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    if args.stage in ('probe','parse'):
        from src.circuit_parse import CircuitParser
        if args.stage=='probe':
            from src.normalGraphDraw import NormalGraphDraw  # noqa: F401
            if args.algorithm!='normal_2ddwave' and not native_binary(args.algorithm).is_file():
                raise RuntimeError('Native P&R executable is unavailable')
            print('IFCN_BACKEND_READY');return
        write_dag(CircuitParser(args.input, preserve_output_boundaries=args.preserve_output_boundaries),out/'dag.json');return
    if not args.input or not Path(args.input).is_file():
        parser.error('--input must identify an existing Verilog file')
    args.input=str(Path(args.input).resolve())
    # A failed rerun must never leave a previous layout available as fresh output.
    for name in ('pnr.json','layout.ifcn','routed_dag.json','layout_candidate.json'):
        if (out/name).exists():
            raise RuntimeError(f'Refusing to overwrite an existing P&R artifact: {out/name}; use a fresh output directory.')
    summary={'schema':'ifcn.pnr.v1','algorithm':args.algorithm,'phase_count':4,'seed':args.seed,
             'layout_legal':False,'clock_legal':False,'failed_edge_count':None,
             'validation':{'passed':False,'checks':[],'errors':[]}}
    start=time.monotonic()
    try:
        (run_normal if args.algorithm=='normal_2ddwave' else run_native)(args,out,summary)
        arrival = clock_arrival_report(summary['ifcn'],out/'routed_dag.json',out/'clock.json')
        summary['clock_arrival'] = arrival
        summary['validation']['checks'].append('cycle_zero_absolute_arrival_alignment')
        check_export_mapping(args,out,summary)
        summary['total_backend_time_s']=time.monotonic()-start
        write_json(out/'pnr.json',summary)
    except Exception as exc:
        summary['layout_legal']=False
        summary['failure_reason']=str(exc)
        summary['validation']['passed']=False
        if str(exc) not in summary['validation']['errors']:
            summary['validation']['errors'].append(str(exc))
        summary['total_backend_time_s']=time.monotonic()-start
        write_json(out/'pnr.json',summary)
        raise


if __name__=='__main__':
    main()
