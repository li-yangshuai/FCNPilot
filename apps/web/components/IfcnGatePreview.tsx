"use client";

import { useI18n } from "@/hooks/useI18n";
import { useEffect, useMemo, useState } from "react";
import type { IfcnRunArtifact } from "@/lib/ifcn-results-types";
import { IFCN_GATE_MAX_BYTES, parseIfcnGateLayout, type IfcnGateLayout } from "@/lib/ifcn-gate-layout";
import { IFCN_CELL_COLORS, ifcnGateClockColor } from "@/lib/ifcn-colors";
const SYMBOLS: Record<string, string> = { input: "IN", output: "OUT", and: "∧", or: "∨", not: "¬", maj: "MAJ", majority: "MAJ", buffer: "BUF", buf: "BUF" };

export function IfcnGatePreview({ artifact }: { artifact: IfcnRunArtifact }) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<IfcnGateLayout | null>(null), [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1), [route, setRoute] = useState("all");
  useEffect(() => {
    const controller = new AbortController();
    setLayout(null); setError(null);
    void fetch(artifact.previewUrl!, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || t("fcn.results.unable.to.read.the.ifcn.gate.layout")); }
      if (artifact.bytes > IFCN_GATE_MAX_BYTES || Number(response.headers.get("content-length")) > IFCN_GATE_MAX_BYTES) { await response.body?.cancel(); throw new Error(t("fcn.results.the.ifcn.file.is.too.large.to.preview")); }
      const parsed = parseIfcnGateLayout(await response.text());
      if (!controller.signal.aborted) setLayout(parsed);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [artifact.previewUrl, artifact.bytes, t]);
  const nodes = useMemo(() => new Map(layout?.nodes.map((node) => [node.id, node]) || []), [layout]);
  if (error) return <p className="ifcn-results-notice" role="alert">{t("fcn.results.the.original.file.is.still.available.to.download", { p0: String(error) })}</p>;
  if (!layout) return <p className="ifcn-results-notice" role="status">{t("fcn.results.loading.gates.routing.paths.and.clock.phases")}</p>;
  const b = layout.bounds;
  return <>
    <div className="ifcn-results-viewerTools"><span>{t("fcn.results.nodes.routes.geometric.crossings", { p0: String(layout.nodes.length), p1: String(layout.routes.length), p2: String(layout.crossings.length) })}</span><label>{t("fcn.results.route")}<select aria-label={t("fcn.results.highlight.gate.route")} value={route} onChange={(event) => setRoute(event.target.value)}><option value="all">{t("fcn.results.all.routes")}</option>{layout.routes.map((item, index) => <option key={index} value={index}>{nodes.get(item.source)?.name} → {nodes.get(item.target)?.name}{item.iterationDistance ? t("fcn.results.feedback.distance", { p0: String(item.iterationDistance) }) : ""}</option>)}</select></label><div className="ifcn-results-zoom"><button type="button" disabled={zoom === 1} onClick={() => setZoom((n) => Math.max(1, n - .5))} aria-label={t("fcn.results.zoom.out.of.gate.layout")}>−</button><button type="button" onClick={() => setZoom(1)} aria-label={t("fcn.results.fit.gate.layout")}>{Math.round(zoom * 100)}%</button><button type="button" disabled={zoom === 5} onClick={() => setZoom((n) => Math.min(5, n + .5))} aria-label={t("fcn.results.zoom.into.gate.layout")}>+</button></div></div>
    <div className="ifcn-results-gateViewport"><svg viewBox={`${b.x - 1} ${b.y - 1} ${b.width + 1} ${b.height + 1}`} role="img" aria-label={t("fcn.results.ifcn.gate.layout.nodes.and.actual.routes.physical", { p0: String(layout.nodes.length), p1: String(layout.routes.length) })} style={{ width: `${zoom * 100}%`, height: `${450 * zoom}px`, maxWidth: "none" }}>
      <rect x={b.x - 1} y={b.y - 1} width={b.width + 1} height={b.height + 1} fill="#f9fbfd" />
      {layout.phases.map((point) => <g key={`${point.x},${point.y}`}><title>{t("fcn.results.tile.phase", { p0: String(point.x), p1: String(point.y), p2: String(point.phase) })}</title><rect x={point.x - .43} y={point.y - .43} width={.86} height={.86} rx={.09} fill={ifcnGateClockColor(point.phase, layout.phaseCount)} stroke="#c6c9cf" strokeWidth={.02} /><text x={point.x - .34} y={point.y - .22} fontSize={.16} fill="#5b6976">{point.phase}</text></g>)}
      {layout.routes.map((item, index) => <polyline key={index} points={item.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={route === String(index) ? "#c96730" : "#46667e"} strokeWidth={route === String(index) ? .12 : .07} strokeLinejoin="round" strokeLinecap="round" opacity={route === "all" || route === String(index) ? .95 : .18} strokeDasharray={item.iterationDistance ? ".18 .1" : undefined}><title>{t("fcn.results.route.points", { p0: String(nodes.get(item.source)?.name), p1: String(nodes.get(item.target)?.name), p2: String(item.points.length), p3: String(item.iterationDistance ? t("fcn.results.iteration.distance", { p0: String(item.iterationDistance) }) : "") })}</title></polyline>)}
      {layout.crossings.map((point) => <circle key={`${point.x},${point.y}`} cx={point.x} cy={point.y} r={.17} fill="none" stroke="#bf713d" strokeWidth={.05}><title>{t("fcn.results.independent.route.crossing.physical.layer.heights.are.not", { p0: String(point.x), p1: String(point.y) })}</title></circle>)}
      {layout.nodes.map((node) => <g key={node.id}><title>{t("fcn.results.node.coordinates", { p0: String(node.name), p1: String(node.kind), p2: String(node.id), p3: String(node.x), p4: String(node.y) })}</title><rect x={node.x - .3} y={node.y - .25} width={.6} height={.5} rx={.1} fill="#fff" stroke={node.kind === "input" ? IFCN_CELL_COLORS.input : node.kind === "output" ? IFCN_CELL_COLORS.output : "#405a70"} strokeWidth={.055} /><text x={node.x} y={node.y + .085} textAnchor="middle" fontSize={.23} fill="#263f53">{SYMBOLS[node.kind.toLowerCase()] || node.kind.slice(0, 4)}</text><text x={node.x} y={node.y + .45} textAnchor="middle" fontSize={.2} fill="#263f53">{node.name}</text></g>)}
    </svg></div>
    <div className="ifcn-results-legend">{Array.from({ length: layout.phaseCount }, (_, phase) => <span key={phase}><i style={{ background: ifcnGateClockColor(phase, layout.phaseCount) }} />{t("fcn.results.phase", { p0: String(phase) })}</span>)}<span>{t("fcn.results.ring.geometric.crossing")}</span>{layout.routes.some((item) => item.iterationDistance > 0) && <span>{t("fcn.results.dashed.line.feedback.across.state.iterations")}</span>}</div>
    <p className="ifcn-results-caption">{t("fcn.results.gates.tile.by.tile.routes.and.phases.come", { p0: String(layout.clockScheme ? `（${layout.clockScheme}）` : "") })}</p>
  </>;
}
