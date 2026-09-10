import type { IfcnGateLayout } from "./ifcn-gate-layout";
import type { IfcnRunArtifact } from "./ifcn-results-types";

export const IFCN_CAMPAIGN_MAX_BYTES = 2 * 1024 * 1024;
export type CampaignPoint = [number, number];
export type CampaignNode = string | number;
export interface CampaignSnapshot {
  layoutArtifact: string | null; candidateArtifact: string | null; origin: CampaignPoint;
  metrics: { areaTiles: number | null; qcaCells: number | null };
  validation: { clockArrival: boolean | null; physicalRoutes: boolean | null; rtlEquivalence: string | null };
}
export type CampaignOperation = { op: "move"; node: CampaignNode; to: CampaignPoint } | { op: "swap"; nodes: [CampaignNode, CampaignNode] };
export interface CampaignMove { nodeId: CampaignNode; name: string; from: CampaignPoint; to: CampaignPoint }
export interface CampaignRound {
  id: number; status: string; start: CampaignSnapshot;
  proposal: { artifact: string | null; requestArtifact: string | null; responseArtifact: string | null; operations: CampaignOperation[]; rationale: string; source: string | null; model: { provider: string | null; modelId: string | null }; latencyMs: number | null; totalTokens: number | null };
  execution: { executor: string; actualMoves: CampaignMove[]; reroutedEdges: { source: CampaignNode; target: CampaignNode; beforeLength: number | null; afterLength: number | null }[]; phaseChangedTiles: number | null; phaseRepaired: boolean | null; candidate: CampaignSnapshot | null; logs: string[] };
  acceptance: { status: "accepted" | "rejected" | "failed" | "cancelled"; reasons: string[] }; elapsedS: number | null;
}
export interface IfcnOptimizationCampaign {
  schema: "ifcn.layout_optimization.v1"; policy: "llm" | "random" | "noop" | "heuristic"; status: string;
  budget: { rounds: number | null; candidateTimeoutS: number | null; modelTimeoutS: number | null };
  baseline: CampaignSnapshot; selected: CampaignSnapshot; selectedRound: number | null;
  rounds: CampaignRound[]; attribution: string;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bool = (value: unknown) => typeof value === "boolean" ? value : null;
function text(value: unknown, limit = 4096): string | null {
  if (typeof value !== "string") return null;
  if (value.length > limit) throw new Error("优化记录的文本超过显示限制。");
  return value;
}
function point(value: unknown): CampaignPoint {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => Number.isSafeInteger(item) && Math.abs(item) <= 2_000_000)) throw new Error("优化记录缺少有效的公共坐标。");
  return [value[0], value[1]];
}
function node(value: unknown): CampaignNode {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.length > 0 && value.length <= 160) return value;
  throw new Error("优化记录的节点标识无效。");
}
function list(value: unknown, limit: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limit) throw new Error("优化记录的条目数量无效或超过限制。");
  return value;
}

/** Artifact names resolve only through the current run's verified manifest metadata. */
export function parseIfcnOptimizationCampaign(source: string, artifacts: readonly IfcnRunArtifact[]): IfcnOptimizationCampaign {
  if (source.length > IFCN_CAMPAIGN_MAX_BYTES || new TextEncoder().encode(source).length > IFCN_CAMPAIGN_MAX_BYTES) throw new Error("优化记录过大，请下载查看。");
  const data = record(JSON.parse(source));
  if (data.schema !== "ifcn.layout_optimization.v1" || data.goal !== "pareto_area_qca" || !["llm", "random", "noop", "heuristic"].includes(String(data.policy))) throw new Error("优化记录格式或实验策略未识别。");
  const registered = new Map(artifacts.map((item) => [item.name, item]));
  function artifact(value: unknown, layout = false): string | null {
    if (value === undefined || value === null) return null;
    const name = text(value, 512), metadata = name === null ? undefined : registered.get(name);
    if (!metadata || (layout && metadata.preview !== "ifcn")) throw new Error("优化记录引用了未登记的结果文件或不支持的门级版图。");
    return name;
  }
  function snapshot(value: unknown): CampaignSnapshot {
    const item = record(value), metrics = record(item.metrics), validation = record(item.validation);
    return { layoutArtifact: artifact(item.layout_artifact, true), candidateArtifact: artifact(item.candidate_artifact), origin: point(item.origin),
      metrics: { areaTiles: count(metrics.area_tiles), qcaCells: count(metrics.qca_cells) },
      validation: { clockArrival: bool(validation.clock_arrival), physicalRoutes: bool(validation.physical_routes), rtlEquivalence: text(validation.rtl_equivalence, 256) } };
  }
  const rounds = list(data.rounds, 256).map((value): CampaignRound => {
    const item = record(value), proposal = record(item.proposal), model = record(proposal.model), execution = record(item.execution), changes = record(execution.automatic_changes), acceptance = record(item.acceptance);
    if (!Number.isSafeInteger(item.id) || Number(item.id) < 0 || !["accepted", "rejected", "failed", "cancelled"].includes(String(acceptance.status))) throw new Error("优化轮次或验收状态无效。");
    if (changes.topology_changed === true) throw new Error("优化记录改变了节点拓扑，不能按固定节点作前后移动对照。");
    const operations = list(proposal.operations, 1000).map((value): CampaignOperation => {
      const operation = record(value);
      if (operation.op === "move") return { op: "move", node: node(operation.node), to: point(operation.to) };
      if (operation.op === "swap" && Array.isArray(operation.nodes) && operation.nodes.length === 2) return { op: "swap", nodes: [node(operation.nodes[0]), node(operation.nodes[1])] };
      throw new Error("优化建议包含无法识别的节点操作。");
    });
    const actualMoves = list(execution.actual_moves, 5000).map((value) => { const move = record(value); return { nodeId: node(move.node_id), name: text(move.name, 160) || "", from: point(move.from), to: point(move.to) }; });
    return { id: Number(item.id), status: text(item.status, 128) || "unknown", start: snapshot(item.start),
      proposal: { artifact: artifact(proposal.artifact), requestArtifact: artifact(proposal.request_artifact), responseArtifact: artifact(proposal.response_artifact), operations, rationale: text(proposal.rationale, 16000) || "", source: text(proposal.source, 64), model: { provider: text(model.provider, 128), modelId: text(model.modelId, 256) }, latencyMs: count(proposal.latency_ms), totalTokens: Number.isSafeInteger(record(proposal.usage).totalTokens) ? count(record(proposal.usage).totalTokens) : null },
      execution: { executor: text(execution.executor, 256) || "未记录", actualMoves, reroutedEdges: list(execution.rerouted_edges, 10000).map((value) => { const edge = record(value); return { source: node(edge.source), target: node(edge.target), beforeLength: count(edge.before_length), afterLength: count(edge.after_length) }; }), phaseChangedTiles: count(changes.phase_changed_tiles), phaseRepaired: bool(changes.phase_repaired), candidate: execution.candidate == null ? null : snapshot(execution.candidate), logs: list(execution.logs, 256).map((name) => { const result = artifact(name); if (result === null) throw new Error("执行日志引用为空。"); return result; }) },
      acceptance: { status: acceptance.status as CampaignRound["acceptance"]["status"], reasons: list(acceptance.reasons, 256).map((reason) => { const result = text(reason, 4096); if (result === null) throw new Error("验收理由无效。"); return result; }) }, elapsedS: count(item.elapsed_s) };
  });
  if (new Set(rounds.map((round) => round.id)).size !== rounds.length) throw new Error("优化轮次编号重复。");
  const selectedRound = data.selected_round == null ? null : data.selected_round;
  if (selectedRound !== null && (!Number.isSafeInteger(selectedRound) || !rounds.some((round) => round.id === selectedRound && round.acceptance.status === "accepted"))) throw new Error("最终选择未对应已接纳的优化轮次。");
  const budget = record(data.budget);
  return { schema: "ifcn.layout_optimization.v1", policy: data.policy as IfcnOptimizationCampaign["policy"], status: text(data.status, 128) || "unknown", budget: { rounds: count(budget.rounds), candidateTimeoutS: count(budget.candidate_timeout_s), modelTimeoutS: count(budget.model_timeout_s) }, baseline: snapshot(data.baseline), selected: snapshot(data.selected), selectedRound: selectedRound as number | null, rounds, attribution: text(data.attribution, 8000) || "未提供收益归因记录。" };
}

export function campaignMetricChange(before: number | null, after: number | null) {
  if (before === null || after === null) return null;
  return { difference: after - before, reductionPercent: before > 0 ? (before - after) / before * 100 : null };
}

/** Compare recorded geometry in a common world frame, never names or suggested positions. */
export function compareCampaignLayouts(before: IfcnGateLayout, after: IfcnGateLayout, beforeOrigin: CampaignPoint, afterOrigin: CampaignPoint) {
  const next = new Map(after.nodes.map((item) => [item.id, item]));
  const comparable = before.nodes.length === after.nodes.length && before.nodes.every((item) => { const other = next.get(item.id); return other && other.name === item.name && other.kind === item.kind; });
  const moves: CampaignMove[] = [];
  if (comparable) for (const item of before.nodes) {
    const other = next.get(item.id)!;
    const from: CampaignPoint = [item.x + beforeOrigin[0], item.y + beforeOrigin[1]], to: CampaignPoint = [other.x + afterOrigin[0], other.y + afterOrigin[1]];
    if (from[0] !== to[0] || from[1] !== to[1]) moves.push({ nodeId: item.id, name: item.name, from, to });
  }
  let x = Infinity, y = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [layout, origin] of [[before, beforeOrigin], [after, afterOrigin]] as const) {
    x = Math.min(x, layout.bounds.x + origin[0]); y = Math.min(y, layout.bounds.y + origin[1]);
    maxX = Math.max(maxX, layout.bounds.x + origin[0] + layout.bounds.width); maxY = Math.max(maxY, layout.bounds.y + origin[1] + layout.bounds.height);
  }
  return { comparable, moves, bounds: { x, y, width: maxX - x, height: maxY - y } };
}


/** This is an execution flag, not the clock validation certificate. */
export function campaignPhaseRepairLabel(executed: boolean | null): string {
  return executed === true ? "已执行" : executed === false ? "未执行" : "未记录";
}
