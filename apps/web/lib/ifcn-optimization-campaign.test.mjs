import assert from "node:assert/strict";
import test from "node:test";
import { parseIfcnOptimizationCampaign, IFCN_CAMPAIGN_MAX_BYTES, campaignPhaseRepairLabel, compareCampaignLayouts, campaignMetricChange } from "./ifcn-optimization-campaign.ts";

const files = ["baseline.ifcn", "round1.ifcn", "proposal.json", "request.json", "response.txt", "executor.log", "candidate.json"].map((name) => ({ name, preview: name.endsWith(".ifcn") ? "ifcn" : null }));
function snapshot(layout = "baseline.ifcn") {
  return { layout_artifact: layout, origin: [-4, -2], metrics: { area_tiles: 20, qca_cells: 80 }, validation: { clock_arrival: true, physical_routes: true, rtl_equivalence: "equivalent" } };
}
function fixture() {
  const start = snapshot(), candidate = { ...snapshot("round1.ifcn"), candidate_artifact: "candidate.json", metrics: { area_tiles: 16, qca_cells: 72 } };
  return { schema: "ifcn.layout_optimization.v1", policy: "llm", status: "completed", goal: "pareto_area_qca", budget: { rounds: 3, candidate_timeout_s: 12, model_timeout_s: 30 }, baseline: start, selected: candidate, selected_round: 1,
    rounds: [{ id: 1, status: "completed", start, proposal: { artifact: "proposal.json", request_artifact: "request.json", response_artifact: "response.txt", operations: [{ op: "move", node: 2, to: [-1, 0] }, { op: "swap", nodes: [0, 1] }], rationale: "Move a gate closer to its fan-in.", source: "llm", model: { provider: "provider", modelId: "recorded-model" }, latency_ms: 200 }, execution: { executor: "deterministic_router_rephase", actual_moves: [{ node_id: 2, name: "g", from: [0, 0], to: [-1, 0] }], rerouted_edges: [{ source: 0, target: 2, before_length: 4, after_length: 3 }], automatic_changes: { phase_changed_tiles: 3, phase_repaired: true, topology_changed: false }, candidate, logs: ["executor.log"] }, acceptance: { status: "accepted", reasons: ["all checks passed"] }, elapsed_s: 1.2 }], attribution: "Joint proposal and deterministic execution; not isolated LLM benefit." };
}
const read = (value) => parseIfcnOptimizationCampaign(JSON.stringify(value), files);

test("campaign retains proposal provenance, actual execution, reasons, and registered evidence", () => {
  const result = read(fixture()), round = result.rounds[0];
  assert.equal(result.selectedRound, 1);
  assert.equal(round.proposal.source, "llm");
  assert.deepEqual(round.proposal.model, { provider: "provider", modelId: "recorded-model" });
  assert.equal(round.proposal.operations.length, 2);
  assert.equal(round.execution.actualMoves.length, 1, "suggestions are not promoted to applied operations");
  assert.equal(round.execution.actualMoves[0].nodeId, 2);
  assert.equal(round.execution.executor, "deterministic_router_rephase");
  assert.deepEqual(round.execution.logs, ["executor.log"]);
  assert.deepEqual(round.acceptance.reasons, ["all checks passed"]);
  assert.equal(result.baseline.metrics.areaTiles, 20);
  assert.equal(result.selected.metrics.qcaCells, 72);
  assert.match(result.attribution, /not isolated LLM/);
});

test("failed and rejected candidates preserve missing evidence instead of inventing metrics or success", () => {
  const input = fixture(), round = input.rounds[0];
  input.selected_round = null; input.selected = input.baseline;
  round.acceptance = { status: "rejected", reasons: ["clock arrival mismatch", "source isolation"] };
  round.execution.candidate = { layout_artifact: null, origin: [0, 0], metrics: { area_tiles: 9 }, validation: { clock_arrival: false } };
  const result = read(input);
  assert.deepEqual(result.rounds[0].acceptance.reasons, ["clock arrival mismatch", "source isolation"]);
  assert.equal(result.rounds[0].execution.candidate.layoutArtifact, null);
  assert.deepEqual(result.rounds[0].execution.candidate.metrics, { areaTiles: 9, qcaCells: null });
  assert.deepEqual(result.rounds[0].execution.candidate.validation, { clockArrival: false, physicalRoutes: null, rtlEquivalence: null });
  round.execution.candidate = null; round.acceptance.status = "failed";
  assert.equal(read(input).rounds[0].execution.candidate, null);
});

test("random and no-op controls retain their policy without acquiring LLM provenance", () => {
  for (const policy of ["random", "noop", "heuristic"]) {
    const input = fixture(); input.policy = policy; input.rounds[0].proposal.source = policy;
    delete input.rounds[0].proposal.model;
    const result = read(input);
    assert.equal(result.policy, policy);
    assert.equal(result.rounds[0].proposal.source, policy);
    assert.equal(result.rounds[0].proposal.model.modelId, null);
  }
});

test("campaign cannot reference unregistered files, arbitrary URLs, or SVG as native layout data", () => {
  for (const reference of ["../../secret", "https://example.com/not-an-artifact", "/private/a.ifcn", "missing.ifcn"]) {
    const input = fixture(); input.baseline.layout_artifact = reference;
    assert.throws(() => read(input), /未登记/);
  }
  const input = fixture(); input.rounds[0].execution.logs = ["unknown.log"];
  assert.throws(() => read(input), /未登记/);
  input.rounds[0].execution.logs = ["executor.log"]; input.baseline.layout_artifact = "diagram.svg";
  assert.throws(() => parseIfcnOptimizationCampaign(JSON.stringify(input), [...files, { name: "diagram.svg", preview: "svg" }]), /不支持/);
});

test("ambiguous schema, invalid coordinates, topology changes and selecting a rejected round are refused", () => {
  const mutations = [
    (input) => { input.schema = "another-format"; },
    (input) => { input.baseline.origin = null; },
    (input) => { input.rounds[0].proposal.operations[0].to = [Infinity, 1]; },
    (input) => { input.rounds[0].execution.automatic_changes.topology_changed = true; },
    (input) => { input.rounds[0].acceptance.status = "rejected"; },
    (input) => { input.rounds.push(input.rounds[0]); },
    (input) => { input.rounds[0].proposal.operations[0].op = "unrecognized"; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => read(input)); }
  assert.throws(() => parseIfcnOptimizationCampaign(" ".repeat(IFCN_CAMPAIGN_MAX_BYTES + 1), files), /过大/);
});

function layout(nodes) {
  return { nodes, routes: [], phases: [], phaseCount: 4, clockScheme: "irregular", crossings: [], physicalLayersRecorded: false, bounds: { x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)), width: 5, height: 5 } };
}
const gate = (id, x, y, name = `g${id}`) => ({ id, x, y, name, kind: "and" });

test("node highlighter removes independent export normalization using both snapshot origins", () => {
  const before = layout([gate(0, 2, 3), gate(1, 4, 2)]);
  const after = layout([gate(0, 0, 0), gate(1, 2, -1)]);
  const diff = compareCampaignLayouts(before, after, [-2, -3], [0, 0]);
  assert.equal(diff.comparable, true);
  assert.deepEqual(diff.moves, [], "local XY differences are only exporter translation");
});

test("highlights report actual world-space moves only for stable IDs and share common bounds", () => {
  const before = layout([gate(0, 2, 3), gate(1, 4, 2)]), after = layout([gate(0, 0, 0), gate(1, 1, -1)]);
  const diff = compareCampaignLayouts(before, after, [-2, -3], [0, 0]);
  assert.deepEqual(diff.moves, [{ nodeId: 1, name: "g1", from: [2, -1], to: [1, -1] }]);
  assert.deepEqual(diff.bounds, { x: 0, y: -1, width: 5, height: 5 });
  assert.equal(compareCampaignLayouts(before, layout([gate(0, 0, 0), gate(2, 1, -1, "g1")]), [-2, -3], [0, 0]).comparable, false, "matching names cannot replace stable IDs");
  assert.deepEqual(compareCampaignLayouts(before, layout([gate(0, 0, 0)]), [-2, -3], [0, 0]).moves, [], "topology changes are not guessed as moves");
});

test("metric changes do not treat missing QCA evidence or zero baselines as measured gains", () => {
  assert.equal(campaignMetricChange(80, null), null);
  assert.equal(campaignMetricChange(null, 72), null);
  assert.deepEqual(campaignMetricChange(80, 72), { difference: -8, reductionPercent: 10 });
  assert.deepEqual(campaignMetricChange(0, 4), { difference: 4, reductionPercent: null });
});

test("model cost display uses recorded totalTokens and latency without deriving missing totals", () => {
  const input = fixture(), proposal = input.rounds[0].proposal;
  proposal.usage = { input: 1836, output: 89, totalTokens: 1925 };
  proposal.latency_ms = 8039;
  assert.equal(read(input).rounds[0].proposal.totalTokens, 1925);
  assert.equal(read(input).rounds[0].proposal.latencyMs, 8039);
  delete proposal.usage.totalTokens;
  assert.equal(read(input).rounds[0].proposal.totalTokens, null);
  proposal.usage.totalTokens = 2.5;
  assert.equal(read(input).rounds[0].proposal.totalTokens, null);
  delete proposal.latency_ms;
  assert.equal(read(input).rounds[0].proposal.latencyMs, null);
});


test("an accepted candidate may pass clock validation without executing extra phase repair", () => {
  const input = fixture();
  input.rounds[0].execution.automatic_changes.phase_repaired = false;
  const round = read(input).rounds[0];
  assert.equal(round.acceptance.status, "accepted");
  assert.equal(round.execution.candidate.validation.clockArrival, true);
  assert.equal(campaignPhaseRepairLabel(round.execution.phaseRepaired), "未执行");
  assert.equal(campaignPhaseRepairLabel(true), "已执行");
  assert.equal(campaignPhaseRepairLabel(null), "未记录");
});
