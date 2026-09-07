import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const IFCN_TOOLS = ["read", "write", "edit", "ifcn_capabilities", "ifcn_run", "ifcn_status", "ifcn_artifact"];

function makeInner() {
  const allTools = [...IFCN_TOOLS, "bash", "Agent", "get_subagent_result", "steer_subagent", "mcp_external"];
  let activeTools = [...allTools];
  let commandActions;
  return {
    sessionId: "tool-policy-test",
    sessionManager: { getCwd: () => process.cwd() },
    settingsManager: { setProjectTrusted() {} },
    agent: { state: { systemPrompt: "Main agent policy" } },
    extensionRunner: { setUIContext() {} },
    getAllTools: () => allTools.map((name) => ({ name })),
    getActiveToolNames: () => [...activeTools],
    setActiveToolsByName(names) { activeTools = [...names]; },
    async bindExtensions(bindings) {
      commandActions = bindings.commandContextActions;
      activeTools = [...allTools];
    },
    async reload(options) {
      await options?.beforeSessionStart?.();
      activeTools = [...allTools];
    },
    getCommandActions: () => commandActions,
    dispose() {},
  };
}

test("a bound main Agent keeps its exact tools through binding, both reload paths, and toolbar commands", async (t) => {
  const inner = makeInner();
  const wrapper = new AgentSessionWrapper(inner, IFCN_TOOLS);
  t.after(() => wrapper.destroy());
  assert.deepEqual(inner.getActiveToolNames(), IFCN_TOOLS, "construction must exclude unrelated installed extensions");
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  assert.deepEqual(inner.getActiveToolNames(), IFCN_TOOLS, "session_start cannot add subagent tools");
  await wrapper.send({ type: "reload" });
  assert.deepEqual(inner.getActiveToolNames(), IFCN_TOOLS);
  await inner.getCommandActions().reload();
  assert.deepEqual(inner.getActiveToolNames(), IFCN_TOOLS);

  await assert.rejects(wrapper.send({ type: "set_tools", toolNames: [...IFCN_TOOLS, "Agent"] }), { status: 409 });
  await assert.rejects(wrapper.send({ type: "set_tools", toolNames: ["read", "bash", "write", "edit"] }), { status: 409 });
  await assert.rejects(wrapper.send({ type: "set_tools", toolNames: [] }), { status: 409 });
  assert.deepEqual(inner.getActiveToolNames(), IFCN_TOOLS, "rejected presets must leave workflow tools intact");
  await wrapper.send({ type: "set_tools", toolNames: [...IFCN_TOOLS].reverse() });
  assert.deepEqual(inner.getActiveToolNames(), IFCN_TOOLS);
});

test("generic sessions retain extension tools with coding presets and can disable all tools", async (t) => {
  const inner = makeInner();
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  await wrapper.send({ type: "set_tools", toolNames: ["read"] });
  assert.ok(inner.getActiveToolNames().includes("Agent"));
  assert.ok(inner.getActiveToolNames().includes("mcp_external"));
  assert.ok(inner.getActiveToolNames().includes("ifcn_run"));
  assert.ok(!inner.getActiveToolNames().includes("bash"));
  await wrapper.send({ type: "set_tools", toolNames: [] });
  assert.deepEqual(inner.getActiveToolNames(), []);
  assert.equal(inner.agent.state.systemPrompt, "");
});

test("an explicitly empty main profile stays empty after extension binding and reload", async (t) => {
  const inner = makeInner();
  const wrapper = new AgentSessionWrapper(inner, []);
  t.after(() => wrapper.destroy());
  wrapper.setForceEmptySystemPrompt(true);
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  await wrapper.send({ type: "reload" });
  assert.deepEqual(inner.getActiveToolNames(), []);
  assert.equal(inner.agent.state.systemPrompt, "");
});
