import assert from "node:assert/strict";
import test from "node:test";
import { readIfcnAlgorithmCatalog, filterIfcnAlgorithms, clockSchemeLabel, ifcnScaleLabel } from "./ifcn-algorithms.ts";

const integrated = { id: "normal", available: true, clock_scheme: "2DDWave" };
const entries = [
  { id: "normal", name: "Normal", entry_kind: "backend", method: "heuristics", method_label: "启发式", clock_family: "rule_based", clock_label: "2DDWave 规则时钟", integration: "integrated", available: true, run_algorithm: "normal" },
  { id: "ppo", name: "GCN/PPO", entry_kind: "research_method", method: "learning", method_label: "学习方法", clock_family: "sampled", clock_label: "随机采样时钟场", integration: "not_integrated", available: true, run_algorithm: "ppo", source_repository: "iFCN", source_paths: ["include/research/ppo.py"] },
  { id: "phase-solver", name: "Phase solver", entry_kind: "component", method: "exact", method_label: "约束求解", clock_family: "configurable", clock_label: "可配置时钟", integration: "not_integrated", available: false },
];

test("keeps methods, clock families and component roles independent", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [integrated], algorithm_catalog: entries });
  assert.equal(catalog.complete, true);
  assert.deepEqual(catalog.entries.map((entry) => [entry.method, entry.clockFamily, entry.entryKind]), [
    ["heuristics", "rule_based", "backend"], ["learning", "sampled", "research_method"], ["exact", "configurable", "component"],
  ]);
  assert.equal(catalog.entries[1].clockLabel, "随机采样时钟场");
  assert.equal(catalog.entries[1].sourceRepository, "iFCN");
  assert.equal(catalog.entries[1].runAlgorithm, null);
  assert.equal(catalog.entries[1].available, false, "a research entry cannot become runnable from its availability flag");
});

test("requires the run algorithm to be present and available in the executable capability list", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [integrated, { id: "disabled", available: false }], algorithm_catalog: [
    entries[0], { ...entries[0], id: "missing", run_algorithm: "missing" }, { ...entries[0], id: "disabled", run_algorithm: "disabled" },
  ] });
  assert.deepEqual(catalog.entries.map((entry) => entry.available), [true, false, false]);
});

test("legacy capabilities expose only explicit backends and clock schemes without inventing method classifications", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [integrated, { id: "compact", available: true, clock_scheme: "irregular" }, { id: "auto", available: true }] });
  assert.equal(catalog.complete, false);
  assert.equal(catalog.entries.length, 2);
  assert.deepEqual(catalog.entries.map((entry) => entry.clockFamily), ["rule_based", "irregular"]);
  assert.ok(catalog.entries.every((entry) => entry.method === "unclassified"));
  assert.equal(clockSchemeLabel("irregular"), "非规则 / 自由时钟");
  assert.equal(clockSchemeLabel(undefined), null);
});

test("preserves new taxonomy keys and filters methods and clocks orthogonally", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [integrated], algorithm_catalog: [...entries,
    { ...entries[1], id: "future", method: "new_method", method_label: "新方法", clock_family: "new_clock", clock_label: "新时钟" },
  ] });
  assert.equal(catalog.entries.length, 4);
  assert.deepEqual(filterIfcnAlgorithms(catalog.entries, { method: "learning", clock: "sampled" }).map((entry) => entry.id), ["ppo"]);
  assert.deepEqual(filterIfcnAlgorithms(catalog.entries, { method: "heuristics", clock: "sampled" }), []);
  assert.deepEqual(filterIfcnAlgorithms(catalog.entries, { clock: "new_clock" }).map((entry) => entry.id), ["future"]);
  assert.deepEqual(filterIfcnAlgorithms(catalog.entries, { integration: "integrated" }).map((entry) => entry.id), ["normal"]);
});

test("uses family labels for filtering without merging distinct clock schemes", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [integrated], algorithm_catalog: [entries[0],
    { ...entries[0], id: "ga", clock_label: "USE / RES 规则时钟" },
    { ...entries[2], id: "memorypolicy", clock_label: "stochastic-bands / fixed / uniform" },
    { ...entries[2], id: "astar", clock_label: "由调用方指定时钟" },
    { ...entries[2], id: "future", clock_family: "new_family", clock_family_label: "未来时钟族" },
  ] });
  assert.equal(catalog.entries[0].clockFamilyLabel, "规则时钟模板");
  assert.equal(catalog.entries[1].clockFamilyLabel, "规则时钟模板");
  assert.notEqual(catalog.entries[0].clockLabel, catalog.entries[1].clockLabel);
  assert.equal(catalog.entries[2].clockFamilyLabel, "可配置 / 多种时钟");
  assert.equal(catalog.entries[3].clockFamilyLabel, "可配置 / 多种时钟");
  assert.equal(catalog.entries[4].clockFamilyLabel, "未来时钟族");
});

test("ignores auto, malformed and duplicated catalog entries without inventing rows", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [integrated], algorithm_catalog: [entries[0], null, {}, entries[0], { ...entries[0], id: "auto" }] });
  assert.equal(catalog.entries.length, 1);
  assert.deepEqual(readIfcnAlgorithmCatalog(null).entries, []);
  assert.deepEqual(readIfcnAlgorithmCatalog({ algorithm_catalog: [] }).entries, []);
});


test("scale coverage never expands a small observed sample into medium or large support", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [integrated], scale_policy: { metric: "dag_gate_nodes", small_max: 50, medium_max: 500 }, algorithm_catalog: [{
    ...entries[0], design_modes: ["combinational"], scale_coverage: { small: { status: "validated_samples", benchmark_count: 1, max_gate_nodes: 4 } },
  }] });
  const entry = catalog.entries[0];
  assert.deepEqual(entry.designModes, ["combinational"]);
  assert.equal(entry.scaleCoverage.small.status, "validated_samples");
  assert.equal(entry.scaleCoverage.small.maxGateNodes, 4);
  assert.equal(entry.scaleCoverage.medium.status, "unassessed");
  assert.equal(entry.scaleCoverage.large.status, "unassessed");
  assert.equal(ifcnScaleLabel("small", catalog.scalePolicy), "≤ 50 门");
  assert.equal(ifcnScaleLabel("medium", catalog.scalePolicy), "51–500 门");
  assert.equal(ifcnScaleLabel("large", catalog.scalePolicy), "> 500 门");
});

test("unverified sequential candidates remain distinct from combinational sample evidence", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithms: [{ id: "sequential_cyclic", available: true }], algorithm_catalog: [{
    ...entries[0], id: "sequential_cyclic", run_algorithm: "sequential_cyclic", design_modes: ["sequential", "unexpected"],
    clock_family: "irregular", scale_coverage: { small: { status: "candidate" } },
  }, { ...entries[0], id: "unknown-mode" }] });
  assert.deepEqual(catalog.entries[0].designModes, ["sequential"]);
  assert.equal(catalog.entries[0].available, true);
  assert.equal(catalog.entries[0].scaleCoverage.small.status, "candidate");
  assert.deepEqual(catalog.entries[1].designModes, []);
  assert.equal(catalog.entries[1].scaleCoverage.small.status, "unassessed");
});

test("incomplete or malformed validation evidence is unassessed and invalid thresholds use workspace defaults", () => {
  const catalog = readIfcnAlgorithmCatalog({ scale_policy: { small_max: 500, medium_max: 50 }, algorithm_catalog: [{
    ...entries[0], scale_coverage: { small: { status: "validated_samples" }, medium: { status: "validated_samples", benchmark_count: 0, max_gate_nodes: 60 }, large: { status: "supported" } },
  }] });
  assert.deepEqual(Object.values(catalog.entries[0].scaleCoverage).map((coverage) => coverage.status), ["unassessed", "unassessed", "unassessed"]);
  assert.equal(catalog.scalePolicy.smallMax, 50);
  assert.equal(catalog.scalePolicy.mediumMax, 500);
});


test("a ready combinational engine does not enable an explicitly unsupported sequential mode", () => {
  const catalog = readIfcnAlgorithmCatalog({ ready: true, combinational: { supported: true }, sequential: { supported: false }, algorithms: [integrated, { id: "sequential_cyclic", available: true }], algorithm_catalog: [
    { ...entries[0], design_modes: ["combinational"] },
    { ...entries[0], id: "sequential_cyclic", run_algorithm: "sequential_cyclic", design_modes: ["sequential"] },
  ] });
  assert.equal(catalog.entries[0].available, true);
  assert.equal(catalog.entries[1].available, false);
});

test("English catalog labels preserve availability and evidence without changing backend metadata", () => {
  const capabilities = {
    algorithms: [{ id: "regular_clock_ga", available: true }],
    algorithm_catalog: [{ ...entries[0], id: "regular_clock_ga", run_algorithm: "regular_clock_ga",
      name: "规则时钟启发式布局布线", design_modes: ["combinational"],
      method_label: "小规模规则时钟启发式", clock_label: "规则 2DDWave / USE / RES",
      description: "可作为该分档的候选实现；可调用不代表整个分档均能成功。",
      scale_coverage: { small: { status: "validated_samples", benchmark_count: 1, max_gate_nodes: 4,
        note: "冻结生产记录中 1 个去重源电路通过布线逻辑等价与器件端口计数检查；不代表完整波形签核。" },
      medium: { status: "candidate" }, large: { status: "out_of_scope" } },
    }],
  };
  const original = structuredClone(capabilities);
  const zh = readIfcnAlgorithmCatalog(capabilities);
  const en = readIfcnAlgorithmCatalog(capabilities, "en");
  assert.equal(en.entries[0].name, "Regular-clock heuristic P&R");
  assert.equal(en.entries[0].clockLabel, "Regular 2DDWave / USE / RES");
  assert.match(en.entries[0].scaleCoverage.small.note, /does not establish complete waveform signoff/);
  const evidence = (catalog) => catalog.entries.map(({ id, integrated, available, runAlgorithm, designModes, scaleCoverage }) => ({
    id, integrated, available, runAlgorithm, designModes,
    scales: Object.entries(scaleCoverage).map(([scale, { status, benchmarkCount, maxGateNodes }]) => ({ scale, status, benchmarkCount, maxGateNodes })),
  }));
  assert.deepEqual(evidence(en), evidence(zh));
  assert.deepEqual(capabilities, original);
  assert.equal(ifcnScaleLabel("small", en.scalePolicy, "en"), "≤ 50 gates");
  assert.equal(clockSchemeLabel("irregular", "en"), "Irregular / free-phase clocks");
  assert.equal(clockSchemeLabel(undefined, "en"), null);
});

test("untranslated future metadata retains the original report without inventing support", () => {
  const catalog = readIfcnAlgorithmCatalog({ algorithm_catalog: [{
    id: "future", name: "未来实现", method_label: "未来方法", description: "未来描述", scope: "未来范围",
    clock_family: "future_clock", clock_family_label: "未来时钟", clock_label: "未来时钟约束",
    scale_coverage: { small: { status: "validated_samples", note: "未来验证说明" }, medium: { status: "candidate", note: "未来候选说明" } },
  }] }, "en");
  const entry = catalog.entries[0];
  assert.equal(entry.name, "future");
  assert.equal(entry.available, false);
  assert.equal(entry.scaleCoverage.small.status, "unassessed");
  assert.equal(entry.scaleCoverage.medium.status, "candidate");
  assert.match(entry.scaleCoverage.small.note, /unassessed/);
  assert.match(entry.scaleCoverage.medium.note, /do not establish support/);
  assert.equal(JSON.parse(entry.originalReport).description, "未来描述");
  for (const label of [entry.name, entry.methodLabel, entry.clockFamilyLabel, entry.clockLabel, entry.description, entry.scope, ...Object.values(entry.scaleCoverage).map((coverage) => coverage.note)]) {
    assert.doesNotMatch(label, /\p{Script=Han}/u);
  }
});
