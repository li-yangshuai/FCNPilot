"use client";

import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
type Translate = (key: string, params?: TranslationParams) => string;

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


function stateLabel(status: string, t: Translate) {
  return ({ completed: t("fcn.results.completed"), layout_candidate: t("fcn.results.layout.candidate"), completed_with_warnings: t("fcn.results.completed.validation.limits"), running: t("fcn.results.running"), queued: t("fcn.results.queued"), pending: t("fcn.results.not.run"), failed: t("fcn.results.failed"), blocked: t("fcn.results.incomplete"), skipped: t("fcn.results.skipped"), timeout: t("fcn.results.timed.out"), cancelled: t("fcn.results.cancelled") } as Record<string, string>)[status] || t("fcn.results.status.unknown");
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numeric(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function displayNumber(value: unknown) { const n = numeric(value); return n === null ? "—" : n.toLocaleString("zh-CN"); }
function time(value: string | null | undefined, locale: string, t: Translate) {
  if (!value) return t("fcn.results.time.not.recorded");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("fcn.results.time.not.recorded") : date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function errorText(error: unknown, t: Translate) { return error instanceof Error ? error.message : t("fcn.results.unable.to.read.design.results"); }

async function readJson<T>(url: string, signal: AbortSignal, t: Translate): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || t("fcn.results.unable.to.read.design.results"));
  return data as T;
}

function QcaPreview({ artifact }: { artifact: IfcnRunArtifact }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ layout: QcaLayout | null; error: string | null }>({ layout: null, error: null });
  const [layer, setLayer] = useState("all");
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(artifact.previewUrl!, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || t("fcn.results.unable.to.read.the.qca.layout"));
        }
        return response.text();
      })
      .then((source) => setState({ layout: parseQcaLayout(source), error: null }))
      .catch((error) => { if (!controller.signal.aborted) setState({ layout: null, error: errorText(error, t) }); });
    return () => controller.abort();
  }, [artifact.previewUrl, t]);
  const cells = useMemo(() => state.layout?.cells.filter((cell) => layer === "all" || cell.layer === Number(layer)) || [], [state.layout, layer]);
  const bounds = useMemo(() => qcaBounds(cells), [cells]);
  const layerLabel = (name: string) => name === "元胞层" ? t("fcn.results.qca.cellLayer") : name.replace(/^版图层 (\d+)$/, (_, count: string) => t("fcn.results.qca.layer", { count }));
  if (state.error) return <p className={styles.notice} role="alert">{state.error}</p>;
  if (!state.layout) return <p className={styles.notice} role="status">{t("fcn.results.loading.device.layout")}</p>;
  return <>
    <div className={styles.viewerTools}>
      <span>{t("fcn.results.cells", { p0: String(cells.length.toLocaleString("zh-CN")), p1: String(state.layout.layers.length > 1 ? t("fcn.results.layers", { p0: String(state.layout.layers.length) }) : "") })}</span>
      {state.layout.layers.length > 1 && <select aria-label={t("fcn.results.select.qca.layer")} value={layer} onChange={(event) => setLayer(event.target.value)}>
        <option value="all">{t("fcn.results.all.layers.overlaid")}</option>
        {state.layout.layers.map((item) => <option key={item.id} value={item.id}>{layerLabel(item.name)}</option>)}
      </select>}
      <div className={styles.zoom}>
        <button type="button" onClick={() => setZoom((value) => Math.max(1, value - 0.5))} disabled={zoom === 1} aria-label={t("fcn.results.zoom.out.of.device.layout")}>−</button>
        <button type="button" onClick={() => setZoom(1)} aria-label={t("fcn.results.fit.device.layout")}>{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => setZoom((value) => Math.min(5, value + 0.5))} disabled={zoom === 5} aria-label={t("fcn.results.zoom.into.device.layout")}>+</button>
      </div>
    </div>
    <div className={styles.qcaViewport}>
      <svg className={styles.qcaCanvas} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} role="img" aria-label={t("fcn.results.qca.device.layout.cells.at.recorded.coordinates.and", { p0: String(cells.length) })} style={{ width: `${zoom * 100}%`, maxWidth: "none", height: `${420 * zoom}px` }}>
        <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="#f9fbfd" />
        {cells.map((cell, index) => {
          const color = ifcnCellColor(cell.clock, cell.role);
          const input = cell.role === "QCAD_CELL_INPUT";
          const output = cell.role === "QCAD_CELL_OUTPUT";
          const fixed = cell.role === "QCAD_CELL_FIXED";
          const role = input ? t("fcn.results.input") : output ? t("fcn.results.output") : fixed ? t("fcn.results.fixed.polarization") : t("fcn.results.normal.cell");
          const title = t("fcn.results.coordinates.clock", { p0: String(cell.label || t("fcn.results.cell", { p0: String(index + 1) })), p1: String(role), p2: String(cell.x), p3: String(cell.y), p4: String(cell.clock ?? t("fcn.results.not.recorded")), p5: layerLabel(state.layout!.layers.find((item) => item.id === cell.layer)?.name || "") });
          return <g key={`${cell.layer}-${index}`}>
            <title>{title}</title>
            <rect x={cell.x - cell.width / 2} y={cell.y - cell.height / 2} width={cell.width} height={cell.height} rx={cell.width * 0.09} fill={color} stroke="#000000" strokeWidth={Math.min(cell.width, cell.height) * (input || output ? 0.12 : 0.06)} />
            {cell.dots.map((dot, dotIndex) => <circle key={dotIndex} cx={dot.x} cy={dot.y} r={dot.diameter / 2} fill={fixed ? "#ffffff" : color} stroke="#000000" strokeWidth={Math.min(cell.width, cell.height) * 0.035} />)}
            {(input || output) && cell.label && <text x={cell.x} y={cell.y - cell.height * 0.75} textAnchor="middle" fontSize={cell.height * 0.5} fill="#000000">{cell.label}</text>}
          </g>;
        })}
      </svg>
    </div>
    <div className={styles.legend} aria-label={t("fcn.results.qca.clock.phase.legend")}>{IFCN_CLOCK_COLORS.map((color, phase) => <span key={phase}><i style={{ background: color }} />{t("fcn.results.phase", { p0: String(phase) })}</span>)}<span><i style={{ background: IFCN_CELL_COLORS.input }} />{t("fcn.results.input")}</span><span><i style={{ background: IFCN_CELL_COLORS.output }} />{t("fcn.results.output")}</span><span><i style={{ background: IFCN_CELL_COLORS.fixed }} />{t("fcn.results.fixed.cell")}</span></div>
    <p className={styles.caption}>{t("fcn.results.cells.quantum.dots.and.layers.come.from.the")}</p>
  </>;
}

function LayoutPreview({ run }: { run: IfcnRunDetail }) {
  const { t } = useI18n();
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
  return <section className={styles.section} aria-label={t("fcn.results.circuit.layout.preview")}>
    <div className={styles.sectionHeading}><h3>{t("fcn.results.circuit.layout")}</h3>{current && <a href={current.downloadUrl} download>{t("fcn.results.download.current.layout")}</a>}</div>
    <div className={styles.previewTabs} role="tablist" aria-label={t("fcn.results.layout.type")}>
      <button type="button" role="tab" aria-selected={availableTab === "pnr"} disabled={!hasPnr} onClick={() => setTab("pnr")}>{t("fcn.results.gate.placement.and.routing")}</button>
      <button type="button" role="tab" aria-selected={availableTab === "qca"} disabled={!qca} onClick={() => setTab("qca")}>{t("fcn.results.qca.device.layout")}</button>
    </div>
    {!hasPnr && !qca ? <p className={styles.notice}>{t("fcn.results.no.layout.preview.yet.results.appear.here.after")}</p> : availableTab === "qca" && qca ? <QcaPreview key={`${run.id}:${qca.sha256}`} artifact={qca} /> : ifcn ? <IfcnGatePreview key={`${run.id}:${ifcn.sha256}`} artifact={ifcn} /> : selectedSvg ? <>
      {previews.length > 1 && <div className={styles.viewerTools}><label>{t("fcn.results.layout.file")}<select value={selectedSvg.name} onChange={(event) => setSvgName(event.target.value)}>{previews.map((artifact) => <option key={artifact.name} value={artifact.name}>{artifact.name.split("/").pop()}</option>)}</select></label></div>}
      <div className={styles.svgViewport}>
        {failedImage === svgUrl ? <div className={styles.notice}><p>{t("fcn.results.the.layout.could.not.be.displayed.the.file")}</p><button type="button" onClick={() => setFailedImage(null)}>{t("fcn.results.reload.layout")}</button></div> : <>
          {/* The image element keeps SVG content separate from the page document. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={svgUrl!} alt={t("fcn.results.gate.placement.and.routing.for", { p0: String(run.module || run.sourceName) })} onError={() => setFailedImage(svgUrl)} />
        </>}
      </div>
      <p className={styles.caption}>{t("fcn.results.the.svg.comes.directly.from.placement.and.routing")}</p>
    </> : null}
  </section>;
}

function sequentialMetrics(run: IfcnRunDetail) {
  const sequential = object(run.metrics.sequential);
  const pnr = object(run.metrics.pnr);
  return run.designType === "sequential" || sequential.mapping_mode === "sequential" || pnr.mapping_mode === "sequential" ? sequential : null;
}

function checkLabel(value: unknown, t: Translate) { return value === true ? t("fcn.results.passed") : value === false ? t("fcn.results.failed") : t("fcn.results.not.recorded"); }

function RunMetrics({ run }: { run: IfcnRunDetail }) {
  const { t } = useI18n();
  const pnr = object(run.metrics.pnr), mapping = object(run.metrics.mapping), logic = object(run.metrics.logic), energy = object(run.metrics.energy);
  const sequential = sequentialMetrics(run);
  const transition = readIfcnStateTransition(run.metrics, run.validation);
  const transitionStatus = transition.status ? t(`fcn.results.transition.status.${["equivalent", "not_performed", "invalid", "mismatch"].includes(transition.status) ? transition.status : "unknown"}`, { status: transition.status }) : t("fcn.results.transition.status.missing");
  const transitionScope = transition.knownScope ? t("fcn.results.transition.scope.known") : transition.scope ? t("fcn.results.transition.scope.named", { scope: transition.scope }) : t("fcn.results.transition.scope.missing");
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
    {sequential && <section className="ifcn-sequential-result" aria-label={t("fcn.results.sequential.result.validation.scope")}><strong>{sequential.status === "layout_candidate" || run.status === "layout_candidate" ? t("fcn.results.feedback.layout.candidate") : t("fcn.results.sequential.design.validation.scope")}</strong><p>{t("fcn.results.routing.phase.and.state.transition.checks.are.reported", { p0: String(sequential.physical_state_signoff === "not_characterized" || !sequential.physical_state_signoff ? t("fcn.results.state.devices.have.not.been.physically.characterized.or") : t("fcn.results.state.device.validation.record", { p0: String(String(sequential.physical_state_signoff)) })) })}</p><dl>
      {numeric(geometrySearch.selected_rank) !== null && <div><dt>{t("fcn.results.selected.candidate.native.index")}</dt><dd>{displayNumber(geometrySearch.selected_rank)}</dd></div>}
      {numeric(geometrySearch.attempted_candidates) !== null && <div><dt>{t("fcn.results.layout.candidates.attempted")}</dt><dd>{displayNumber(geometrySearch.attempted_candidates)}</dd></div>}
      <div><dt>{t("fcn.results.feedback.routes")}</dt><dd>{displayNumber(sequential.feedback_routes)}</dd></div>
      <div><dt>{t("fcn.results.directed.feedback.cycle")}</dt><dd>{sequential.directed_cycle_present === true ? t("fcn.results.recorded") : sequential.directed_cycle_present === false ? t("fcn.results.not.found") : t("fcn.results.not.recorded")}</dd></div>
      <div><dt>{t("fcn.results.mapping.rule.check")}</dt><dd>{checkLabel(sequential.mapping_drc, t)}</dd></div>
      <div><dt>{t("fcn.results.phase.rule.check")}</dt><dd>{checkLabel(sequential.tile_phase_drc, t)}</dd></div>
      <div><dt>{t("fcn.results.longest.observed.same.phase.tile.run")}</dt><dd>{displayNumber(sequential.max_observed_same_phase_tile_run)}</dd></div>
    </dl><div className="ifcn-state-transition" data-status={transition.status || "unknown"}><strong>{transitionScope}</strong><p><b>{transitionStatus}</b>{transition.vectorsChecked !== null ? t("fcn.results.state.input.combinations.checked", { p0: String(displayNumber(transition.vectorsChecked)) }) : ""}</p><p>{transition.stateBits !== null ? t("fcn.results.state.bits", { p0: String(transition.stateBits) }) : t("fcn.results.state.bit.count.not.recorded")}{transition.inputBits !== null ? t("fcn.results.input.bits", { p0: String(transition.inputBits) }) : ""}{transition.gateNodes !== null ? t("fcn.results.logic.gates", { p0: String(transition.gateNodes) }) : ""}</p><p>{t("fcn.results.this.check.compares.one.next.state.step.full")}</p></div>{Array.isArray(sequential.state_boundaries) && sequential.state_boundaries.length > 0 && <details><summary>{t("fcn.results.view.state.boundaries")}</summary><ul>{sequential.state_boundaries.map((item, index) => { const boundary = object(item); return <li key={index}>{typeof boundary.data_event === "string" ? boundary.data_event : t("fcn.results.d.not.recorded")} → {typeof boundary.q_event === "string" ? boundary.q_event : t("fcn.results.q.not.recorded")}{numeric(boundary.iteration_distance) !== null ? t("fcn.results.iteration.distance", { p0: String(boundary.iteration_distance) }) : ""}</li>; })}</ul></details>}</section>}
    <div className={styles.metrics}>
      <div><span>{t("fcn.results.gate.area")}</span><strong>{displayNumber(pnr.area_tiles ?? sequential?.bbox_area)}<small> tiles</small></strong><p>{numeric(pnr.width) !== null && numeric(pnr.height) !== null ? t("fcn.results.gate.grid", { p0: String(pnr.width), p1: String(pnr.height) }) : t("fcn.results.awaiting.layout")}</p></div>
      <div><span>{t("fcn.results.qca.cells")}</span><strong>{displayNumber(cells)}<small>{t("fcn.results.count.unit")}</small></strong><p>{t("fcn.results.cell.count.after.device.mapping")}</p></div>
      {sequential ? <div><span>{t("fcn.results.state.boundaries")}</span><strong>{displayNumber(sequential.state_boundary_count)}<small>{t("fcn.results.count.unit")}</small></strong><p>{t("fcn.results.recorded.from.actual.d.q.state.connections")}</p></div> : <div><span>{t("fcn.results.logic.equivalence")}</span><strong className={styles.textMetric}>{logic.status === "equivalent" ? t("fcn.results.matched") : logic.status === "not_equivalent" || logic.status === "failed" ? t("fcn.results.failed") : t("fcn.results.not.verified")}</strong><p>{numeric(logic.vectors_checked) !== null ? t("fcn.results.input.combinations.checked", { p0: String(displayNumber(logic.vectors_checked)) }) : t("fcn.results.source.circuit.versus.routed.logic.graph")}</p></div>}
      {sequential ? <div><span>{t("fcn.results.initiation.interval")}</span><strong>{displayNumber(sequential.initiation_interval)}</strong><p>{t("fcn.results.native.phase.epoch.constraints")}</p></div> : <div><span>{t("fcn.results.model.dissipated.power")}</span><strong>{dissipatedPower === null ? "—" : (dissipatedPower * 1e9).toPrecision(3)}{dissipatedPower !== null && <small> nW</small>}</strong><p>{invalidEnergy ? t("fcn.results.numerical.checks.invalid.power.omitted") : dissipatedPower === null ? t("fcn.results.awaiting.energy.estimate") : t("fcn.results.average.bath.energy.clock.period")}</p></div>}
    </div>
    <div className={styles.validation}>
      <strong>{t("fcn.results.validation.scope")}</strong>
      {combinationalAcceptance && <div aria-label={t("fcn.results.additional.combinational.acceptance.checks")}><dl>{combinationalAcceptance.map((check) => <div key={check.id}><dt>{t(`fcn.results.acceptance.${check.id}`)}</dt><dd>{check.passed ? t("fcn.results.additional.acceptance.passed") : t("fcn.results.additional.acceptance.evidence.missing")}</dd></div>)}</dl>{combinationalAcceptance.some((check) => !check.passed) && <p>{t("fcn.results.this.run.does.not.contain.all.the.additional")}</p>}</div>}
      <p>{physicalVerified ? t("fcn.results.device.function.validation.is.recorded") : t("fcn.results.device.function.has.not.been.verified")}{simulation.length ? t("fcn.results.simulation.compares.baseline.and.accelerated.solver.consistency") : ""}{dissipatedPower !== null ? t("fcn.results.power.is.a.model.estimate.time.step.convergence") : ""}</p>
      {sequential && (dissipatedPower !== null || invalidEnergy) && <p>{invalidEnergy ? t("fcn.results.energy.numerical.checks.invalid.power.omitted") : t("fcn.results.exploratory.model.dissipated.power.nw.this.is.not", { p0: String((dissipatedPower! * 1e9).toPrecision(3)) })}</p>}
      {Object.keys(run.validation).length > 0 && <details><summary>{t("fcn.results.view.validation.records")}</summary><dl>{Object.entries(run.validation).map(([key, value]) => <div key={key}><dt>{({ clock_arrival: t("fcn.results.full.cycle.arrival.check"), physical_routes: t("fcn.results.cross.source.isolation.and.physical.path.check"), rtl_equivalence: t("fcn.results.logic.equivalence.scope"), state_transition: t("fcn.results.state.transition.check"), physical_state_signoff: t("fcn.results.state.device.sign.off"), sequential: t("fcn.results.sequential.validation.scope"), sequential_equivalence: t("fcn.results.state.transition.check"), physical_function: t("fcn.results.device.function"), simulation_comparison: t("fcn.results.simulation.comparison.scope"), energy: t("fcn.results.energy.scope"), device_terminal_counts: t("fcn.results.input.output.terminals"), simulation_iteration_limit_samples: t("fcn.results.samples.reaching.the.iteration.limit"), energy_numerics: t("fcn.results.energy.numerical.status") } as Record<string, string>)[key] || key}</dt><dd>{key === "sequential_equivalence" ? transitionStatus : key === "sequential" ? t("fcn.results.phase.rule.check.2", { p0: String(transitionScope), p1: String(transitionStatus), p2: String(object(value).rtl_equivalence === "not_independently_proven" ? t("fcn.results.original.rtl.equivalence.not.independently.proven") : t("fcn.results.refer.to.the.report.for.rtl.equivalence.scope")), p3: String(object(value).physical_state_signoff === "not_characterized" ? t("fcn.results.state.devices.not.characterized") : t("fcn.results.refer.to.the.report.for.state.device.status")), p4: String(object(value).feedback_topology === "preserved" ? t("fcn.results.feedback.topology.preserved") : t("fcn.results.feedback.topology.unconfirmed")), p5: String(checkLabel(object(value).tile_phase_drc, t)) }) : typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</dd></div>)}</dl></details>}
    </div>
  </>;
}



function ResearchRunMetrics({ run }: { run: IfcnRunDetail }) {
  const { t } = useI18n();
  const research = object(run.metrics.research);
  const area = numeric(research.area_tiles);
  const width = numeric(research.width);
  const height = numeric(research.height);
  const evaluations = numeric(research.evaluations);
  const wireLength = numeric(research.route_length);
  const firstSuccess = numeric(research.first_success_evaluation);
  const vectors = numeric(research.vectors_checked);
  const layoutVerified = run.validation.layout_model === "passed";
  const logicVerified = run.validation.rtl_equivalence === "equivalent";
  return <>
    <div className={styles.metrics} role="group" aria-label={t("fcn.results.research.metrics")}>
      {area !== null && <div>
        <span>{t("fcn.results.gate.area.tiles")}</span>
        <strong>{displayNumber(area)}</strong>
        {width !== null && height !== null && <p>{t("fcn.results.gate.grid", { p0: String(width), p1: String(height) })}</p>}
      </div>}
      {evaluations !== null ? <div>
        <span>{t("fcn.results.research.evaluations")}</span>
        <strong>{displayNumber(evaluations)}</strong>
        {firstSuccess !== null && <p>{t("fcn.results.research.firstFeasible", { p0: displayNumber(firstSuccess) })}</p>}
      </div> : wireLength !== null && <div>
        <span>{t("fcn.results.research.wireLength")}</span>
        <strong>{displayNumber(wireLength)}</strong>
      </div>}
      <div>
        <span>{t("fcn.results.research.geometryClock")}</span>
        <strong className={styles.textMetric}>{t(layoutVerified ? "fcn.results.passed" : "fcn.results.not.verified")}</strong>
      </div>
      <div>
        <span>{t("fcn.results.logic.equivalence")}</span>
        <strong className={styles.textMetric}>{t(logicVerified ? "fcn.results.matched" : "fcn.results.not.verified")}</strong>
        <p>{vectors !== null && vectors > 0 ? t("fcn.results.input.combinations.checked", { p0: displayNumber(vectors) }) : t("fcn.results.source.circuit.versus.routed.logic.graph")}</p>
      </div>
    </div>
    <div className={styles.validation}>
      <strong>{t("fcn.results.validation.scope")}</strong>
      <p>{t("fcn.results.research.scope")}</p>
    </div>
  </>;
}

function SimulationSummary({ run }: { run: IfcnRunDetail }) {
  const { t, locale } = useI18n();
  const comparisons = Array.isArray(run.metrics.simulation) ? run.metrics.simulation.map(object) : [];
  const energy = object(run.metrics.energy);
  if (!comparisons.length && !Object.keys(energy).length) return null;
  const reportedPower = numeric(energy.average_dissipated_power_W);
  const invalidEnergy = (reportedPower !== null && reportedPower < 0)
    || String(run.validation.energy_numerics || energy.numerical_status || energy.status || "").startsWith("invalid");
  const iterationLimitSamples = numeric(run.validation.simulation_iteration_limit_samples)
    ?? comparisons.reduce((count, item) => count + (numeric(item.max_iteration_samples) ?? 0), 0);
  const number = (value: unknown) => {
    const n = numeric(value);
    if (n === null) return "—";
    // Preserve small nonzero solver errors instead of rounding them to zero.
    return n !== 0 && Math.abs(n) < 1e-5 ? n.toExponential(3) : n.toLocaleString(locale, { maximumFractionDigits: 7 });
  };
  const seconds = (value: unknown) => numeric(value)?.toExponential(1) ?? "—";
  return <section className={styles.section} aria-label={t("fcn.results.simulation.title")}>
    <div className={styles.sectionHeading}><h3>{t("fcn.results.simulation.title")}</h3></div>
    <div className="ifcn-results-simulationBody">
      <div className="ifcn-results-simulationGrid">
        {comparisons.length > 0 && <div>
          <h4>{t("fcn.results.simulation.consistency")}</h4>
          <div className="ifcn-results-simulationTableWrap"><table>
            <thead><tr><th>{t("fcn.results.simulation.model")}</th><th>{t("fcn.results.simulation.samples")}</th><th>{t("fcn.results.simulation.maxError")}</th><th>{t("fcn.results.simulation.iterationLimit")}</th></tr></thead>
            <tbody>{comparisons.map((item, index) => <tr key={`${item.model}:${index}`}>
              <th scope="row">{item.model === "bistable" ? t("fcn.results.simulation.bistable") : item.model === "coherence" ? t("fcn.results.simulation.coherence") : String(item.model || t("fcn.results.not.recorded"))}</th>
              <td>{number(item.output_samples)}</td><td>{number(item.max_absolute_error)}</td><td>{number(item.max_iteration_samples)}</td>
            </tr>)}</tbody>
          </table></div>
          <p>{t("fcn.results.simulation.scope")}</p>
          {iterationLimitSamples > 0 && <p className="ifcn-results-simulationWarning">{t("fcn.results.simulation.iterationWarning", { count: number(iterationLimitSamples) })}</p>}
        </div>}
        {Object.keys(energy).length > 0 && <div>
          <h4>{t("fcn.results.simulation.energyModel")}</h4>
          <dl>
            <div><dt>{t("fcn.results.model.dissipated.power")}</dt><dd>{invalidEnergy || reportedPower === null ? "—" : `${(reportedPower * 1e9).toPrecision(3)} nW`}</dd></div>
            <div><dt>{t("fcn.results.simulation.bathEnergy")}</dt><dd>{number(energy.average_bath_eV)} eV</dd></div>
            <div><dt>{t("fcn.results.simulation.cycles")}</dt><dd>{number(energy.cycle_count)}</dd></div>
            <div><dt>{t("fcn.results.simulation.clockPeriod")}</dt><dd>{seconds(energy.clock_period_s)} s</dd></div>
            <div><dt>{t("fcn.results.simulation.timeStep")}</dt><dd>{seconds(energy.time_step_s)} s</dd></div>
            <div><dt>{t("fcn.results.simulation.convergence")}</dt><dd>{energy.time_step_convergence === "not_tested" ? t("fcn.results.simulation.notTested") : String(energy.time_step_convergence || t("fcn.results.not.recorded"))}</dd></div>
          </dl>
          <p>{invalidEnergy ? t("fcn.results.energy.numerical.checks.invalid.power.omitted") : t("fcn.results.simulation.energyScope")}</p>
        </div>}
      </div>
    </div>
  </section>;
}

function ResultFiles({ run }: { run: IfcnRunDetail }) {
  const { t } = useI18n();
  const FILE_LABELS: Record<string, string> = { "campaign.json": t("fcn.results.complete.layout.optimization.experiment"), "source.v": t("fcn.results.input.circuit"), "normalized.v": t("fcn.results.normalized.verilog"), "layout.ifcn": t("fcn.results.gate.layout"), "device.qca": t("fcn.results.qca.device.layout"), "dag.json": t("fcn.results.logic.dag"), "simulation.json": t("fcn.results.circuit.simulation.results"), "energy.json": t("fcn.results.energy.estimate"), "result.json": t("fcn.results.complete.design.results"), "logic.json": t("fcn.results.logic.equivalence.check"), "clock.json": t("fcn.results.full.cycle.arrival.certificate"), "physical.json": t("fcn.results.cross.source.isolation.and.physical.path.certificate"), "interface.json": t("fcn.results.device.terminal.check"), "seqir.json": t("fcn.results.sequential.intermediate.representation"), "state_manifest.json": t("fcn.results.state.boundary.manifest"), "sequential_validation.json": t("fcn.results.state.transition.check"), "yosys.json": t("fcn.results.synthesized.logic.netlist"), "pnr.json": t("fcn.results.placement.and.routing.check"), "sequential_pnr.json": t("fcn.results.native.sequential.layout.check"), "geometry_attempts.json": t("fcn.results.layout.candidate.attempt.records") };
  const primary = run.artifacts.filter((artifact) => FILE_LABELS[artifact.name]);
  const rest = run.artifacts.filter((artifact) => !FILE_LABELS[artifact.name]);
  const fileLabel = (artifact: IfcnRunArtifact) => sequentialMetrics(run) && artifact.name === "normalized.v" ? t("fcn.results.combinational.verilog.after.state.cuts") : sequentialMetrics(run) && artifact.name === "dag.json" ? t("fcn.results.state.cut.dag") : FILE_LABELS[artifact.name] || artifact.name.split("/").pop();
  const rows = (artifacts: IfcnRunArtifact[]) => <ul className={styles.fileList}>{artifacts.map((artifact) => <li key={artifact.name}><div><strong>{fileLabel(artifact)}</strong><span title={artifact.name}>{artifact.name} · {size(artifact.bytes)}</span></div><a href={artifact.downloadUrl} download aria-label={t("fcn.results.download.2", { p0: String(artifact.name) })}>{t("fcn.results.download")}<span aria-hidden>↓</span></a></li>)}</ul>;
  return <section className={styles.section} aria-label={t("fcn.results.circuit.result.files")}><div className={styles.sectionHeading}><h3>{t("fcn.results.result.files")}</h3><span>{t("fcn.results.files", { p0: String(run.artifacts.length) })}</span></div>
    {run.artifacts.length ? <>{rows(primary)}{rest.length > 0 && <details className={styles.otherFiles}><summary>{t("fcn.results.view.other.files", { p0: String(rest.length) })}</summary>{rows(rest)}</details>}</> : <p className={styles.notice}>{t("fcn.results.no.result.files.yet")}</p>}
  </section>;
}

export function IfcnResults({ active = true, onClose, capabilities, onShowAlgorithms, onOptimizeRun, optimizationReady = false }: { active?: boolean; onClose?: () => void; capabilities?: unknown; onShowAlgorithms?: () => void; onOptimizeRun?: (run: IfcnRunDetail) => Promise<void>; optimizationReady?: boolean }) {
  const { t, locale } = useI18n();
  const STAGES = [{ id: "parse", label: t("fcn.results.logic.parsing") }, { id: "pnr", label: t("fcn.results.place.route") }, { id: "map", label: t("fcn.results.device.mapping") }, { id: "simulate", label: t("fcn.results.simulation") }, { id: "energy", label: t("fcn.results.energy.estimate") }];
  const OPTIMIZATION_SOURCES: Record<string, string> = { llm: t("fcn.results.llm.optimization"), noop: t("fcn.results.rerouting.control"), random: t("fcn.results.random.control"), heuristic: t("fcn.results.greedy.control") };
  const ALGORITHMS: Record<string, string> = { normal_2ddwave: "Normal · 2DDWave", compact: "Compact", june_random: "June", sequential_cyclic: t("fcn.results.sequential.feedback.layout"), regular_clock_ga: t("fcn.results.regular.clock.heuristic"), clock_repair: t("fcn.results.research.clockRepair"), multi_agent: t("fcn.results.research.multiAgent"), auto: t("fcn.results.automatic.selection") };
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
        const data = await readJson<{ runs: IfcnRunSummary[] }>("/api/ifcn/runs", controller.signal, t);
        if (controller.signal.aborted) return;
        setRuns(data.runs);
        const next = data.runs.some((run) => run.id === selection.current) ? selection.current : data.runs[0]?.id || null;
        selection.current = next;
        setSelected(next);
        if (next) {
          const result = await readJson<IfcnRunDetail>(`/api/ifcn/runs/${encodeURIComponent(next)}`, controller.signal, t);
          if (!controller.signal.aborted && selection.current === next) { setDetail(result); setError(null); }
        } else { setDetail(null); setError(null); }
      } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure, t)); }
      finally { busy = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, 8000);
    const onVisible = () => { if (document.visibilityState === "visible") void update(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [active, refresh, t]);

  const current = detail?.id === selected ? detail : null;
  const researchRun = current?.algorithm === "clock_repair" || current?.algorithm === "multi_agent";
  const optimization = current && !researchRun ? ifcnOptimizationAvailability(current, locale) : null;
  const catalog = useMemo(() => readIfcnAlgorithmCatalog(capabilities, locale), [capabilities, locale]);
  const pnr = object(current?.metrics.pnr);
  const recordedAlgorithm = typeof pnr.algorithm === "string" ? pnr.algorithm : current?.algorithm;
  const classification = catalog.entries.find((entry) => entry.runAlgorithm === recordedAlgorithm);
  const recordedClock = clockSchemeLabel(pnr.clock_scheme, locale);
  const choose = (id: string) => { setOptimizationError(null); selection.current = id; setSelected(id); setError(null); setLoading(true); setRefresh((value) => value + 1); };
  return <section className={styles.panel} aria-label={t("fcn.results.fcn.circuit.layouts.and.results")}>
    <header className={styles.header}><div><span className={styles.eyebrow}>FCNPilot / DESIGN RESULTS</span><h2>{t("fcn.results.layouts.results")}</h2><p>{t("fcn.results.follow.circuit.progress.inspect.actual.layouts.and.download")}</p></div><div className={styles.actions}><button type="button" onClick={() => { setLoading(true); setRefresh((value) => value + 1); }} aria-label={t("fcn.results.refresh.circuit.results")} disabled={loading}>{t("fcn.results.refresh")}</button>{onClose && <button type="button" onClick={onClose} aria-label={t("fcn.results.close.circuit.results")}>×</button>}</div></header>
    {error && <p className={styles.error} role="alert">{error}{current ? t("fcn.results.showing.the.last.retrieved.results") : ""}</p>}
    {runs.length > 0 && <div className={styles.runSelector}><label htmlFor="ifcn-result-run">{t("fcn.results.circuit.runs")}</label><select id="ifcn-result-run" value={selected || ""} onChange={(event) => choose(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{run.module || run.sourceName || run.id.slice(0, 8)}{run.optimizationPolicy ? ` · ${OPTIMIZATION_SOURCES[run.optimizationPolicy]}` : ""} · {ALGORITHMS[run.algorithm || ""] || run.algorithm || t("fcn.results.algorithm.pending")}{run.algorithm === "regular_clock_ga" && run.clockScheme ? ` · ${run.clockScheme}` : ""} · {stateLabel(run.status, t)} · {time(run.createdAt, locale, t)} · {run.id.slice(0, 6)}</option>)}</select></div>}
    {loading && !current ? <p className={styles.empty} role="status">{t("fcn.results.loading.circuit.design.results")}</p> : !current && !error ? <div className={styles.empty}><svg width="68" height="68" viewBox="0 0 68 68" fill="none" aria-hidden><rect x="13" y="13" width="42" height="42" rx="10" stroke="currentColor" strokeWidth="1.5" /><path d="M21 34h9V23h17M30 34v12h17M47 23v23M21 46h9" stroke="currentColor" strokeWidth="2" /><circle cx="21" cy="34" r="3" fill="currentColor" /><circle cx="47" cy="23" r="3" fill="currentColor" /><circle cx="47" cy="46" r="3" fill="currentColor" /></svg><h3>{t("fcn.results.start.with.a.circuit")}</h3><p>{t("fcn.results.provide.verilog.in.the.design.chat.or.run")}</p></div> : null}
    {current && <>
      <div className={styles.runHeading}><div><h3>{current.module || current.sourceName}{current.optimizationPolicy ? ` · ${OPTIMIZATION_SOURCES[current.optimizationPolicy]}` : ""}</h3><p title={current.sourceName}>{current.sourceName} · {sequentialMetrics(current) ? t("fcn.results.sequential.circuit") : current.designType === "combinational" ? t("fcn.results.combinational.circuit") : t("fcn.results.mode.not.recorded")} · {ALGORITHMS[current.algorithm || ""] || current.algorithm || t("fcn.results.algorithm.not.selected")}{current.algorithm === "regular_clock_ga" && current.clockScheme ? ` · ${current.clockScheme}` : ""}</p></div><span className={styles.status} data-status={current.status}>{current.status === "completed" ? t("fcn.results.pipeline.complete") : stateLabel(current.status, t)}</span></div>
      {!researchRun && <>
        <div className="ifcn-result-classification"><span>{t("fcn.results.recorded.clock", { p0: String(recordedClock || t("fcn.results.not.recorded")), p1: String(numeric(pnr.phase_count) !== null ? t("fcn.results.phases", { p0: String(pnr.phase_count) }) : "") })}</span>{classification && classification.method !== "unclassified" && <span>{t("fcn.results.catalog.method", { p0: String(classification.methodLabel) })}</span>}{onShowAlgorithms && <button type="button" onClick={onShowAlgorithms}>{t("fcn.results.compare.scale.clocks")}</button>}</div>
        <ol className={styles.stages} aria-label={t("fcn.results.circuit.pipeline.progress")}>{STAGES.map((stage, index) => { const status = current.stages.find((item) => item.id === stage.id)?.status || "pending"; return <li key={stage.id} data-status={status} title={stateLabel(status, t)}><span>{status === "completed" ? "✓" : String(index + 1).padStart(2, "0")}</span><strong>{stage.id === "parse" && sequentialMetrics(current) ? t("fcn.results.state.logic.parsing") : stage.label}</strong><small>{stateLabel(status, t)}</small></li>; })}</ol>
      </>}
      {current.error && <p className={styles.error} role="alert">{current.error}</p>}
      {!researchRun && <RunMetrics run={current} />}
      {onOptimizeRun && optimization && <section className="ifcn-optimize-action" aria-label={t("fcn.results.main.agent.layout.optimization")}><div><strong>{t("fcn.results.continue.optimizing.this.layout")}</strong><p>{optimization.available && !optimizationReady ? t("fcn.results.the.main.agent.is.running.or.not.ready") : optimization.reason}</p></div><button type="button" disabled={!optimization.available || !optimizationReady || optimizing || loading} onClick={async () => {
        setOptimizing(true); setOptimizationError(null);
        try { await onOptimizeRun(current); } catch (failure) { setOptimizationError(errorText(failure, t)); } finally { setOptimizing(false); }
      }}>{optimizing ? t("fcn.results.sending.to.main.agent") : t("fcn.results.optimize.layout.with.main.agent")}</button>{optimizationError && <p role="alert">{optimizationError}</p>}</section>}
      <IfcnOptimizationCampaign key={`campaign:${current.id}`} run={current} />
      {researchRun ? <div className="ifcn-results-research">
        <div><ResearchRunMetrics run={current} /></div>
        <LayoutPreview key={current.id} run={current} />
      </div> : <LayoutPreview key={current.id} run={current} />}
      <SimulationSummary run={current} />
      <ResultFiles run={current} />
      <p className={styles.footer}>{t("fcn.results.run.updated", { p0: String(current.id.slice(0, 12)), p1: String(time(current.updatedAt, locale, t)), p2: String(loading ? t("fcn.results.refreshing") : "") })}</p>
    </>}
  </section>;
}
