"use client";

import { useEffect, useMemo, useState } from "react";
import type { IfcnRunArtifact } from "@/lib/ifcn-results-types";
import { IFCN_GATE_MAX_BYTES, parseIfcnGateLayout, type IfcnGateLayout } from "@/lib/ifcn-gate-layout";
import { IFCN_CELL_COLORS, ifcnGateClockColor } from "@/lib/ifcn-colors";
const SYMBOLS: Record<string, string> = { input: "IN", output: "OUT", and: "∧", or: "∨", not: "¬", maj: "MAJ", majority: "MAJ", buffer: "BUF", buf: "BUF" };

export function IfcnGatePreview({ artifact }: { artifact: IfcnRunArtifact }) {
  const [layout, setLayout] = useState<IfcnGateLayout | null>(null), [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1), [route, setRoute] = useState("all");
  useEffect(() => {
    const controller = new AbortController();
    setLayout(null); setError(null);
    void fetch(artifact.previewUrl!, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "无法读取 IFCN 门级版图。"); }
      if (artifact.bytes > IFCN_GATE_MAX_BYTES || Number(response.headers.get("content-length")) > IFCN_GATE_MAX_BYTES) { await response.body?.cancel(); throw new Error("IFCN 文件过大，请下载原文件查看。"); }
      const parsed = parseIfcnGateLayout(await response.text());
      if (!controller.signal.aborted) setLayout(parsed);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [artifact.previewUrl, artifact.bytes]);
  const nodes = useMemo(() => new Map(layout?.nodes.map((node) => [node.id, node]) || []), [layout]);
  if (error) return <p className="ifcn-results-notice" role="alert">{error} 原文件仍可下载。</p>;
  if (!layout) return <p className="ifcn-results-notice" role="status">正在读取门节点、布线路径与时钟相位…</p>;
  const b = layout.bounds;
  return <>
    <div className="ifcn-results-viewerTools"><span>{layout.nodes.length} 个节点 · {layout.routes.length} 条路径 · {layout.crossings.length} 处几何交叉</span><label>线路 <select aria-label="高亮门级线路" value={route} onChange={(event) => setRoute(event.target.value)}><option value="all">全部线路</option>{layout.routes.map((item, index) => <option key={index} value={index}>{nodes.get(item.source)?.name} → {nodes.get(item.target)?.name}{item.iterationDistance ? ` · 反馈距离 ${item.iterationDistance}` : ""}</option>)}</select></label><div className="ifcn-results-zoom"><button type="button" disabled={zoom === 1} onClick={() => setZoom((n) => Math.max(1, n - .5))} aria-label="缩小门级版图">−</button><button type="button" onClick={() => setZoom(1)} aria-label="适应门级版图大小">{Math.round(zoom * 100)}%</button><button type="button" disabled={zoom === 5} onClick={() => setZoom((n) => Math.min(5, n + .5))} aria-label="放大门级版图">+</button></div></div>
    <div className="ifcn-results-gateViewport"><svg viewBox={`${b.x - 1} ${b.y - 1} ${b.width + 1} ${b.height + 1}`} role="img" aria-label={`IFCN 门级版图，${layout.nodes.length} 个节点、${layout.routes.length} 条真实路径；物理交叉层未记录`} style={{ width: `${zoom * 100}%`, height: `${450 * zoom}px`, maxWidth: "none" }}>
      <rect x={b.x - 1} y={b.y - 1} width={b.width + 1} height={b.height + 1} fill="#f9fbfd" />
      {layout.phases.map((point) => <g key={`${point.x},${point.y}`}><title>网格 ({point.x}, {point.y}) · 相位 {point.phase}</title><rect x={point.x - .43} y={point.y - .43} width={.86} height={.86} rx={.09} fill={ifcnGateClockColor(point.phase, layout.phaseCount)} stroke="#c6c9cf" strokeWidth={.02} /><text x={point.x - .34} y={point.y - .22} fontSize={.16} fill="#5b6976">{point.phase}</text></g>)}
      {layout.routes.map((item, index) => <polyline key={index} points={item.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={route === String(index) ? "#c96730" : "#46667e"} strokeWidth={route === String(index) ? .12 : .07} strokeLinejoin="round" strokeLinecap="round" opacity={route === "all" || route === String(index) ? .95 : .18} strokeDasharray={item.iterationDistance ? ".18 .1" : undefined}><title>{nodes.get(item.source)?.name} → {nodes.get(item.target)?.name} · {item.points.length} 个路径点{item.iterationDistance ? ` · 迭代距离 ${item.iterationDistance}` : ""}</title></polyline>)}
      {layout.crossings.map((point) => <circle key={`${point.x},${point.y}`} cx={point.x} cy={point.y} r={.17} fill="none" stroke="#bf713d" strokeWidth={.05}><title>独立线路几何交叉 ({point.x}, {point.y})；IFCN 未记录物理层高。</title></circle>)}
      {layout.nodes.map((node) => <g key={node.id}><title>{node.name} · {node.kind} · 节点 {node.id} · 坐标 ({node.x}, {node.y})</title><rect x={node.x - .3} y={node.y - .25} width={.6} height={.5} rx={.1} fill="#fff" stroke={node.kind === "input" ? IFCN_CELL_COLORS.input : node.kind === "output" ? IFCN_CELL_COLORS.output : "#405a70"} strokeWidth={.055} /><text x={node.x} y={node.y + .085} textAnchor="middle" fontSize={.23} fill="#263f53">{SYMBOLS[node.kind.toLowerCase()] || node.kind.slice(0, 4)}</text><text x={node.x} y={node.y + .45} textAnchor="middle" fontSize={.2} fill="#263f53">{node.name}</text></g>)}
    </svg></div>
    <div className="ifcn-results-legend">{Array.from({ length: layout.phaseCount }, (_, phase) => <span key={phase}><i style={{ background: ifcnGateClockColor(phase, layout.phaseCount) }} />相位 {phase}</span>)}<span>圆环：几何交叉</span>{layout.routes.some((item) => item.iterationDistance > 0) && <span>虚线：跨状态迭代的反馈</span>}</div>
    <p className="ifcn-results-caption">门、逐网格路径和相位直接来自已校验的 IFCN 文件{layout.clockScheme ? `（${layout.clockScheme}）` : ""}。门级文件未记录物理交叉层，真实器件分层请查看 QCA 版图；此图不增加 DRC 或器件功能验证结论。</p>
  </>;
}
