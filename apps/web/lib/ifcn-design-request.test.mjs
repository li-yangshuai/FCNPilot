import assert from "node:assert/strict";
import test from "node:test";
import { buildIfcnDesignPrompt, loadIfcnSourceDraft, ifcnDesignAlgorithms, ifcnSnapshotName, validateIfcnSource, IFCN_SOURCE_MAX_BYTES } from "./ifcn-design-request.ts";
const capabilities = { combinational: { supported: true }, sequential: { supported: true }, algorithms: [
  { id: "normal_2ddwave", available: true, clock_scheme: "2DDWave" },
  { id: "regular_clock_ga", available: true, clock_schemes: ["2DDWave", "USE", "RES"] },
  { id: "compact", available: true, clock_scheme: "irregular" }, { id: "june_random", available: true, clock_scheme: "irregular" },
  { id: "sequential_cyclic", available: true, clock_scheme: "irregular", design_type: "sequential" },
  { id: "research_ppo", available: true, clock_scheme: "irregular" },
] };
const request = { mode: "combinational", clock: "USE", algorithm: "auto", until: "map", note: "优先较小面积" };

test("clock choices keep regular templates and post-route implementations in their own families", () => {
  assert.deepEqual(ifcnDesignAlgorithms(capabilities, "combinational", "USE").map((item) => item.id), ["regular_clock_ga"]);
  assert.deepEqual(ifcnDesignAlgorithms(capabilities, "combinational", "2DDWave").map((item) => item.id), ["normal_2ddwave", "regular_clock_ga"]);
  assert.deepEqual(ifcnDesignAlgorithms(capabilities, "combinational", "irregular").map((item) => item.id), ["compact", "june_random"]);
  assert.deepEqual(ifcnDesignAlgorithms(capabilities, "sequential", "irregular").map((item) => item.id), ["sequential_cyclic"]);
  assert.deepEqual(ifcnDesignAlgorithms(capabilities, "sequential", "USE"), []);
});

test("unavailable backends and unsupported modes cannot become selectable", () => {
  assert.deepEqual(ifcnDesignAlgorithms({ ...capabilities, sequential: { supported: false } }, "sequential", "irregular"), []);
  assert.deepEqual(ifcnDesignAlgorithms({ algorithms: [{ id: "regular_clock_ga", available: false, clock_schemes: ["USE"] }] }, "combinational", "USE"), []);
  assert.deepEqual(ifcnDesignAlgorithms(null, "auto", "irregular"), []);
});

test("automatic mode is a request for classification, never an illegal tool design_type", () => {
  const prompt = buildIfcnDesignPrompt("/engine/designs/circuit.v", { ...request, mode: "auto" });
  assert.doesNotMatch(prompt, /"design_type"\s*:\s*"auto"/);
  assert.match(prompt, /"clock_scheme": "USE"/);
  assert.match(prompt, /禁止更换时钟、禁用或绕过 DRC/);
  assert.match(prompt, /"algorithm": "auto"/);
  assert.match(prompt, /"until": "map"/);
});

test("explicit sequential requests retain type and scope and reject regular-clock substitution", () => {
  const prompt = buildIfcnDesignPrompt("/engine/designs/circuit.v", { ...request, mode: "sequential", clock: "irregular", until: "energy" });
  assert.match(prompt, /"design_type": "sequential"/);
  assert.match(prompt, /用户明确请求数值仿真探索/);
  assert.match(prompt, /一拍检查/);
  assert.throws(() => buildIfcnDesignPrompt("/engine/designs/circuit.v", { ...request, mode: "sequential" }), /仅支持/);
});

test("snapshot names cannot escape the design directory and source limits count UTF-8 bytes", () => {
  assert.equal(ifcnSnapshotName("../../a.v", "unique-123"), "designs/______a-unique-123.v");
  assert.throws(() => ifcnSnapshotName("a.v", "../x"), /编号/);
  assert.throws(() => validateIfcnSource(" "), /输入/);
  assert.throws(() => validateIfcnSource("电".repeat(Math.ceil(IFCN_SOURCE_MAX_BYTES / 3))), /256 KB/);
  assert.doesNotThrow(() => validateIfcnSource("module x; endmodule"));
});


test("loading another source resets mode and implementation while preserving the user's clock constraint", () => {
  const previous = { ...request, mode: "sequential", clock: "irregular", algorithm: "sequential_cyclic", source: "old", path: "/old.v", name: "old.v" };
  const next = loadIfcnSourceDraft(previous, { source: "module logic; endmodule", path: "/new.v", name: "new.v" });
  assert.equal(next.mode, "auto");
  assert.equal(next.algorithm, "auto");
  assert.equal(next.clock, "irregular");
  assert.equal(next.path, "/new.v");
  assert.equal(next.note, previous.note);
  assert.equal(loadIfcnSourceDraft({ ...previous, clock: "USE" }, { source: "new", path: "/new.v", name: "new.v" }).clock, "USE");
});
