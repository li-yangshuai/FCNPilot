"use client";

import { ifcnGateClockColor } from "@/lib/ifcn-colors";

import { useEffect, useMemo, useState } from "react";
import type { IfcnRunArtifact, IfcnRunDetail } from "@/lib/ifcn-results-types";
import { IFCN_GATE_MAX_BYTES, parseIfcnGateLayout, type IfcnGateLayout } from "@/lib/ifcn-gate-layout";
import { IFCN_CAMPAIGN_MAX_BYTES, campaignPhaseRepairLabel, campaignMetricChange, compareCampaignLayouts, parseIfcnOptimizationCampaign, type CampaignPoint, type CampaignSnapshot, type CampaignRound, type IfcnOptimizationCampaign as Campaign } from "@/lib/ifcn-optimization-campaign";

const number = (value: number | null) => value === null ? "未记录" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const coordinate = (value: CampaignPoint) => `(${value[0]}, ${value[1]})`;
const check = (value: boolean | null) => value === true ? "通过" : value === false ? "未通过" : "未记录";
const status = (value: string) => ({ accepted: "已接纳", rejected: "已拒绝", failed: "执行未完成", cancelled: "已取消", completed: "实验已结束", running: "实验进行中", pending: "等待中" } as Record<string, string>)[value] || value;
const sourceLabel = (value: string | null) => value === "llm" ? "LLM 建议" : value === "random" ? "随机建议（对照）" : value === "heuristic" ? "确定性贪心建议（对照）" : value === "noop" ? "无操作（对照）" : "建议来源未记录";
const errorText = (error: unknown) => error instanceof Error ? error.message : "结果读取失败。";

async function artifactText(artifact: IfcnRunArtifact, limit: number, signal: AbortSignal) {
  if (artifact.bytes > limit) throw new Error("文件超过内嵌显示限制，请下载原文件。");
  const response = await fetch(artifact.downloadUrl, { cache: "no-store", signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "无法读取实验产物。"); }
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("文件超过内嵌显示限制，请下载原文件。"); }
  const text = await response.text();
  if (new TextEncoder().encode(text).length > limit) throw new Error("文件超过内嵌显示限制，请下载原文件。");
  return text;
}
function RawArtifact({ artifact }: { artifact: IfcnRunArtifact }) {
  const [state, setState] = useState({ text: "", error: "", loading: true });
  useEffect(() => {
    const controller = new AbortController();
    void artifactText(artifact, 256 * 1024, controller.signal).then((text) => { if (!controller.signal.aborted) setState({ text, error: "", loading: false }); }).catch((error) => { if (!controller.signal.aborted) setState({ text: "", error: errorText(error), loading: false }); });
    return () => controller.abort();
  }, [artifact]);
  return state.loading ? <p>正在读取原始记录…</p> : state.error ? <p role="alert">{state.error}</p> : <pre className="ifcn-campaign-raw">{state.text}</pre>;
}
function EvidenceFile({ name, label, artifacts }: { name: string | null; label: string; artifacts: Map<string, IfcnRunArtifact> }) {
  const [open, setOpen] = useState(false), artifact = name ? artifacts.get(name) : null;
  if (!artifact) return null;
  return <details className="ifcn-campaign-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{label} <span>{artifact.name}</span></summary><a href={artifact.downloadUrl} download>下载原文件 ↓</a>{open && <RawArtifact key={artifact.sha256} artifact={artifact} />}</details>;
}
function useLayout(artifact: IfcnRunArtifact | undefined) {
  const [state, setState] = useState<{ layout: IfcnGateLayout | null; error: string }>({ layout: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ layout: null, error: "" });
    if (artifact) void artifactText(artifact, IFCN_GATE_MAX_BYTES, controller.signal).then((text) => { const layout = parseIfcnGateLayout(text); if (!controller.signal.aborted) setState({ layout, error: "" }); }).catch((error) => { if (!controller.signal.aborted) setState({ layout: null, error: errorText(error) }); });
    return () => controller.abort();
  }, [artifact]);
  return state;
}
function ComparisonCanvas({ layout, origin, bounds, moved, focused, title }: { layout: IfcnGateLayout; origin: CampaignPoint; bounds: IfcnGateLayout["bounds"]; moved: Set<string>; focused: string | null; title: string }) {
  return <svg viewBox={`${bounds.x - 1} ${bounds.y - 1} ${bounds.width + 1} ${bounds.height + 1}`} role="img" aria-label={title}>
    <g transform={`translate(${origin[0]} ${origin[1]})`}>
      {layout.phases.map((item) => <rect key={`${item.x},${item.y}`} x={item.x - .43} y={item.y - .43} width={.86} height={.86} rx={.08} fill={ifcnGateClockColor(item.phase, layout.phaseCount)} stroke="#c6c9cf" strokeWidth={.02}><title>世界坐标 {coordinate([item.x + origin[0], item.y + origin[1]])} · 相位 {item.phase}</title></rect>)}
      {layout.routes.map((item, index) => <polyline key={index} points={item.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#52738b" strokeWidth={.07} opacity={focused === null || String(item.source) === focused || String(item.target) === focused ? .9 : .2} strokeDasharray={item.iterationDistance ? ".18 .1" : undefined}><title>{item.source} → {item.target} · {item.points.length} 个路径点</title></polyline>)}
      {layout.nodes.map((item) => { const highlight = moved.has(String(item.id)), selected = focused === String(item.id); return <g key={item.id} opacity={focused === null || selected ? 1 : .45}><title>节点 {item.id} · {item.name} · {item.kind} · 世界坐标 {coordinate([item.x + origin[0], item.y + origin[1]])}{highlight ? " · 前后位置改变" : ""}</title>{highlight && <circle cx={item.x} cy={item.y} r={.43} fill="#e38b30" fillOpacity={.2} stroke="#bf6a19" strokeWidth={selected ? .1 : .055} />}<rect x={item.x - .28} y={item.y - .24} width={.56} height={.48} rx={.09} fill="#fff" stroke={highlight ? "#bf6a19" : "#405a70"} strokeWidth={.055} /><text x={item.x} y={item.y + .06} fontSize={.17} textAnchor="middle" fill="#263f53">{item.kind.slice(0, 4)}</text><text x={item.x} y={item.y + .48} fontSize={.2} textAnchor="middle" fill="#263f53">{item.name}</text></g>; })}
    </g>
  </svg>;
}
function SnapshotChecks({ snapshot }: { snapshot: CampaignSnapshot }) {
  return <p className="ifcn-campaign-checks">整周期到达：{check(snapshot.validation.clockArrival)} · 跨源隔离与路径：{check(snapshot.validation.physicalRoutes)} · 逻辑检查：{(snapshot.validation.rtlEquivalence === "equivalent" || snapshot.validation.rtlEquivalence === "exhaustive_scalar_source_vs_routed_dag") ? "源电路与布线 DAG 已穷举匹配" : snapshot.validation.rtlEquivalence || "未记录"}</p>;
}
function MetricTable({ before, after }: { before: CampaignSnapshot; after: CampaignSnapshot | null }) {
  return <table className="ifcn-campaign-table"><thead><tr><th>指标</th><th>起点</th><th>对照版本</th><th>变化</th></tr></thead><tbody>{([["门级面积（tiles）", "areaTiles"], ["QCA 元胞", "qcaCells"]] as const).map(([label, key]) => { const previous = before.metrics[key], next = after?.metrics[key] ?? null, change = campaignMetricChange(previous, next); return <tr key={key}><th>{label}</th><td>{number(previous)}</td><td>{number(next)}</td><td>{change ? `${change.difference > 0 ? "+" : ""}${number(change.difference)}${change.reductionPercent !== null ? `（${change.reductionPercent >= 0 ? "减少" : "增加"} ${number(Math.abs(change.reductionPercent))}%）` : ""}` : "无法比较"}</td></tr>; })}</tbody></table>;
}
function LayoutComparison({ before, after, beforeLabel = "本轮起点", afterLabel, artifacts, round }: { before: CampaignSnapshot; beforeLabel?: string; after: CampaignSnapshot | null; afterLabel: string; artifacts: Map<string, IfcnRunArtifact>; round?: CampaignRound }) {
  const leftArtifact = before.layoutArtifact ? artifacts.get(before.layoutArtifact) : undefined, rightArtifact = after?.layoutArtifact ? artifacts.get(after.layoutArtifact) : undefined;
  const left = useLayout(leftArtifact), right = useLayout(rightArtifact);
  const [focused, setFocused] = useState<string | null>(null);
  const difference = useMemo(() => left.layout && right.layout && after ? compareCampaignLayouts(left.layout, right.layout, before.origin, after.origin) : null, [left.layout, right.layout, before.origin, after]);
  const moved = new Set(difference?.moves.map((move) => String(move.nodeId)) || []);
  const actualMoves = round?.execution.actualMoves || difference?.moves || [];
  const mismatch = difference?.comparable && round && (difference.moves.length !== actualMoves.length || actualMoves.some((move) => !difference.moves.some((observed) => String(observed.nodeId) === String(move.nodeId) && observed.from.every((value, index) => value === move.from[index]) && observed.to.every((value, index) => value === move.to[index]))));
  return <>
    <MetricTable before={before} after={after} />
    <div className="ifcn-campaign-comparison">{([{ label: beforeLabel, snapshot: before, artifact: leftArtifact, state: left }, { label: afterLabel, snapshot: after, artifact: rightArtifact, state: right }] as const).map((side, index) => <section key={index}><div className="ifcn-campaign-sideTitle"><strong>{side.label}</strong>{side.artifact && <a href={side.artifact.downloadUrl} download>下载版图 ↓</a>}</div>{side.state.error ? <p role="alert">{side.state.error}</p> : !side.snapshot || !side.artifact ? <p>没有形成可显示的候选版图。</p> : !side.state.layout ? <p>正在读取真实版图…</p> : <ComparisonCanvas layout={side.state.layout} origin={side.snapshot.origin} bounds={difference?.bounds || { ...side.state.layout.bounds, x: side.state.layout.bounds.x + side.snapshot.origin[0], y: side.state.layout.bounds.y + side.snapshot.origin[1] }} moved={moved} focused={focused} title={`${side.label}；橙圈为实际位置变化的节点`} />}{side.snapshot && <SnapshotChecks snapshot={side.snapshot} />}</section>)}</div>
    <p className="ifcn-campaign-note">两图使用相同世界坐标；颜色表示记录的时钟相位，橙圈只标记两份版图中实际移动的节点。布线路径来自各自 IFCN，不表示 LLM 直接完成了布线或相位求解。</p>
    {difference && !difference.comparable && <p role="alert">前后节点标识或拓扑不一致，未作节点移动高亮。</p>}
    {mismatch && <p role="alert">执行移动记录与版图坐标对照不一致。图中高亮以实际版图为准，请核对原始执行日志。</p>}
    <div className="ifcn-campaign-tableWrap"><table className="ifcn-campaign-table"><caption>{round ? "执行器记录的实际节点移动" : "基线与最终版图的实际节点变化"}</caption><thead><tr><th>节点</th><th>原位置</th><th>实际位置</th></tr></thead><tbody>{actualMoves.map((move, index) => <tr key={`${move.nodeId}:${index}`} data-focused={focused === String(move.nodeId)}><td><button type="button" onClick={() => setFocused((old) => old === String(move.nodeId) ? null : String(move.nodeId))} aria-pressed={focused === String(move.nodeId)}>#{move.nodeId} {move.name}</button></td><td>{coordinate(move.from)}</td><td>{coordinate(move.to)}</td></tr>)}{!actualMoves.length && <tr><td colSpan={3}>未记录实际节点移动。</td></tr>}</tbody></table></div>
  </>;
}
function CampaignView({ campaign, artifacts }: { campaign: Campaign; artifacts: Map<string, IfcnRunArtifact> }) {
  const [selected, setSelected] = useState("overview");
  const round = campaign.rounds.find((item) => String(item.id) === selected);
  return <>
    <p className="ifcn-campaign-intro"><strong>{sourceLabel(campaign.policy)}实验</strong> · {status(campaign.status)} · {campaign.rounds.length} 轮{campaign.budget.rounds !== null ? ` / 预算 ${campaign.budget.rounds} 轮` : ""}{campaign.selectedRound === null ? " · 最终保留基线" : ` · 最终选择第 ${campaign.selectedRound} 轮`}</p>
    <p className="ifcn-campaign-note">{campaign.policy === "llm" ? "LLM 提供节点调整建议。" : campaign.policy === "random" ? "本实验使用随机建议，不含 LLM 布局决策。" : campaign.policy === "heuristic" ? "本实验使用确定性贪心建议，不含 LLM 布局决策。" : "本实验不提出节点调整建议，用于观察执行器自身变化。"}确定性布线器和相位求解器执行候选，规则检查决定是否接纳。总收益包含执行器作用，不能据此单独归因于 LLM。</p>
    <details className="ifcn-campaign-evidence"><summary>查看归因与实验约束原始记录</summary><p className="ifcn-campaign-attribution">{campaign.attribution}</p></details>
    <label className="ifcn-campaign-select">查看实验版本 <select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="overview">总览：基线 → 最终选择</option>{campaign.rounds.map((item) => <option key={item.id} value={item.id}>第 {item.id} 轮 · {sourceLabel(item.proposal.source)} · {status(item.acceptance.status)}</option>)}</select></label>
    <div className="ifcn-campaign-tableWrap"><table className="ifcn-campaign-table"><caption>全部轮次（含未通过候选）</caption><thead><tr><th>轮次 / 来源</th><th>建议操作</th><th>实际移动</th><th>验收</th><th>候选面积 / 元胞</th></tr></thead><tbody>{campaign.rounds.map((item) => <tr key={item.id}><td><button type="button" onClick={() => setSelected(String(item.id))}>第 {item.id} 轮 · {sourceLabel(item.proposal.source)}</button></td><td>{item.proposal.operations.length}</td><td>{item.execution.actualMoves.length}</td><td>{status(item.acceptance.status)}</td><td>{number(item.execution.candidate?.metrics.areaTiles ?? null)} / {number(item.execution.candidate?.metrics.qcaCells ?? null)}</td></tr>)}</tbody></table></div>
    {round ? <div key={round.id} className="ifcn-campaign-round">
      <h4>第 {round.id} 轮 · {status(round.acceptance.status)}</h4>
      <p><strong>规则验收：</strong>{round.acceptance.reasons.length ? round.acceptance.reasons.join("；") : "未提供理由。"}{round.acceptance.status !== "accepted" ? " 该候选未作为已接纳结果。" : ""}</p>
      <details open className="ifcn-campaign-proposal"><summary>{sourceLabel(round.proposal.source)}{round.proposal.model.modelId ? ` · ${round.proposal.model.provider || "提供方未记录"} / ${round.proposal.model.modelId}` : ""}</summary><p className="ifcn-campaign-note">总 tokens：{number(round.proposal.totalTokens)} · 模型响应耗时：{round.proposal.latencyMs === null ? "未记录" : `${number(round.proposal.latencyMs)} ms`}</p><p>{round.proposal.rationale || "未记录建议理由。"}</p><ul>{round.proposal.operations.map((operation, index) => <li key={index}>{operation.op === "move" ? `请求移动节点 ${operation.node} 到 ${coordinate(operation.to)}` : `请求交换节点 ${operation.nodes[0]} 与 ${operation.nodes[1]}`}</li>)}</ul>{!round.proposal.operations.length && <p>本轮未提出节点操作。</p>}</details>
      <p><strong>实际执行：</strong>{round.execution.executor} · 重新布线 {round.execution.reroutedEdges.length} 条边 · 相位改变 {number(round.execution.phaseChangedTiles)} 个网格 · 额外相位修复：{campaignPhaseRepairLabel(round.execution.phaseRepaired)}{round.elapsedS !== null ? ` · 用时 ${number(round.elapsedS)} 秒` : ""}</p>
      <LayoutComparison before={round.start} after={round.execution.candidate} afterLabel={`实际候选 · ${status(round.acceptance.status)}`} artifacts={artifacts} round={round} />
      {round.execution.reroutedEdges.length > 0 && <details><summary>查看重新布线的边与路径长度</summary><div className="ifcn-campaign-tableWrap"><table className="ifcn-campaign-table"><thead><tr><th>边</th><th>原长度</th><th>实际长度</th></tr></thead><tbody>{round.execution.reroutedEdges.map((edge, index) => <tr key={index}><td>{edge.source} → {edge.target}</td><td>{number(edge.beforeLength)}</td><td>{number(edge.afterLength)}</td></tr>)}</tbody></table></div></details>}
      <EvidenceFile name={round.proposal.artifact} label="原始建议文件" artifacts={artifacts} />
      <EvidenceFile name={round.proposal.responseArtifact} label="模型原始响应" artifacts={artifacts} />
      <EvidenceFile name={round.proposal.requestArtifact} label="模型原始请求" artifacts={artifacts} />
      {round.execution.logs.map((name) => <EvidenceFile key={name} name={name} label="执行日志" artifacts={artifacts} />)}
      <EvidenceFile name={round.execution.candidate?.candidateArtifact || null} label="原生候选记录" artifacts={artifacts} />
    </div> : <LayoutComparison key="overview" beforeLabel="基线" before={campaign.baseline} after={campaign.selected} afterLabel={campaign.selectedRound === null ? "最终选择 · 保留基线" : `最终选择 · 第 ${campaign.selectedRound} 轮`} artifacts={artifacts} />}
  </>;
}
export function IfcnOptimizationCampaign({ run }: { run: IfcnRunDetail }) {
  const artifact = run.artifacts.find((item) => item.name === "campaign.json");
  const artifacts = useMemo(() => new Map(run.artifacts.map((item) => [item.name, item])), [run.artifacts]);
  const [state, setState] = useState<{ campaign: Campaign | null; error: string }>({ campaign: null, error: "" });
  useEffect(() => {
    if (!artifact) return;
    const controller = new AbortController();
    void artifactText(artifact, IFCN_CAMPAIGN_MAX_BYTES, controller.signal).then((source) => { const campaign = parseIfcnOptimizationCampaign(source, run.artifacts); if (!controller.signal.aborted) setState({ campaign, error: "" }); }).catch((error) => { if (!controller.signal.aborted) setState({ campaign: null, error: errorText(error) }); });
    return () => controller.abort();
  }, [artifact, run.artifacts]);
  if (!artifact) return null;
  return <section className="ifcn-results-section ifcn-campaign" aria-label="布局优化实验"><div className="ifcn-results-sectionHeading"><h3>布局优化实验</h3><a href={artifact.downloadUrl} download>下载完整实验记录 ↓</a></div><div className="ifcn-campaign-body">{state.error ? <p role="alert">{state.error} 原始实验文件仍可下载。</p> : state.campaign ? <CampaignView campaign={state.campaign} artifacts={artifacts} /> : <p role="status">正在读取优化建议、实际执行与验收记录…</p>}</div></section>;
}
