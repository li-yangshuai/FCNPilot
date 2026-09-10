"use client";

import { readIfcnCombinationalAcceptance } from "@/lib/ifcn-combinational-evidence";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IfcnRunArtifact, IfcnRunDetail, IfcnRunSummary } from "../lib/ifcn-results-types";
import { parseQcaLayout, qcaBounds, type QcaLayout } from "../lib/ifcn-layout";
import { IFCN_CLOCK_COLORS, IFCN_CELL_COLORS, ifcnCellColor } from "@/lib/ifcn-colors";
import { IfcnGatePreview } from "./IfcnGatePreview";
import { IfcnOptimizationCampaign } from "./IfcnOptimizationCampaign";
import { ifcnOptimizationAvailability } from "@/lib/ifcn-optimization-request";
import { readIfcnStateTransition } from "../lib/ifcn-sequential-evidence";
import { clockSchemeLabel, readIfcnAlgorithmCatalog } from "../lib/ifcn-algorithms";
const styles = {
  "actions": "ifcn-results-actions",
  "caption": "ifcn-results-caption",
  "empty": "ifcn-results-empty",
  "error": "ifcn-results-error",
  "eyebrow": "ifcn-results-eyebrow",
  "fileList": "ifcn-results-fileList",
  "footer": "ifcn-results-footer",
  "header": "ifcn-results-header",
  "legend": "ifcn-results-legend",
  "metrics": "ifcn-results-metrics",
  "notice": "ifcn-results-notice",
  "otherFiles": "ifcn-results-otherFiles",
  "panel": "ifcn-results-panel",
  "previewTabs": "ifcn-results-previewTabs",
  "qcaCanvas": "ifcn-results-qcaCanvas",
  "qcaViewport": "ifcn-results-qcaViewport",
  "runHeading": "ifcn-results-runHeading",
  "runSelector": "ifcn-results-runSelector",
  "section": "ifcn-results-section",
  "sectionHeading": "ifcn-results-sectionHeading",
  "stages": "ifcn-results-stages",
  "status": "ifcn-results-status",
  "svgViewport": "ifcn-results-svgViewport",
  "textMetric": "ifcn-results-textMetric",
  "validation": "ifcn-results-validation",
  "viewerTools": "ifcn-results-viewerTools",
  "zoom": "ifcn-results-zoom"
} as const;

const STAGES = [{ id: "parse", label: "逻辑解析" }, { id: "pnr", label: "布局布线" }, { id: "map", label: "器件映射" }, { id: "simulate", label: "电路仿真" }, { id: "energy", label: "能耗估计" }];
const OPTIMIZATION_SOURCES: Record<string, string> = { llm: "LLM优化", noop: "重布线对照", random: "随机对照", heuristic: "贪心对照" };
const ALGORITHMS: Record<string, string> = { normal_2ddwave: "Normal · 2DDWave", compact: "Compact", june_random: "June", sequential_cyclic: "时序反馈布局", regular_clock_ga: "规则时钟启发式", auto: "自动选择" };

function stateLabel(status: string) {
  return ({ completed: "已完成", layout_candidate: "版图候选", completed_with_warnings: "已完成 · 有验证限制", running: "进行中", queued: "等待中", pending: "尚未运行", failed: "未通过", blocked: "暂未完成", skipped: "已跳过", timeout: "已超时", cancelled: "已取消" } as Record<string, string>)[status] || "状态待确认";
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numeric(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function displayNumber(value: unknown) { const n = numeric(value); return n === null ? "—" : n.toLocaleString("zh-CN"); }
function time(value: string | null | undefined) {
  if (!value) return "时间未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未记录" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function errorText(error: unknown) { return error instanceof Error ? error.message : "暂时无法读取设计结果。"; }

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || "暂时无法读取设计结果。");
  return data as T;
}

function QcaPreview({ artifact }: { artifact: IfcnRunArtifact }) {
  const [state, setState] = useState<{ layout: QcaLayout | null; error: string | null }>({ layout: null, error: null });
  const [layer, setLayer] = useState("all");
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(artifact.previewUrl!, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "暂时无法读取 QCA 版图。");
        }
        return response.text();
      })
      .then((source) => setState({ layout: parseQcaLayout(source), error: null }))
      .catch((error) => { if (!controller.signal.aborted) setState({ layout: null, error: errorText(error) }); });
    return () => controller.abort();
  }, [artifact.previewUrl]);
  const cells = useMemo(() => state.layout?.cells.filter((cell) => layer === "all" || cell.layer === Number(layer)) || [], [state.layout, layer]);
  const bounds = useMemo(() => qcaBounds(cells), [cells]);
  if (state.error) return <p className={styles.notice} role="alert">{state.error}</p>;
  if (!state.layout) return <p className={styles.notice} role="status">正在读取器件版图…</p>;
  return <>
    <div className={styles.viewerTools}>
      <span>{cells.length.toLocaleString("zh-CN")} 个元胞{state.layout.layers.length > 1 ? ` · ${state.layout.layers.length} 层` : ""}</span>
      {state.layout.layers.length > 1 && <select aria-label="选择 QCA 版图层" value={layer} onChange={(event) => setLayer(event.target.value)}>
        <option value="all">所有层（叠加）</option>
        {state.layout.layers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>}
      <div className={styles.zoom}>
        <button type="button" onClick={() => setZoom((value) => Math.max(1, value - 0.5))} disabled={zoom === 1} aria-label="缩小器件版图">−</button>
        <button type="button" onClick={() => setZoom(1)} aria-label="适应器件版图大小">{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => setZoom((value) => Math.min(5, value + 0.5))} disabled={zoom === 5} aria-label="放大器件版图">+</button>
      </div>
    </div>
    <div className={styles.qcaViewport}>
      <svg className={styles.qcaCanvas} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} role="img" aria-label={`QCA 器件版图，${cells.length} 个元胞，按源文件坐标与时钟相位显示`} style={{ width: `${zoom * 100}%`, maxWidth: "none", height: `${420 * zoom}px` }}>
        <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="#f9fbfd" />
        {cells.map((cell, index) => {
          const color = ifcnCellColor(cell.clock, cell.role);
          const input = cell.role === "QCAD_CELL_INPUT";
          const output = cell.role === "QCAD_CELL_OUTPUT";
          const fixed = cell.role === "QCAD_CELL_FIXED";
          const role = input ? "输入" : output ? "输出" : fixed ? "固定极化" : "普通元胞";
          const title = `${cell.label || `元胞 ${index + 1}`} · ${role} · 坐标 (${cell.x}, ${cell.y}) · 时钟 ${cell.clock ?? "未记录"} · ${state.layout!.layers.find((item) => item.id === cell.layer)?.name || ""}`;
          return <g key={`${cell.layer}-${index}`}>
            <title>{title}</title>
            <rect x={cell.x - cell.width / 2} y={cell.y - cell.height / 2} width={cell.width} height={cell.height} rx={cell.width * 0.09} fill={color} stroke="#000000" strokeWidth={Math.min(cell.width, cell.height) * (input || output ? 0.12 : 0.06)} />
            {cell.dots.map((dot, dotIndex) => <circle key={dotIndex} cx={dot.x} cy={dot.y} r={dot.diameter / 2} fill={fixed ? "#ffffff" : color} stroke="#000000" strokeWidth={Math.min(cell.width, cell.height) * 0.035} />)}
            {(input || output) && cell.label && <text x={cell.x} y={cell.y - cell.height * 0.75} textAnchor="middle" fontSize={cell.height * 0.5} fill="#000000">{cell.label}</text>}
          </g>;
        })}
      </svg>
    </div>
    <div className={styles.legend} aria-label="QCA 时钟相位图例">{IFCN_CLOCK_COLORS.map((color, phase) => <span key={phase}><i style={{ background: color }} />相位 {phase}</span>)}<span><i style={{ background: IFCN_CELL_COLORS.input }} />输入</span><span><i style={{ background: IFCN_CELL_COLORS.output }} />输出</span><span><i style={{ background: IFCN_CELL_COLORS.fixed }} />固定元胞</span></div>
    <p className={styles.caption}>元胞、量子点和分层来自 QCA 文件；配色与 Qt 一致，普通元胞按时钟相位着色，输入、输出和固定元胞采用专用色；图中不表示仿真极化状态。</p>
  </>;
}

function LayoutPreview({ run }: { run: IfcnRunDetail }) {
  const previews = run.artifacts.filter((artifact) => artifact.previewUrl && artifact.preview === "svg").sort((a, b) => {
    const priority = (name: string) => name.includes("_physical.svg") ? 0 : name.includes("pnr/") ? 1 : 2;
    return priority(a.name) - priority(b.name);
  });
  const qca = run.artifacts.find((artifact) => artifact.name === "device.qca" && artifact.previewUrl) || run.artifacts.find((artifact) => artifact.preview === "qca" && artifact.previewUrl);
  const ifcn = run.artifacts.find((artifact) => artifact.name === "layout.ifcn" && artifact.previewUrl && artifact.preview === "ifcn") || run.artifacts.find((artifact) => artifact.preview === "ifcn" && artifact.previewUrl);
  const hasPnr = !!(previews.length || ifcn);
  const [tab, setTab] = useState<"pnr" | "qca">(hasPnr ? "pnr" : "qca");
  const [svgName, setSvgName] = useState<string | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const selectedSvg = previews.find((artifact) => artifact.name === svgName) || previews[0];
  const svgUrl = selectedSvg?.previewUrl ? `${selectedSvg.previewUrl}&v=${selectedSvg.sha256}` : null;
  const availableTab = tab === "pnr" && !hasPnr && qca ? "qca" : tab === "qca" && !qca && hasPnr ? "pnr" : tab;
  const current = availableTab === "qca" ? qca : ifcn || selectedSvg;
  return <section className={styles.section} aria-label="电路版图预览">
    <div className={styles.sectionHeading}><h3>电路版图</h3>{current && <a href={current.downloadUrl} download>下载当前版图 ↗</a>}</div>
    <div className={styles.previewTabs} role="tablist" aria-label="版图类型">
      <button type="button" role="tab" aria-selected={availableTab === "pnr"} disabled={!hasPnr} onClick={() => setTab("pnr")}>门级布局布线</button>
      <button type="button" role="tab" aria-selected={availableTab === "qca"} disabled={!qca} onClick={() => setTab("qca")}>QCA 器件版图</button>
    </div>
    {!hasPnr && !qca ? <p className={styles.notice}>当前流程尚未生成可预览的版图。完成布局布线或器件映射后，结果会显示在这里。</p> : availableTab === "qca" && qca ? <QcaPreview key={`${run.id}:${qca.sha256}`} artifact={qca} /> : ifcn ? <IfcnGatePreview key={`${run.id}:${ifcn.sha256}`} artifact={ifcn} /> : selectedSvg ? <>
      {previews.length > 1 && <div className={styles.viewerTools}><label>版图文件 <select value={selectedSvg.name} onChange={(event) => setSvgName(event.target.value)}>{previews.map((artifact) => <option key={artifact.name} value={artifact.name}>{artifact.name.split("/").pop()}</option>)}</select></label></div>}
      <div className={styles.svgViewport}>
        {failedImage === svgUrl ? <div className={styles.notice}><p>版图未能显示，文件可能已更新。可下载原文件或重新加载。</p><button type="button" onClick={() => setFailedImage(null)}>重新加载版图</button></div> : <>
          {/* The image element keeps SVG content separate from the page document. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={svgUrl!} alt={`${run.module || run.sourceName} 的门级布局布线结果`} onError={() => setFailedImage(svgUrl)} />
        </>}
      </div>
      <p className={styles.caption}>直接显示布局布线生成的 SVG；可下载原图查看门与连线细节。</p>
    </> : null}
  </section>;
}

function sequentialMetrics(run: IfcnRunDetail) {
  const sequential = object(run.metrics.sequential);
  const pnr = object(run.metrics.pnr);
  return run.designType === "sequential" || sequential.mapping_mode === "sequential" || pnr.mapping_mode === "sequential" ? sequential : null;
}

function checkLabel(value: unknown) { return value === true ? "已通过" : value === false ? "未通过" : "未记录"; }

function RunMetrics({ run }: { run: IfcnRunDetail }) {
  const pnr = object(run.metrics.pnr), mapping = object(run.metrics.mapping), logic = object(run.metrics.logic), energy = object(run.metrics.energy);
  const sequential = sequentialMetrics(run);
  const transition = readIfcnStateTransition(run.metrics, run.validation);
  const combinationalAcceptance = readIfcnCombinationalAcceptance(run.designType, run.metrics, run.validation);
  const geometrySearch = object(sequential?.geometry_search);
  const cells = mapping.cell_count ?? object(run.metrics.device_interface).cell_count ?? sequential?.mapped_qca_cells;
  const reportedPower = numeric(energy.average_dissipated_power_W);
  const invalidEnergy = (reportedPower !== null && reportedPower < 0)
    || String(run.validation.energy_numerics || energy.numerical_status || energy.status || "").startsWith("invalid");
  const dissipatedPower = invalidEnergy ? null : reportedPower;
  const physicalVerified = run.validation.physical_function === "verified";
  const simulation = Array.isArray(run.metrics.simulation) ? run.metrics.simulation : [];
  return <>
    {sequential && <section className="ifcn-sequential-result" aria-label="时序结果验证范围"><strong>{sequential.status === "layout_candidate" || run.status === "layout_candidate" ? "反馈版图候选" : "时序设计验证范围"}</strong><p>{sequential.physical_state_signoff === "not_characterized" || !sequential.physical_state_signoff ? "状态器件尚未完成物理表征与签核。" : `状态器件验证记录：${String(sequential.physical_state_signoff)}。`}布线与相位检查、状态转移检查分别报告；流程执行完成不等于器件时序功能已验证。</p><dl>
      {numeric(geometrySearch.selected_rank) !== null && <div><dt>选中候选的原生序号</dt><dd>{displayNumber(geometrySearch.selected_rank)}</dd></div>}
      {numeric(geometrySearch.attempted_candidates) !== null && <div><dt>已尝试布局候选</dt><dd>{displayNumber(geometrySearch.attempted_candidates)}</dd></div>}
      <div><dt>反馈路径</dt><dd>{displayNumber(sequential.feedback_routes)}</dd></div>
      <div><dt>有向反馈环</dt><dd>{sequential.directed_cycle_present === true ? "已记录" : sequential.directed_cycle_present === false ? "未发现" : "未记录"}</dd></div>
      <div><dt>映射规则检查</dt><dd>{checkLabel(sequential.mapping_drc)}</dd></div>
      <div><dt>相位规则检查</dt><dd>{checkLabel(sequential.tile_phase_drc)}</dd></div>
      <div><dt>连续同相网格上限（观测）</dt><dd>{displayNumber(sequential.max_observed_same_phase_tile_run)}</dd></div>
    </dl><div className="ifcn-state-transition" data-status={transition.status || "unknown"}><strong>{transition.scopeLabel}</strong><p><b>{transition.statusLabel}</b>{transition.vectorsChecked !== null ? ` · 已检查 ${displayNumber(transition.vectorsChecked)} 组状态 / 输入` : ""}</p><p>{transition.stateBits !== null ? `${transition.stateBits} 个状态位` : "状态位数未记录"}{transition.inputBits !== null ? ` · ${transition.inputBits} 个输入位` : ""}{transition.gateNodes !== null ? ` · ${transition.gateNodes} 个逻辑门` : ""}</p><p>该检查对照一次下一状态关系；原始 RTL 的完整等价性尚无独立证明，器件时序功能另行验证。</p></div>{Array.isArray(sequential.state_boundaries) && sequential.state_boundaries.length > 0 && <details><summary>查看状态边界</summary><ul>{sequential.state_boundaries.map((item, index) => { const boundary = object(item); return <li key={index}>{typeof boundary.data_event === "string" ? boundary.data_event : "D 未记录"} → {typeof boundary.q_event === "string" ? boundary.q_event : "Q 未记录"}{numeric(boundary.iteration_distance) !== null ? ` · 迭代距离 ${boundary.iteration_distance}` : ""}</li>; })}</ul></details>}</section>}
    <div className={styles.metrics}>
      <div><span>门级面积</span><strong>{displayNumber(pnr.area_tiles ?? sequential?.bbox_area)}<small> tiles</small></strong><p>{numeric(pnr.width) !== null && numeric(pnr.height) !== null ? `${pnr.width} × ${pnr.height} 门级网格` : "等待布局结果"}</p></div>
      <div><span>QCA 元胞</span><strong>{displayNumber(cells)}<small> 个</small></strong><p>器件映射后的元胞数量</p></div>
      {sequential ? <div><span>状态边界</span><strong>{displayNumber(sequential.state_boundary_count)}<small> 个</small></strong><p>由实际 D/Q 状态连接记录</p></div> : <div><span>逻辑等价</span><strong className={styles.textMetric}>{logic.status === "equivalent" ? "已匹配" : logic.status === "not_equivalent" || logic.status === "failed" ? "未通过" : "尚未验证"}</strong><p>{numeric(logic.vectors_checked) !== null ? `已检查 ${displayNumber(logic.vectors_checked)} 组输入` : "源电路与布线后的逻辑图"}</p></div>}
      {sequential ? <div><span>启动间隔</span><strong>{displayNumber(sequential.initiation_interval)}</strong><p>原生相位 / epoch 约束记录</p></div> : <div><span>模型耗散功率</span><strong>{dissipatedPower === null ? "—" : (dissipatedPower * 1e9).toPrecision(3)}{dissipatedPower !== null && <small> nW</small>}</strong><p>{invalidEnergy ? "数值检查异常，未采用功率值" : dissipatedPower === null ? "等待能耗估计" : "平均热浴能量 / 时钟周期"}</p></div>}
    </div>
    <div className={styles.validation}>
      <strong>结果的验证范围</strong>
      {combinationalAcceptance && <div aria-label="组合电路新增验收"><dl>{combinationalAcceptance.map((check) => <div key={check.id}><dt>{check.label}</dt><dd>{check.passed ? "已记录新增验收通过" : "缺少新增验收通过记录"}</dd></div>)}</dl>{combinationalAcceptance.some((check) => !check.passed) && <p>当前记录尚不具备上述全部新增验收证据。历史结果保留原始状态，不自动视为通过新增验收，也不据此判定电路失败。</p>}</div>}
      <p>{physicalVerified ? "已记录器件功能验证结果。" : "器件功能尚未完成验证。"}{simulation.length ? "仿真对比检查基线与加速求解的一致性。" : ""}{dissipatedPower !== null ? "功率数值是模型估计；时间步长收敛情况需单独确认。" : ""}</p>
      {sequential && (dissipatedPower !== null || invalidEnergy) && <p>{invalidEnergy ? "能耗数值检查异常，未采用功率值。" : `探索性模型耗散功率：${(dissipatedPower! * 1e9).toPrecision(3)} nW；不构成时序器件功耗签核。`}</p>}
      {Object.keys(run.validation).length > 0 && <details><summary>查看各项验证记录</summary><dl>{Object.entries(run.validation).map(([key, value]) => <div key={key}><dt>{({ clock_arrival: "整周期到达检查", physical_routes: "跨源隔离与物理路径检查", rtl_equivalence: "逻辑等价范围", state_transition: "状态转移检查", physical_state_signoff: "状态器件签核", sequential: "时序验证范围", sequential_equivalence: "状态转移检查", physical_function: "器件功能", simulation_comparison: "仿真对比范围", energy: "能耗范围", device_terminal_counts: "输入输出端子", simulation_iteration_limit_samples: "达到迭代上限的采样数", energy_numerics: "能耗数值状态" } as Record<string, string>)[key] || key}</dt><dd>{key === "sequential_equivalence" ? transition.statusLabel : key === "sequential" ? `${transition.scopeLabel}；${transition.statusLabel}；${object(value).rtl_equivalence === "not_independently_proven" ? "原始 RTL 等价性未独立证明" : "RTL 等价范围以报告为准"}；${object(value).physical_state_signoff === "not_characterized" ? "状态器件未表征" : "状态器件状态以报告为准"}；${object(value).feedback_topology === "preserved" ? "反馈拓扑已保留" : "反馈拓扑未确认"}；相位规则检查：${checkLabel(object(value).tile_phase_drc)}` : typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</dd></div>)}</dl></details>}
    </div>
  </>;
}

const FILE_LABELS: Record<string, string> = { "campaign.json": "布局优化实验完整记录", "source.v": "输入电路", "normalized.v": "规范化 Verilog", "layout.ifcn": "门级版图", "device.qca": "QCA 器件版图", "dag.json": "逻辑 DAG", "simulation.json": "电路仿真结果", "energy.json": "能耗估计", "result.json": "完整设计结果", "logic.json": "逻辑等价检查", "clock.json": "整周期到达检查证书", "physical.json": "跨源隔离与物理路径检查证书", "interface.json": "器件端子检查", "seqir.json": "时序中间表示", "state_manifest.json": "状态边界清单", "sequential_validation.json": "状态转移检查", "yosys.json": "综合逻辑网表", "pnr.json": "布局布线检查", "sequential_pnr.json": "时序原生布局检查", "geometry_attempts.json": "布局候选尝试记录" };

function ResultFiles({ run }: { run: IfcnRunDetail }) {
  const primary = run.artifacts.filter((artifact) => FILE_LABELS[artifact.name]);
  const rest = run.artifacts.filter((artifact) => !FILE_LABELS[artifact.name]);
  const fileLabel = (artifact: IfcnRunArtifact) => sequentialMetrics(run) && artifact.name === "normalized.v" ? "状态切分后的组合 Verilog" : sequentialMetrics(run) && artifact.name === "dag.json" ? "状态切分 DAG" : FILE_LABELS[artifact.name] || artifact.name.split("/").pop();
  const rows = (artifacts: IfcnRunArtifact[]) => <ul className={styles.fileList}>{artifacts.map((artifact) => <li key={artifact.name}><div><strong>{fileLabel(artifact)}</strong><span title={artifact.name}>{artifact.name} · {size(artifact.bytes)}</span></div><a href={artifact.downloadUrl} download aria-label={`下载 ${artifact.name}`}>下载 <span aria-hidden>↓</span></a></li>)}</ul>;
  return <section className={styles.section} aria-label="电路结果文件"><div className={styles.sectionHeading}><h3>结果文件</h3><span>{run.artifacts.length} 个文件</span></div>
    {run.artifacts.length ? <>{rows(primary)}{rest.length > 0 && <details className={styles.otherFiles}><summary>查看其余 {rest.length} 个文件</summary>{rows(rest)}</details>}</> : <p className={styles.notice}>尚未生成结果文件。</p>}
  </section>;
}

export function IfcnResults({ active = true, onClose, capabilities, onShowAlgorithms, onOptimizeRun, optimizationReady = false }: { active?: boolean; onClose?: () => void; capabilities?: unknown; onShowAlgorithms?: () => void; onOptimizeRun?: (run: IfcnRunDetail) => Promise<void>; optimizationReady?: boolean }) {
  const [runs, setRuns] = useState<IfcnRunSummary[]>([]);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizationError, setOptimizationError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<IfcnRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const selection = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let busy = false;
    const update = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const data = await readJson<{ runs: IfcnRunSummary[] }>("/api/ifcn/runs", controller.signal);
        if (controller.signal.aborted) return;
        setRuns(data.runs);
        const next = data.runs.some((run) => run.id === selection.current) ? selection.current : data.runs[0]?.id || null;
        selection.current = next;
        setSelected(next);
        if (next) {
          const result = await readJson<IfcnRunDetail>(`/api/ifcn/runs/${encodeURIComponent(next)}`, controller.signal);
          if (!controller.signal.aborted && selection.current === next) { setDetail(result); setError(null); }
        } else { setDetail(null); setError(null); }
      } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)); }
      finally { busy = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, 8000);
    const onVisible = () => { if (document.visibilityState === "visible") void update(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [active, refresh]);

  const current = detail?.id === selected ? detail : null;
  const optimization = current ? ifcnOptimizationAvailability(current) : null;
  const catalog = useMemo(() => readIfcnAlgorithmCatalog(capabilities), [capabilities]);
  const pnr = object(current?.metrics.pnr);
  const recordedAlgorithm = typeof pnr.algorithm === "string" ? pnr.algorithm : current?.algorithm;
  const classification = catalog.entries.find((entry) => entry.runAlgorithm === recordedAlgorithm);
  const recordedClock = clockSchemeLabel(pnr.clock_scheme);
  const choose = (id: string) => { setOptimizationError(null); selection.current = id; setSelected(id); setError(null); setLoading(true); setRefresh((value) => value + 1); };
  return <section className={styles.panel} aria-label="FCN 电路版图与结果">
    <header className={styles.header}><div><span className={styles.eyebrow}>FCNPilot / DESIGN RESULTS</span><h2>版图与结果</h2><p>查看电路设计进度、实际版图和可下载文件。</p></div><div className={styles.actions}><button type="button" onClick={() => { setLoading(true); setRefresh((value) => value + 1); }} aria-label="刷新电路结果" disabled={loading}>↻ 刷新</button>{onClose && <button type="button" onClick={onClose} aria-label="关闭电路结果">×</button>}</div></header>
    {error && <p className={styles.error} role="alert">{error}{current ? " 当前显示上次读取的结果。" : ""}</p>}
    {runs.length > 0 && <div className={styles.runSelector}><label htmlFor="ifcn-result-run">电路设计记录</label><select id="ifcn-result-run" value={selected || ""} onChange={(event) => choose(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{run.module || run.sourceName || run.id.slice(0, 8)}{run.optimizationPolicy ? ` · ${OPTIMIZATION_SOURCES[run.optimizationPolicy]}` : ""} · {ALGORITHMS[run.algorithm || ""] || run.algorithm || "待选择算法"}{run.algorithm === "regular_clock_ga" && run.clockScheme ? ` · ${run.clockScheme}` : ""} · {stateLabel(run.status)} · {time(run.createdAt)} · {run.id.slice(0, 6)}</option>)}</select></div>}
    {loading && !current ? <p className={styles.empty} role="status">正在读取电路设计结果…</p> : !current && !error ? <div className={styles.empty}><svg width="68" height="68" viewBox="0 0 68 68" fill="none" aria-hidden><rect x="13" y="13" width="42" height="42" rx="10" stroke="currentColor" strokeWidth="1.5" /><path d="M21 34h9V23h17M30 34v12h17M47 23v23M21 46h9" stroke="currentColor" strokeWidth="2" /><circle cx="21" cy="34" r="3" fill="currentColor" /><circle cx="47" cy="23" r="3" fill="currentColor" /><circle cx="47" cy="46" r="3" fill="currentColor" /></svg><h3>从一份电路开始</h3><p>在设计对话中提供 Verilog，或运行 XOR 示例。生成的门级版图、QCA 元胞版图和结果文件会自动汇集到这里。</p></div> : null}
    {current && <>
      <div className={styles.runHeading}><div><h3>{current.module || current.sourceName}{current.optimizationPolicy ? ` · ${OPTIMIZATION_SOURCES[current.optimizationPolicy]}` : ""}</h3><p title={current.sourceName}>{current.sourceName} · {sequentialMetrics(current) ? "时序电路" : current.designType === "combinational" ? "组合电路" : "模式未记录"} · {ALGORITHMS[current.algorithm || ""] || current.algorithm || "算法尚未选择"}{current.algorithm === "regular_clock_ga" && current.clockScheme ? ` · ${current.clockScheme}` : ""}</p></div><span className={styles.status} data-status={current.status}>{current.status === "completed" ? "流程已完成" : stateLabel(current.status)}</span></div>
      <div className="ifcn-result-classification"><span>运行记录时钟：{recordedClock || "未记录"}{numeric(pnr.phase_count) !== null ? ` · ${pnr.phase_count} 相` : ""}</span>{classification && classification.method !== "unclassified" && <span>目录方法归类：{classification.methodLabel}</span>}{onShowAlgorithms && <button type="button" onClick={onShowAlgorithms}>对照规模与时钟 ↗</button>}</div>
      <ol className={styles.stages} aria-label="电路设计流程进度">{STAGES.map((stage, index) => { const status = current.stages.find((item) => item.id === stage.id)?.status || "pending"; return <li key={stage.id} data-status={status} title={stateLabel(status)}><span>{status === "completed" ? "✓" : String(index + 1).padStart(2, "0")}</span><strong>{stage.id === "parse" && sequentialMetrics(current) ? "状态与逻辑解析" : stage.label}</strong><small>{stateLabel(status)}</small></li>; })}</ol>
      {current.error && <p className={styles.error} role="alert">{current.error}</p>}
      <RunMetrics run={current} />
      {onOptimizeRun && optimization && <section className="ifcn-optimize-action" aria-label="主智能体布局优化"><div><strong>在当前版图上继续优化</strong><p>{optimization.available && !optimizationReady ? "主智能体正在运行或尚未就绪；请等待当前对话完成并确认模型已连接。" : optimization.reason}</p></div><button type="button" disabled={!optimization.available || !optimizationReady || optimizing || loading} onClick={async () => {
        setOptimizing(true); setOptimizationError(null);
        try { await onOptimizeRun(current); } catch (failure) { setOptimizationError(errorText(failure)); } finally { setOptimizing(false); }
      }}>{optimizing ? "正在交给主智能体…" : "让主智能体优化布局"}</button>{optimizationError && <p role="alert">{optimizationError}</p>}</section>}
      <IfcnOptimizationCampaign key={`campaign:${current.id}`} run={current} />
      <LayoutPreview key={current.id} run={current} />
      <ResultFiles run={current} />
      <p className={styles.footer}>记录 {current.id.slice(0, 12)} · 更新于 {time(current.updatedAt)}{loading ? " · 正在刷新…" : ""}</p>
    </>}
  </section>;
}
