#!/usr/bin/env python3
"""Generate editable TikZ from hash-checked, archived production artifacts.

No circuit synthesis, simulator execution, or LLM call is performed.
The local snapshots make subsequent figure builds independent of output/.
"""
from pathlib import Path
import csv
from collections import Counter
import hashlib
import io
import json
import re
import shutil
import sys

REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / "experiments/scripts"))
from archive_paths import recorded_path

PAPER = Path(__file__).resolve().parents[1]
ROOT = REPOSITORY / "engine"
FIG = PAPER / 'figures'
DATA = PAPER / 'data' / 'device_runs'
RUNS = {
    'normal_2ddwave': 'output/pi-validation/release-logic-io-20260905T110234Z/runs/79ef5fc7abc2435186a1736049c4a9d3',
    'compact': 'output/pi-validation/release-logic-io-20260905T110234Z/runs/65b101e592324dfaa2de9da69897237e',
    'june_random': 'output/pi-validation/release-logic-io-20260905T110907Z/runs/9001812103cf4e109fbbff9d60a3aee8',
}
PHASE = ['phasezero', 'phaseone', 'phasetwo', 'phasethree']
DISPLAY = {'normal_2ddwave': 'Normal 2DDWave', 'compact': 'Compact', 'june_random': 'June'}


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def snapshot(algorithm):
    dest = DATA / algorithm
    receipt = dest / 'provenance.json'
    if receipt.exists():
        info = json.loads(receipt.read_text())
        assert sha(dest / 'original-manifest.json') == info['manifest_sha256']
        for rec in info['files']:
            assert sha(dest / rec['snapshot']) == rec['sha256'], rec
        return dest, info
    dest.mkdir(parents=True, exist_ok=True)
    origin = recorded_path(ROOT / RUNS[algorithm])
    manifest = json.loads((origin / 'manifest.json').read_text())
    keys = ['source.v', 'normalized.v', 'layout.ifcn', 'routed_dag.json', 'pnr.json',
            'logic.json', 'interface.json', 'device.qca', 'result.json', 'simulation.json',
            'energy.json', 'energy.txt', 'simulation/simulation_bistable_baseline.rst',
            'simulation/simulation_bistable_accelerated.rst',
            'simulation/simulation_coherence_baseline.rst',
            'simulation/simulation_coherence_accelerated.rst']
    info = {'run_id': manifest['run_id'], 'original_run': str(origin),
            'manifest_sha256': sha(origin / 'manifest.json'), 'files': []}
    shutil.copyfile(origin / 'manifest.json', dest / 'original-manifest.json')
    for key in keys:
        item = manifest['artifacts'][key]
        source = origin / item['path']
        assert sha(source) == item['sha256'], (algorithm, key, 'source hash mismatch')
        local = key.replace('/', '__')
        shutil.copyfile(source, dest / local)
        info['files'].append({'artifact': key, 'original': str(source), 'snapshot': local,
                              'sha256': sha(source)})
    receipt.write_text(json.dumps(info, indent=2) + '\n')
    return dest, info


def parse_ifcn(path):
    text = path.read_text()
    nodes = []
    for i, name, typ, x, y in re.findall(r'^(\d+),\s*([^,]+),\s*([^,]+),\s*\((-?\d+),(-?\d+)\);', text, re.M):
        nodes.append(dict(id=int(i), name=name, type=typ, x=int(x), y=int(y)))
    routes = []
    path_sections = text.split('#paths info')
    assert len(path_sections) == 3, 'Missing or ambiguous IFCN path section'
    for src, dst, route in re.findall(r'^\((\d+),(\d+)\):\s*(.*);$', path_sections[1], re.M):
        assert re.fullmatch(r'\(-?\d+,-?\d+\)(?:,\(-?\d+,-?\d+\))+', route), route
        routes.append({'source': int(src), 'target': int(dst),
                       'path': [tuple(map(int, p)) for p in re.findall(r'\((-?\d+),(-?\d+)\)', route)]})
    phase = {tuple(map(int, (x, y))): int(v) for x, y, v in
             re.findall(r'\((-?\d+),(-?\d+)\):(\d+);', text)}
    allpoints = {(n['x'], n['y']) for n in nodes}
    for route in routes:
        allpoints.update(route['path'])
    assert allpoints <= set(phase)
    assert all(0 <= v <= 3 for v in phase.values())
    return nodes, routes, phase, allpoints


def verify_layout_against_dag(parsed, dag):
    nodes, routes, phases, occupied = parsed
    assert Counter((r['source'], r['target']) for r in routes) == Counter(tuple(e) for e in dag['edges'])
    assert Counter(n['id'] for n in nodes) == Counter(n['id'] for n in dag['nodes'])
    positions = {n['id']:(n['x'],n['y']) for n in nodes}
    for route in routes:
        assert route['path'][0] == positions[route['source']]
        assert route['path'][-1] == positions[route['target']]
        assert all(abs(a[0]-b[0])+abs(a[1]-b[1]) == 1 for a,b in zip(route['path'], route['path'][1:]))


def parse_qca(path):
    layers = []
    for block in re.findall(r'\[TYPE:QCADLayer\](.*?)\[#TYPE:QCADLayer\]', path.read_text(), re.S):
        cells = []
        for cell in re.findall(r'\[TYPE:QCADCell\](.*?)\[#TYPE:QCADCell\]', block, re.S):
            def val(key):
                return re.search(r'^' + re.escape(key) + r'=(.*)$', cell, re.M).group(1)
            dots = []
            for dot in re.findall(r'\[TYPE:CELL_DOT\](.*?)\[#TYPE:CELL_DOT\]', cell, re.S):
                dots.append(tuple(float(re.search(r'^' + k + r'=(.*)$', dot, re.M).group(1)) for k in ['x', 'y', 'diameter']))
            labels = re.findall(r'^psz=(.*)$', cell, re.M)
            cells.append({'x': float(val('x')), 'y': float(val('y')),
                          'w': float(val('cell_options.cxCell')), 'h': float(val('cell_options.cyCell')),
                          'phase': int(val('cell_options.clock')), 'function': val('cell_function'),
                          'labels': labels, 'dots': dots})
        if cells:
            layers.append(cells)
    return layers


def escape(value):
    return str(value).replace('_', r'\_').replace('~', r'$\sim$')


def begin(height):
    return ['\\documentclass[tikz,border=1mm]{standalone}', '\\input{common.tex}',
            '\\begin{document}', '\\begin{tikzpicture}[x=1mm,y=-1mm]',
            f'\\path[use as bounding box] (0,0) rectangle (168,{height});']


def finish(lines, name):
    lines += ['\\end{tikzpicture}', '\\end{document}']
    (FIG / (name + '.tex')).write_text('\n'.join(lines) + '\n')


def evidence(name, info, claims, extra=None):
    item = {'figure': name, 'generator': 'scripts/generate_device_figures.py',
            'source_runs': info, 'claims': claims,
            'rendering': 'Coordinates and routes extracted without rerunning or optimizing the circuit.'}
    if extra:
        item.update(extra)
    (FIG / (name + '.evidence.json')).write_text(json.dumps(item, indent=2) + '\n')


def gate_layout(lines, parsed, cx, top, pitch, prefix):
    nodes, routes, phases, occupied = parsed
    xmin = min(x for x, y in occupied); xmax = max(x for x, y in occupied)
    ymin = min(y for x, y in occupied); ymax = max(y for x, y in occupied)
    def xy(p):
        return cx + (p[0] - (xmin + xmax) / 2) * pitch, top + (p[1] - ymin + .5) * pitch
    def coord(p):
        x, y = xy(p); return f'({x:.3f},{y:.3f})'
    for y in range(ymin, ymax + 1):
        for x in range(xmin, xmax + 1):
            px, py = xy((x, y)); phase = phases.get((x, y))
            fill = PHASE[phase] if phase is not None else 'white'
            lines.append(f'\\draw[fill={fill},draw=grid,line width=.3pt] ({px-pitch/2:.3f},{py-pitch/2:.3f}) rectangle ({px+pitch/2:.3f},{py+pitch/2:.3f});')
    for route in routes:
        path = ' -- '.join(coord(p) for p in route['path'])
        lines.append(f'\\draw[ink,line width=.8pt,line join=round] {path};')
    # Crossings are separate nets: erase a short vertical section and redraw H.
    incidence = {}
    for route in routes:
        for i in range(1, len(route['path']) - 1):
            a, p, b = route['path'][i-1:i+2]
            kind = 'h' if a[1] == p[1] == b[1] else ('v' if a[0] == p[0] == b[0] else 'bend')
            incidence.setdefault(p, []).append((route['source'], kind))
    gatepoints = {(n['x'], n['y']) for n in nodes}
    for p, inc in incidence.items():
        hs = {s for s, k in inc if k == 'h'}; vs = {s for s, k in inc if k == 'v'}
        if hs and vs and hs.isdisjoint(vs) and p not in gatepoints:
            x, y = xy(p); gap = min(.9, pitch * .18)
            lines.append(f'\\draw[white,line width=2.5pt] ({x-gap:.3f},{y:.3f}) -- ({x+gap:.3f},{y:.3f});')
            lines.append(f'\\draw[ink,line width=.8pt] ({x-gap:.3f},{y:.3f}) -- ({x+gap:.3f},{y:.3f});')
    # Mark only evidenced same-source branches, never unrelated crossings.
    source_neighbors = {}
    for route in routes:
        for a, b in zip(route['path'], route['path'][1:]):
            source_neighbors.setdefault((route['source'], a), set()).add(b)
            source_neighbors.setdefault((route['source'], b), set()).add(a)
    for (source, p), neighbors in source_neighbors.items():
        if len(neighbors) > 2 and p not in gatepoints:
            lines.append(f'\\fill[ink] {coord(p)} circle (.55mm);')
    daglabels = {'input': None, 'and': r'$\wedge$', 'or': r'$\vee$', 'not': r'$\neg$', 'buf': 'B', 'buffer': 'B', 'wire': 'W', 'fanout': 'F'}
    for node in nodes:
        label = node['name'] if node['type'] == 'input' else daglabels.get(node['type'], str(node['id']))
        x, y = xy((node['x'], node['y'])); size = min(4.1, pitch * .70)
        style = 'circle' if node['type'] == 'input' else 'rectangle,rounded corners=.5pt'
        lines.append(f'\\node[{style},draw=ink,fill=white,minimum size={size:.2f}mm,inner sep=0pt,font=\\sffamily\\fontsize{{7}}{{8}}\\selectfont] ({prefix}n{node["id"]}) at ({x:.3f},{y:.3f}) {{{escape(label) if not label.startswith("$") else label}}};')
        if node['name'] == 'out':
            lines.append(f'\\node[anchor=north,font=\\sffamily\\fontsize{{7}}{{8}}\\selectfont] at ({x:.3f},{y+size/2+.4:.3f}) {{out}};')
    return xmax-xmin+1, ymax-ymin+1


def draw_cells(lines, cells, left, top, scale, xmin, ymin, label_io=True):
    for cell in cells:
        x = left+(cell['x']-xmin)*scale; y = top+(cell['y']-ymin)*scale
        w = cell['w']*scale; h = cell['h']*scale
        typ = cell['function']; border = 'ink!65'; line = '.3pt'
        if typ.endswith('INPUT') or typ.endswith('OUTPUT'):
            border = 'ink'; line = '.85pt'
        lines.append(f'\\draw[fill={PHASE[cell["phase"]]},draw={border},line width={line}] ({x-w/2:.3f},{y-h/2:.3f}) rectangle ({x+w/2:.3f},{y+h/2:.3f});')
        for dx, dy, diam in cell['dots']:
            px=left+(dx-xmin)*scale;py=top+(dy-ymin)*scale
            lines.append(f'\\fill[ink!65] ({px:.3f},{py:.3f}) circle ({diam*scale*.35:.3f}mm);')
        if label_io and (typ.endswith('INPUT') or typ.endswith('OUTPUT')):
            label = cell['labels'][0]
            anchor = 'south' if typ.endswith('INPUT') else 'west'
            px, py = (x,y-h/2-.7) if typ.endswith('INPUT') else (x+w/2+.7,y)
            lines.append(f'\\node[anchor={anchor},font=\\sffamily\\fontsize{{7}}{{8}}\\selectfont] at ({px:.3f},{py:.3f}) {{{escape(label)}}};')


def legend(lines, x, y):
    lines.append(f'\\node[anchor=west] at ({x},{y}) {{Clock phase}};')
    for i in range(4):
        xx = x + 23 + i * 12
        lines.append(f'\\draw[fill={PHASE[i]},draw=ink!50,line width=.3pt] ({xx},{y-1.5}) rectangle ({xx+3},{y+1.5});')
        lines.append(f'\\node[anchor=west] at ({xx+3.5},{y}) {{{i}}};')


def make_chain(runs):
    folder, info = runs['normal_2ddwave']
    dag = json.loads((folder/'routed_dag.json').read_text())
    parsed = parse_ifcn(folder/'layout.ifcn')
    verify_layout_against_dag(parsed, dag)
    layers = parse_qca(folder/'device.qca')
    assert [len(v) for v in layers] == [72, 2, 5]
    assert len(dag['nodes']) == 6 and len(dag['edges']) == 7
    lines = begin(96)
    for x, title in [(0,'(a) Boolean DAG'),(55,'(b) Gate-level layout'),(108,'(c) QCA device layers')]:
        lines.append(f'\\node[paneltitle] at ({x},3) {{{title}}};')
    positions={0:(4,22),1:(4,47),3:(21,22),4:(21,47),5:(37,47),2:(43,29)}
    labels={0:'a',1:'b',2:'AND',3:'OR',4:'AND',5:'NOT'}
    for node in dag['nodes']:
        x,y=positions[node['id']]
        style='circle' if node['is_input'] else 'rectangle,rounded corners=1pt'
        lines.append(f'\\node[{style},draw=ink,fill=white,minimum width=8mm,minimum height=6mm,inner sep=0pt,font=\\sffamily\\fontsize{{7}}{{8}}\\selectfont] (d{node["id"]}) at ({x},{y}) {{{labels[node["id"]]}}};')
    # Logical graph edges are independently drawn, with a white underlay at crossings.
    for src,dst in dag['edges']:
        lines.append(f'\\draw[flow,preaction={{draw=white,line width=2.4pt}}] (d{src}) -- (d{dst});')
    lines += [r'\node[anchor=south] at (43,24) {out};',
              r'\node[align=center] at (25,63) {$\mathrm{out}=(a\lor b)\land\neg(a\land b)$};',
              r'\node[smallnote,align=center] at (25,72) {6 nodes, 7 directed edges\\4/4 input vectors equivalent};']
    gate_layout(lines,parsed,78,14,10,'a')
    lines += [r'\node[align=center] at (78,66) {$3\times4=12$ tiles};',
              r'\node[smallnote,align=center] at (78,74) {Fixed 2DDWave\\Bridge: separate crossing routes};']
    # Panel c shows complete cell sets in separate layers; upper layers share x scale.
    main = layers[0]; xmin=min(c['x'] for c in main); ymin=min(c['y'] for c in main)
    draw_cells(lines,main,112,17,.12,xmin,ymin)
    lines.append(r'\node[smallnote,anchor=west] at (108,10) {Layer 0: 72 cells};')
    for i,yy in [(1,65),(2,78)]:
        cells=layers[i]
        lines.append(f'\\node[smallnote,anchor=west] at (108,{yy-4}) {{Layer {i}: {len(cells)} cells}};')
        draw_cells(lines,cells,121,yy,.20,300,340,False)
    lines.append(r'\node[smallnote,anchor=west] at (108,85) {79 cells across three layers};')
    legend(lines,0,90)
    lines.append(r'\node[smallnote,anchor=west] at (82,90) {Layer insets enlarged; no inter-layer wires drawn};')
    name='fig03_xor_design_chain';finish(lines,name)
    evidence(name,[info],[{'element':'a','claim':'Actual routed DAG; source-to-DAG 4-vector equivalence','artifact':'routed_dag.json and logic.json'},
                          {'element':'b','claim':'Exact exported routes and zero-based clock phases; crossing bridges are not junctions','artifact':'layout.ifcn'},
                          {'element':'c','claim':'All 79 cell instances shown by layer (72,2,5); dots depict geometry, not dynamic charge','artifact':'device.qca'}])
    (FIG/(name+'.caption.md')).write_text('English caption\n\nA single XOR design across representations. (a) The actual routed Boolean DAG implements $(a\\lor b)\\land\\neg(a\\land b)$ and passes all four scalar input vectors against the frozen source. (b) The exported Normal 2DDWave layout occupies 12 gate-level tiles; a bridge denotes geometrically crossing, electrically separate routes. (c) All QCA cell instances are drawn separately by layer: 72 on layer 0, two on layer 1, and five on layer 2 (79 in total). The upper-layer insets are enlarged and do not depict vertical interconnects. Dot positions show cell geometry, not a simulated polarization state. All panels derive from one production run. This representation chain does not establish source-to-device waveform equivalence.\n\n中文说明\n\n同一个真实 XOR 的布线 DAG、门级布局和三层器件。12 tiles 与 79 元胞分别计数；三层分别显示，上层局部放大。布尔等价仅验证源网表与 DAG，未证明器件波形等价。\n')


def make_layouts(runs):
    lines=begin(84);infos=[];metrics=[]
    for index,algorithm in enumerate(RUNS):
        folder,info=runs[algorithm];infos.append(info)
        parsed=parse_ifcn(folder/'layout.ifcn');points=parsed[3]
        verify_layout_against_dag(parsed,json.loads((folder/'routed_dag.json').read_text()))
        width=max(x for x,y in points)-min(x for x,y in points)+1
        height=max(y for x,y in points)-min(y for x,y in points)+1
        result=json.loads((folder/'result.json').read_text())
        count=sum(map(len,parse_qca(folder/'device.qca')))
        assert count==result['metrics']['mapping']['cell_count']
        pitch=min(42/width,51/height,9.5)
        cx=26+index*56;top=13+(51-height*pitch)/2
        lines.append(f'\\node[paneltitle] at ({index*56},3) {{({chr(97+index)}) {DISPLAY[algorithm]}}};')
        gate_layout(lines,parsed,cx,top,pitch,'l'+str(index))
        lines.append(f'\\node[align=center] at ({cx},70) {{${width}\\times{height}={width*height}$ tiles; {count} QCA cells}};')
        metrics.append({'algorithm':algorithm,'width_tiles':width,'height_tiles':height,'area_tiles':width*height,'qca_cells':count,'pitch_mm':pitch})
    legend(lines,0,80)
    lines.append(r'\node[smallnote,anchor=west] at (80,80) {Panels fitted independently; $\wedge$ AND, $\vee$ OR, $\neg$ NOT, W wire};')
    name='fig04_xor_backend_layouts';finish(lines,name)
    evidence(name,infos,[{'element':'all panels','claim':'Same frozen XOR source, independently generated actual routes and phase assignments; no equal-scale area comparison','metrics':metrics}])
    (FIG/(name+'.caption.md')).write_text('English caption\n\nActual gate-level XOR layouts produced by the three exposed backends. Occupied bounding rectangles are 3 by 4, 4 by 6, and 5 by 13 tiles; the corresponding exported devices contain 79, 119, and 214 QCA cell instances. Each panel is fitted independently for legibility, so the displayed physical sizes are not area ratios. Background colors encode the zero-based clock phases exported in each IFCN artifact; only Normal uses a fixed 2DDWave template. Crossings without a junction remain separate routes. Normal and Compact use six-node Boolean decompositions, whereas June inserts buffers; this is an end-to-end flow illustration, not a comparison on an identical DAG. The June panel uses the separately recorded 600-second-budget follow-up run. These examples establish geometry and artifact provenance, not device waveform correctness.\n\n中文说明\n\n相同冻结 XOR 输入的三算法真实布局，分别为 12、24、65 tiles 和 79、119、214 元胞。各面板独立缩放，禁止从图上尺寸推断面积比例；June 的 DAG 含额外缓冲。\n')


def traces(path):
    answer={}
    for block in re.findall(r'\[TRACE\](.*?)\[#TRACE\]',path.read_text(),re.S):
        label=re.search(r'^data_labels=(.*)$',block,re.M).group(1)
        data=re.search(r'\[TRACE_DATA\](.*?)\[#TRACE_DATA\]',block,re.S).group(1)
        answer[label]=[float(x) for x in data.split()]
    return answer


def make_numerics(runs):
    folder,info=runs['normal_2ddwave'];lines=begin(114)
    for i,model in enumerate(['bistable','coherence']):
        base=traces(folder/f'simulation__simulation_{model}_baseline.rst')['out']
        fast=traces(folder/f'simulation__simulation_{model}_accelerated.rst')['out']
        assert base==fast
        table=DATA/f'normal_{model}_out.csv'
        table.write_text('sample,baseline,accelerated\n'+''.join(f'{j},{a:.12g},{b:.12g}\n' for j,(a,b) in enumerate(zip(base,fast))))
        x=11+i*85
        lines.append(f'\\node[paneltitle] at ({i*85},3) {{({chr(97+i)}) {model.capitalize()} output}};')
        lines.append(f'\\begin{{axis}}[at={{({x}mm,-44mm)}},anchor=south west,width=68mm,height=35mm,scale only axis,xmin=0,xmax={len(base)-1},ymin=-1.1,ymax=1.1,ytick={{-1,0,1}},xlabel={{Retained output sample}},ylabel={{Polarization}},ymajorgrids]')
        lines.append(f'\\addplot[normal,line width=.85pt,no marks] table[x=sample,y=baseline,col sep=comma] {{../data/device_runs/normal_{model}_out.csv}};')
        lines.append(f'\\addplot[bad,densely dashed,line width=.55pt,no marks] table[x=sample,y=accelerated,col sep=comma] {{../data/device_runs/normal_{model}_out.csv}};')
        lines.append('\\end{axis}')
    raw=(folder/'energy.txt').read_text()
    data=re.search(r'\[PER_CYCLE\]\s*(.*?)\[#PER_CYCLE\]',raw,re.S).group(1)
    rows=list(csv.DictReader(io.StringIO(data)))
    table=DATA/'normal_energy_cycles.csv'
    table.write_text('cycle,bath,error\n'+''.join(f'{row["cycle"]},{row["E_bath_eV"]},{row["E_error_eV"]}\n' for row in rows))
    lines += [r'\draw[normal,line width=.85pt] (21,56) -- (29,56);',r'\node[anchor=west] at (30,56) {Baseline};',
              r'\draw[bad,densely dashed,line width=.55pt] (59,56) -- (67,56);',r'\node[anchor=west] at (68,56) {Accelerated};',
              r'\node[smallnote,anchor=west] at (105,56) {Exported traces coincide};',
              r'\node[paneltitle] at (0,65) {(c) Reported per-cycle energy diagnostics};',
              r'\begin{axis}[at={(13mm,-102mm)},anchor=south west,width=146mm,height=30mm,scale only axis,ybar,bar width=4mm,xmin=1.4,xmax=8.6,ymin=-.012,ymax=.21,xtick={2,3,4,5,6,7,8},ytick={0,.1,.2},xlabel={Reported cycle index},ylabel={Energy (eV)},ymajorgrids,legend style={at={(.99,.97)},anchor=north east}]',
              r'\addplot[fill=normal!65,draw=normal] table[x=cycle,y=bath,col sep=comma] {../data/device_runs/normal_energy_cycles.csv};',
              r'\addlegendentry{Bath energy}',
              r'\addplot[fill=white,draw=bad,postaction={pattern=north east lines,pattern color=bad}] table[x=cycle,y=error,col sep=comma] {../data/device_runs/normal_energy_cycles.csv};',
              r'\addlegendentry{Reported energy-error term}',r'\end{axis}']
    name='figS2_numerical_diagnostics';finish(lines,name)
    evidence(name,[info],[{'element':'a,b','claim':'All retained output samples, no smoothing or alignment; baseline and accelerated serialization identical','samples':[512,3005]},
                         {'element':'c','claim':'All seven reported energy cycles, including initial large reported energy-error term; no convergence inference','artifact':'energy.txt [PER_CYCLE]'}],
             {'derived_data':[{'path':str(p.relative_to(PAPER)),'sha256':sha(p)} for p in DATA.glob('normal_*.csv')]})
    (FIG/(name+'.caption.md')).write_text('English caption\n\nNumerical diagnostics for the same Normal XOR run used in Figure 3. (a,b) All 512 Bistable and 3005 retained Coherence output samples are shown without temporal realignment, interpolation, or smoothing. Baseline and accelerated exported traces coincide, which tests implementation agreement rather than agreement with the source truth table. The abscissa is the retained sample index, not a clock-cycle or physical-time estimate. (c) All seven reported cycles of standard energy analysis are retained, including the large energy-error term in the first reported cycle. The energy step is $10^{-17}$ s; the Coherence trace comparison uses $10^{-16}$ s. The error term is a diagnostic field, not a statistical error bar. Neither a time-step study nor steady-state convergence has been established; the plotted energies do not support a power-accuracy or energy-saving claim.\n\n中文说明\n\n补充材料保留两种仿真的全部输出采样以及每周期能耗诊断。两实现曲线一致不等于符合 RTL。初始大能量误差不能隐藏；本图不作收敛、精度或节能结论。\n')


def main():
    FIG.mkdir(parents=True,exist_ok=True);DATA.mkdir(parents=True,exist_ok=True)
    runs={a:snapshot(a) for a in RUNS}
    source_hashes={sha(folder/'source.v') for folder,info in runs.values()}
    assert len(source_hashes)==1,'Layouts are not from identical frozen source bytes'
    make_chain(runs);make_layouts(runs);make_numerics(runs)
    print(json.dumps({'generated':['fig03_xor_design_chain','fig04_xor_backend_layouts','figS2_numerical_diagnostics'],'source_sha256':source_hashes.pop()}))


if __name__=='__main__':
    main()
