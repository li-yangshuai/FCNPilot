import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ifcnOptimizationAvailability, buildIfcnOptimizationPrompt, reloadIfcnOptimizationSession } = await jiti.import("./ifcn-optimization-request.ts");

function fixture() {
  return { id: "db82469b720a4e9b9f8c0086a586d3c9", designType: "combinational", status: "completed", algorithm: "june_random", clockScheme: "irregular",
    metrics: { pnr: { algorithm: "june_random", clock_scheme: "irregular" } },
    validation: { rtl_equivalence: "exhaustive_scalar_source_vs_routed_dag", clock_arrival: "cycle_zero_at_template_phase_passed", physical_routes: "source_isolation_and_ordered_paths_passed" },
    artifacts: ["layout_candidate.json", "layout.ifcn", "normalized.v", "routed_dag.json", "source.v", "clock.json", "physical.json", "device.qca"].map((name) => ({ name })) };
}

test("only completed editable Compact/June combinational layouts enable optimization", () => {
  const run = fixture();
  assert.equal(ifcnOptimizationAvailability(run).available, true);
  run.metrics.pnr.algorithm = "compact";
  assert.equal(ifcnOptimizationAvailability(run).available, true);
  run.status = "completed_with_warnings";
  assert.equal(ifcnOptimizationAvailability(run).available, true, "unrelated model warnings do not discard certified geometry");
  run.status = "running";
  assert.equal(ifcnOptimizationAvailability(run).available, false);
  run.status = "failed";
  assert.equal(ifcnOptimizationAvailability(run).available, false);
});

test("actual PNR clock and algorithm govern eligibility, not requested or display values", () => {
  for (const mutate of [
    (run) => { run.metrics.pnr.clock_scheme = "RES"; },
    (run) => { delete run.metrics.pnr.clock_scheme; },
    (run) => { run.metrics.pnr.algorithm = "regular_clock_ga"; },
    (run) => { run.designType = "sequential"; },
    (run) => { run.designType = null; },
  ]) {
    const run = fixture(); mutate(run);
    assert.equal(ifcnOptimizationAvailability(run).available, false);
    assert.throws(() => buildIfcnOptimizationPrompt(run));
  }
});

test("historical pass labels and missing editable/native evidence cannot enable the button", () => {
  for (const key of ["clock_arrival", "physical_routes", "rtl_equivalence"]) {
    const run = fixture(); run.validation[key] = "passed";
    assert.equal(ifcnOptimizationAvailability(run).available, false);
  }
  for (const name of ["layout_candidate.json", "physical.json", "routed_dag.json", "device.qca"]) {
    const run = fixture(); run.artifacts = run.artifacts.filter((item) => item.name !== name);
    assert.equal(ifcnOptimizationAvailability(run).available, false);
  }
  const validatedDevice = fixture();
  validatedDevice.artifacts = validatedDevice.artifacts.map((item) => item.name === "device.qca" ? { name: "validated_device.qca" } : item);
  assert.equal(ifcnOptimizationAvailability(validatedDevice).available, true);
});

test("main-agent request uses the existing optimization action, bounded LLM policy and selected authenticated run", () => {
  const run = fixture(), prompt = buildIfcnOptimizationPrompt(run);
  assert.match(prompt, /"action": "optimize"/);
  assert.match(prompt, new RegExp(run.id));
  assert.match(prompt, /"optimization_policy": "llm"/);
  assert.match(prompt, /"optimization_rounds": 3/);
  assert.match(prompt, /"timeout_s": 20/);
  assert.match(prompt, /"proposal_timeout_s": 60/);
  assert.match(prompt, /禁止绕过 DRC/);
  assert.match(prompt, /不能用随机、无操作或贪心策略冒充 LLM/);
  assert.match(prompt, /未通过、超时及没有改善/);
  assert.match(prompt, /不覆盖原基线/);
  assert.doesNotMatch(prompt, /subagent|execute_shell|bash/);
  run.id = "../another-run";
  assert.throws(() => buildIfcnOptimizationPrompt(run), /编号无效/);
});

test("an existing idle session reloads current tools before an optimization prompt is sent", async () => {
  const calls = [];
  await reloadIfcnOptimizationSession("existing-session", async (id) => {
    calls.push(`state:${id}`);
    return { isStreaming: false, isPromptRunning: false, isCompacting: false, pendingMessageCount: 0 };
  }, async () => { calls.push("reload"); return { handled: true }; });
  calls.push("prompt");
  assert.deepEqual(calls, ["state:existing-session", "reload", "prompt"]);
  calls.length = 0;
  await reloadIfcnOptimizationSession(null, async () => { calls.push("state"); }, async () => { calls.push("reload"); return { handled: true }; });
  assert.deepEqual(calls, [], "new sessions obtain current resources during creation");
});

test("busy or unconfirmed sessions and reload failures stop optimization submission", async () => {
  const idle = { isStreaming: false, isPromptRunning: false, isCompacting: false, pendingMessageCount: 0 };
  for (const state of [{ ...idle, isStreaming: true }, { ...idle, isPromptRunning: true }, { ...idle, isCompacting: true }, { ...idle, pendingMessageCount: 1 }, {}]) {
    let reloaded = false;
    await assert.rejects(reloadIfcnOptimizationSession("existing", async () => state, async () => { reloaded = true; return { handled: true }; }), /空闲/);
    assert.equal(reloaded, false);
  }
  for (const result of [{ handled: false }, { handled: true, error: "reload failed" }]) {
    await assert.rejects(reloadIfcnOptimizationSession("existing", async () => idle, async () => result));
  }
});


test("English optimization preserves run selection, acceptance constraints and honest LLM attribution", () => {
  const run = fixture();
  const prompt = buildIfcnOptimizationPrompt(run, "en");
  assert.equal(ifcnOptimizationAvailability(run, "en").available, true);
  assert.doesNotMatch(prompt, /[\p{Script=Han}]/u);
  assert.match(prompt, new RegExp(run.id));
  assert.match(prompt, /"optimization_policy": "llm"/);
  assert.match(prompt, /Never bypass DRC/);
  assert.match(prompt, /cannot be attributed entirely to the LLM/);
  assert.match(prompt, /Do not overwrite the baseline/);
  run.validation.physical_routes = "passed";
  assert.equal(ifcnOptimizationAvailability(run, "en").available, false);
  assert.throws(() => buildIfcnOptimizationPrompt(run, "en"), /lacks.*evidence/);
});
