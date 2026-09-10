"use client";

import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
type Translate = (key: string, params?: TranslationParams) => string;

import { ifcnGateClockColor } from "@/lib/ifcn-colors";

import { useEffect, useMemo, useState } from "react";
import type { IfcnRunArtifact, IfcnRunDetail } from "@/lib/ifcn-results-types";
import { IFCN_GATE_MAX_BYTES, parseIfcnGateLayout, type IfcnGateLayout } from "@/lib/ifcn-gate-layout";
import { IFCN_CAMPAIGN_MAX_BYTES, campaignMetricChange, compareCampaignLayouts, parseIfcnOptimizationCampaign, type CampaignPoint, type CampaignSnapshot, type CampaignRound, type IfcnOptimizationCampaign as Campaign } from "@/lib/ifcn-optimization-campaign";

function useCampaignFormat() {
  const { t, locale } = useI18n();
  return useMemo(() => {
const number = (value: number | null) => value === null ? t("fcn.results.not.recorded") : value.toLocaleString(locale, { maximumFractionDigits: 2 });
const coordinate = (value: CampaignPoint) => `(${value[0]}, ${value[1]})`;
const check = (value: boolean | null) => value === true ? t("fcn.results.pass") : value === false ? t("fcn.results.failed") : t("fcn.results.not.recorded");
const status = (value: string) => ({ accepted: t("fcn.results.accepted"), rejected: t("fcn.results.rejected"), failed: t("fcn.results.execution.incomplete"), cancelled: t("fcn.results.cancelled"), completed: t("fcn.results.experiment.finished"), running: t("fcn.results.experiment.running"), pending: t("fcn.results.queued") } as Record<string, string>)[value] || value;
const sourceLabel = (value: string | null) => value === "llm" ? t("fcn.results.llm.proposal") : value === "random" ? t("fcn.results.random.proposal.control") : value === "heuristic" ? t("fcn.results.deterministic.greedy.proposal.control") : value === "noop" ? t("fcn.results.no.operation.control") : t("fcn.results.proposal.source.not.recorded");
const errorText = (error: unknown) => error instanceof Error ? error.message : t("fcn.results.unable.to.read.results");

    const campaignPhaseRepairLabel = (value: boolean | null) => value === true ? t("fcn.results.performed") : value === false ? t("fcn.results.not.performed") : t("fcn.results.not.recorded");
    return { number, coordinate, check, status, sourceLabel, errorText, campaignPhaseRepairLabel };
  }, [t, locale]);
}

async function artifactText(artifact: IfcnRunArtifact, limit: number, signal: AbortSignal, t: Translate) {
  if (artifact.bytes > limit) throw new Error(t("fcn.results.the.file.exceeds.the.inline.display.limit.download"));
  const response = await fetch(artifact.downloadUrl, { cache: "no-store", signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || t("fcn.results.unable.to.read.the.experiment.artifact")); }
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error(t("fcn.results.the.file.exceeds.the.inline.display.limit.download")); }
  const text = await response.text();
  if (new TextEncoder().encode(text).length > limit) throw new Error(t("fcn.results.the.file.exceeds.the.inline.display.limit.download"));
  return text;
}
function RawArtifact({ artifact }: { artifact: IfcnRunArtifact }) {
  const { errorText } = useCampaignFormat();
  const { t } = useI18n();
  const [state, setState] = useState({ text: "", error: "", loading: true });
  useEffect(() => {
    const controller = new AbortController();
    void artifactText(artifact, 256 * 1024, controller.signal, t).then((text) => { if (!controller.signal.aborted) setState({ text, error: "", loading: false }); }).catch((error) => { if (!controller.signal.aborted) setState({ text: "", error: errorText(error), loading: false }); });
    return () => controller.abort();
  }, [artifact, t, errorText]);
  return state.loading ? <p>{t("fcn.results.loading.original.record")}</p> : state.error ? <p role="alert">{state.error}</p> : <pre className="ifcn-campaign-raw">{state.text}</pre>;
}
function EvidenceFile({ name, label, artifacts }: { name: string | null; label: string; artifacts: Map<string, IfcnRunArtifact> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), artifact = name ? artifacts.get(name) : null;
  if (!artifact) return null;
  return <details className="ifcn-campaign-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{label} <span>{artifact.name}</span></summary><a href={artifact.downloadUrl} download>{t("fcn.results.download.original")}</a>{open && <RawArtifact key={artifact.sha256} artifact={artifact} />}</details>;
}
function useLayout(artifact: IfcnRunArtifact | undefined) {
  const { t } = useI18n();
  const { errorText } = useCampaignFormat();
  const [state, setState] = useState<{ layout: IfcnGateLayout | null; error: string }>({ layout: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ layout: null, error: "" });
    if (artifact) void artifactText(artifact, IFCN_GATE_MAX_BYTES, controller.signal, t).then((text) => { const layout = parseIfcnGateLayout(text); if (!controller.signal.aborted) setState({ layout, error: "" }); }).catch((error) => { if (!controller.signal.aborted) setState({ layout: null, error: errorText(error) }); });
    return () => controller.abort();
  }, [artifact, t, errorText]);
  return state;
}
function ComparisonCanvas({ layout, origin, bounds, moved, focused, title }: { layout: IfcnGateLayout; origin: CampaignPoint; bounds: IfcnGateLayout["bounds"]; moved: Set<string>; focused: string | null; title: string }) {
  const { coordinate } = useCampaignFormat();
  const { t } = useI18n();
  return <svg viewBox={`${bounds.x - 1} ${bounds.y - 1} ${bounds.width + 1} ${bounds.height + 1}`} role="img" aria-label={title}>
    <g transform={`translate(${origin[0]} ${origin[1]})`}>
      {layout.phases.map((item) => <rect key={`${item.x},${item.y}`} x={item.x - .43} y={item.y - .43} width={.86} height={.86} rx={.08} fill={ifcnGateClockColor(item.phase, layout.phaseCount)} stroke="#c6c9cf" strokeWidth={.02}><title>{t("fcn.results.world.coordinates.phase", { p0: String(coordinate([item.x + origin[0], item.y + origin[1]])), p1: String(item.phase) })}</title></rect>)}
      {layout.routes.map((item, index) => <polyline key={index} points={item.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#52738b" strokeWidth={.07} opacity={focused === null || String(item.source) === focused || String(item.target) === focused ? .9 : .2} strokeDasharray={item.iterationDistance ? ".18 .1" : undefined}><title>{t("fcn.results.route.points.2", { p0: String(item.source), p1: String(item.target), p2: String(item.points.length) })}</title></polyline>)}
      {layout.nodes.map((item) => { const highlight = moved.has(String(item.id)), selected = focused === String(item.id); return <g key={item.id} opacity={focused === null || selected ? 1 : .45}><title>{t("fcn.results.node.world.coordinates", { p0: String(item.id), p1: String(item.name), p2: String(item.kind), p3: String(coordinate([item.x + origin[0], item.y + origin[1]])), p4: String(highlight ? t("fcn.results.position.changed") : "") })}</title>{highlight && <circle cx={item.x} cy={item.y} r={.43} fill="#e38b30" fillOpacity={.2} stroke="#bf6a19" strokeWidth={selected ? .1 : .055} />}<rect x={item.x - .28} y={item.y - .24} width={.56} height={.48} rx={.09} fill="#fff" stroke={highlight ? "#bf6a19" : "#405a70"} strokeWidth={.055} /><text x={item.x} y={item.y + .06} fontSize={.17} textAnchor="middle" fill="#263f53">{item.kind.slice(0, 4)}</text><text x={item.x} y={item.y + .48} fontSize={.2} textAnchor="middle" fill="#263f53">{item.name}</text></g>; })}
    </g>
  </svg>;
}
function SnapshotChecks({ snapshot }: { snapshot: CampaignSnapshot }) {
  const { check } = useCampaignFormat();
  const { t } = useI18n();
  return <p className="ifcn-campaign-checks">{t("fcn.results.full.cycle.arrival.source.isolation.and.paths.logic", { p0: String(check(snapshot.validation.clockArrival)), p1: String(check(snapshot.validation.physicalRoutes)), p2: String((snapshot.validation.rtlEquivalence === "equivalent" || snapshot.validation.rtlEquivalence === "exhaustive_scalar_source_vs_routed_dag") ? t("fcn.results.source.circuit.and.routed.dag.exhaustively.matched") : snapshot.validation.rtlEquivalence || t("fcn.results.not.recorded")) })}</p>;
}
function MetricTable({ before, after }: { before: CampaignSnapshot; after: CampaignSnapshot | null }) {
  const { number } = useCampaignFormat();
  const { t } = useI18n();
  return <table className="ifcn-campaign-table"><thead><tr><th>{t("fcn.results.metric")}</th><th>{t("fcn.results.starting.point")}</th><th>{t("fcn.results.comparison")}</th><th>{t("fcn.results.change")}</th></tr></thead><tbody>{([[t("fcn.results.gate.area.tiles"), "areaTiles"], [t("fcn.results.qca.cells"), "qcaCells"]] as const).map(([label, key]) => { const previous = before.metrics[key], next = after?.metrics[key] ?? null, change = campaignMetricChange(previous, next); return <tr key={key}><th>{label}</th><td>{number(previous)}</td><td>{number(next)}</td><td>{change ? `${change.difference > 0 ? "+" : ""}${number(change.difference)}${change.reductionPercent !== null ? `（${change.reductionPercent >= 0 ? t("fcn.results.reduction") : t("fcn.results.increase")} ${number(Math.abs(change.reductionPercent))}%）` : ""}` : t("fcn.results.not.comparable")}</td></tr>; })}</tbody></table>;
}
function LayoutComparison({ before, after, beforeLabel, afterLabel, artifacts, round }: { before: CampaignSnapshot; beforeLabel?: string; after: CampaignSnapshot | null; afterLabel: string; artifacts: Map<string, IfcnRunArtifact>; round?: CampaignRound }) {
  const { coordinate } = useCampaignFormat();
  const { t } = useI18n();
  const leftArtifact = before.layoutArtifact ? artifacts.get(before.layoutArtifact) : undefined, rightArtifact = after?.layoutArtifact ? artifacts.get(after.layoutArtifact) : undefined;
  const left = useLayout(leftArtifact), right = useLayout(rightArtifact);
  const [focused, setFocused] = useState<string | null>(null);
  const difference = useMemo(() => left.layout && right.layout && after ? compareCampaignLayouts(left.layout, right.layout, before.origin, after.origin) : null, [left.layout, right.layout, before.origin, after]);
  const moved = new Set(difference?.moves.map((move) => String(move.nodeId)) || []);
  const actualMoves = round?.execution.actualMoves || difference?.moves || [];
  const mismatch = difference?.comparable && round && (difference.moves.length !== actualMoves.length || actualMoves.some((move) => !difference.moves.some((observed) => String(observed.nodeId) === String(move.nodeId) && observed.from.every((value, index) => value === move.from[index]) && observed.to.every((value, index) => value === move.to[index]))));
  return <>
    <MetricTable before={before} after={after} />
    <div className="ifcn-campaign-comparison">{([{ label: beforeLabel || t("fcn.results.round.starting.point"), snapshot: before, artifact: leftArtifact, state: left }, { label: afterLabel, snapshot: after, artifact: rightArtifact, state: right }] as const).map((side, index) => <section key={index}><div className="ifcn-campaign-sideTitle"><strong>{side.label}</strong>{side.artifact && <a href={side.artifact.downloadUrl} download>{t("fcn.results.download.layout")}</a>}</div>{side.state.error ? <p role="alert">{side.state.error}</p> : !side.snapshot || !side.artifact ? <p>{t("fcn.results.no.candidate.layout.is.available.to.display")}</p> : !side.state.layout ? <p>{t("fcn.results.loading.actual.layout")}</p> : <ComparisonCanvas layout={side.state.layout} origin={side.snapshot.origin} bounds={difference?.bounds || { ...side.state.layout.bounds, x: side.state.layout.bounds.x + side.snapshot.origin[0], y: side.state.layout.bounds.y + side.snapshot.origin[1] }} moved={moved} focused={focused} title={t("fcn.results.orange.rings.mark.nodes.whose.positions.actually.changed", { p0: String(side.label) })} />}{side.snapshot && <SnapshotChecks snapshot={side.snapshot} />}</section>)}</div>
    <p className="ifcn-campaign-note">{t("fcn.results.both.views.use.the.same.world.coordinates.colors")}</p>
    {difference && !difference.comparable && <p role="alert">{t("fcn.results.node.identifiers.or.topology.differ.node.movements.are")}</p>}
    {mismatch && <p role="alert">{t("fcn.results.execution.move.records.disagree.with.layout.coordinates.highlights")}</p>}
    <div className="ifcn-campaign-tableWrap"><table className="ifcn-campaign-table"><caption>{round ? t("fcn.results.actual.node.moves.recorded.by.the.executor") : t("fcn.results.actual.node.changes.from.baseline.to.final.layout")}</caption><thead><tr><th>{t("fcn.results.node")}</th><th>{t("fcn.results.original.position")}</th><th>{t("fcn.results.actual.position")}</th></tr></thead><tbody>{actualMoves.map((move, index) => <tr key={`${move.nodeId}:${index}`} data-focused={focused === String(move.nodeId)}><td><button type="button" onClick={() => setFocused((old) => old === String(move.nodeId) ? null : String(move.nodeId))} aria-pressed={focused === String(move.nodeId)}>#{move.nodeId} {move.name}</button></td><td>{coordinate(move.from)}</td><td>{coordinate(move.to)}</td></tr>)}{!actualMoves.length && <tr><td colSpan={3}>{t("fcn.results.no.actual.node.moves.recorded")}</td></tr>}</tbody></table></div>
  </>;
}
function CampaignView({ campaign, artifacts }: { campaign: Campaign; artifacts: Map<string, IfcnRunArtifact> }) {
  const { number, coordinate, status, sourceLabel, campaignPhaseRepairLabel } = useCampaignFormat();
  const { t } = useI18n();
  const [selected, setSelected] = useState("overview");
  const round = campaign.rounds.find((item) => String(item.id) === selected);
  return <>
    <p className="ifcn-campaign-intro"><strong>{t("fcn.results.experiment", { p0: String(sourceLabel(campaign.policy)) })}</strong>{t("fcn.results.rounds", { p0: String(status(campaign.status)), p1: String(campaign.rounds.length), p2: String(campaign.budget.rounds !== null ? t("fcn.results.budget.rounds", { p0: String(campaign.budget.rounds) }) : ""), p3: String(campaign.selectedRound === null ? t("fcn.results.baseline.retained") : t("fcn.results.round.selected", { p0: String(campaign.selectedRound) })) })}</p>
    <p className="ifcn-campaign-note">{t("fcn.results.a.deterministic.router.and.phase.solver.execute.candidates", { p0: String(campaign.policy === "llm" ? t("fcn.results.the.llm.proposes.node.adjustments") : campaign.policy === "random" ? t("fcn.results.this.experiment.uses.random.proposals.with.no.llm") : campaign.policy === "heuristic" ? t("fcn.results.this.experiment.uses.deterministic.greedy.proposals.with.no") : t("fcn.results.this.experiment.proposes.no.node.adjustments.to.observe")) })}</p>
    <details className="ifcn-campaign-evidence"><summary>{t("fcn.results.view.original.attribution.and.experiment.constraints")}</summary><p className="ifcn-campaign-attribution">{campaign.attribution}</p></details>
    <label className="ifcn-campaign-select">{t("fcn.results.experiment.version")}<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="overview">{t("fcn.results.overview.baseline.final.selection")}</option>{campaign.rounds.map((item) => <option key={item.id} value={item.id}>{t("fcn.results.round", { p0: String(item.id), p1: String(sourceLabel(item.proposal.source)), p2: String(status(item.acceptance.status)) })}</option>)}</select></label>
    <div className="ifcn-campaign-tableWrap"><table className="ifcn-campaign-table"><caption>{t("fcn.results.all.rounds.including.rejected.candidates")}</caption><thead><tr><th>{t("fcn.results.round.source")}</th><th>{t("fcn.results.proposed.operations")}</th><th>{t("fcn.results.actual.moves")}</th><th>{t("fcn.results.acceptance")}</th><th>{t("fcn.results.candidate.area.cells")}</th></tr></thead><tbody>{campaign.rounds.map((item) => <tr key={item.id}><td><button type="button" onClick={() => setSelected(String(item.id))}>{t("fcn.results.round.2", { p0: String(item.id), p1: String(sourceLabel(item.proposal.source)) })}</button></td><td>{item.proposal.operations.length}</td><td>{item.execution.actualMoves.length}</td><td>{status(item.acceptance.status)}</td><td>{number(item.execution.candidate?.metrics.areaTiles ?? null)} / {number(item.execution.candidate?.metrics.qcaCells ?? null)}</td></tr>)}</tbody></table></div>
    {round ? <div key={round.id} className="ifcn-campaign-round">
      <h4>{t("fcn.results.round.2", { p0: String(round.id), p1: String(status(round.acceptance.status)) })}</h4>
      <p><strong>{t("fcn.results.rule.acceptance")}</strong>{round.acceptance.reasons.length ? round.acceptance.reasons.join("；") : t("fcn.results.no.reason.provided")}{round.acceptance.status !== "accepted" ? t("fcn.results.this.candidate.was.not.accepted") : ""}</p>
      <details open className="ifcn-campaign-proposal"><summary>{sourceLabel(round.proposal.source)}{round.proposal.model.modelId ? ` · ${round.proposal.model.provider || t("fcn.results.provider.not.recorded")} / ${round.proposal.model.modelId}` : ""}</summary><p className="ifcn-campaign-note">{t("fcn.results.total.tokens.model.latency", { p0: String(number(round.proposal.totalTokens)), p1: String(round.proposal.latencyMs === null ? t("fcn.results.not.recorded") : `${number(round.proposal.latencyMs)} ms`) })}</p><p>{round.proposal.rationale || t("fcn.results.proposal.rationale.not.recorded")}</p><ul>{round.proposal.operations.map((operation, index) => <li key={index}>{operation.op === "move" ? t("fcn.results.request.moving.node.to", { p0: String(operation.node), p1: String(coordinate(operation.to)) }) : t("fcn.results.request.swapping.nodes.and", { p0: String(operation.nodes[0]), p1: String(operation.nodes[1]) })}</li>)}</ul>{!round.proposal.operations.length && <p>{t("fcn.results.no.node.operations.proposed.this.round")}</p>}</details>
      <p><strong>{t("fcn.results.actual.execution")}</strong>{t("fcn.results.edges.rerouted.tiles.changed.phase.additional.phase.repair", { p0: String(round.execution.executor), p1: String(round.execution.reroutedEdges.length), p2: String(number(round.execution.phaseChangedTiles)), p3: String(campaignPhaseRepairLabel(round.execution.phaseRepaired)), p4: String(round.elapsedS !== null ? t("fcn.results.elapsed.s", { p0: String(number(round.elapsedS)) }) : "") })}</p>
      <LayoutComparison before={round.start} after={round.execution.candidate} afterLabel={t("fcn.results.actual.candidate", { p0: String(status(round.acceptance.status)) })} artifacts={artifacts} round={round} />
      {round.execution.reroutedEdges.length > 0 && <details><summary>{t("fcn.results.view.rerouted.edges.and.path.lengths")}</summary><div className="ifcn-campaign-tableWrap"><table className="ifcn-campaign-table"><thead><tr><th>{t("fcn.results.edge")}</th><th>{t("fcn.results.original.length")}</th><th>{t("fcn.results.actual.length")}</th></tr></thead><tbody>{round.execution.reroutedEdges.map((edge, index) => <tr key={index}><td>{edge.source} → {edge.target}</td><td>{number(edge.beforeLength)}</td><td>{number(edge.afterLength)}</td></tr>)}</tbody></table></div></details>}
      <EvidenceFile name={round.proposal.artifact} label={t("fcn.results.original.proposal.file")} artifacts={artifacts} />
      <EvidenceFile name={round.proposal.responseArtifact} label={t("fcn.results.original.model.response")} artifacts={artifacts} />
      <EvidenceFile name={round.proposal.requestArtifact} label={t("fcn.results.original.model.request")} artifacts={artifacts} />
      {round.execution.logs.map((name) => <EvidenceFile key={name} name={name} label={t("fcn.results.execution.log")} artifacts={artifacts} />)}
      <EvidenceFile name={round.execution.candidate?.candidateArtifact || null} label={t("fcn.results.native.candidate.record")} artifacts={artifacts} />
    </div> : <LayoutComparison key="overview" beforeLabel={t("fcn.results.baseline")} before={campaign.baseline} after={campaign.selected} afterLabel={campaign.selectedRound === null ? t("fcn.results.final.selection.baseline.retained") : t("fcn.results.final.selection.round", { p0: String(campaign.selectedRound) })} artifacts={artifacts} />}
  </>;
}
export function IfcnOptimizationCampaign({ run }: { run: IfcnRunDetail }) {
  const { errorText } = useCampaignFormat();
  const { t } = useI18n();
  const artifact = run.artifacts.find((item) => item.name === "campaign.json");
  const artifacts = useMemo(() => new Map(run.artifacts.map((item) => [item.name, item])), [run.artifacts]);
  const [state, setState] = useState<{ campaign: Campaign | null; error: string }>({ campaign: null, error: "" });
  useEffect(() => {
    if (!artifact) return;
    const controller = new AbortController();
    void artifactText(artifact, IFCN_CAMPAIGN_MAX_BYTES, controller.signal, t).then((source) => { const campaign = parseIfcnOptimizationCampaign(source, run.artifacts); if (!controller.signal.aborted) setState({ campaign, error: "" }); }).catch((error) => { if (!controller.signal.aborted) setState({ campaign: null, error: errorText(error) }); });
    return () => controller.abort();
  }, [artifact, run.artifacts, t, errorText]);
  if (!artifact) return null;
  return <section className="ifcn-results-section ifcn-campaign" aria-label={t("fcn.results.layout.optimization.experiment")}><div className="ifcn-results-sectionHeading"><h3>{t("fcn.results.layout.optimization.experiment")}</h3><a href={artifact.downloadUrl} download>{t("fcn.results.download.complete.experiment")}</a></div><div className="ifcn-campaign-body">{state.error ? <p role="alert">{t("fcn.results.the.original.experiment.file.is.still.available.to", { p0: String(state.error) })}</p> : state.campaign ? <CampaignView campaign={state.campaign} artifacts={artifacts} /> : <p role="status">{t("fcn.results.loading.optimization.proposals.execution.and.acceptance.records")}</p>}</div></section>;
}
