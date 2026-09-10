import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const FCN_TOOLS = ["read", "write", "edit", "ifcn_capabilities", "ifcn_run", "ifcn_status", "ifcn_artifact"];
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(t) {
  const events = [];
  let tools = [];
  const inner = {
    sessionId: "reload-admission-test",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
    settingsManager: { setProjectTrusted() { events.push("trust"); } },
    agent: { state: { systemPrompt: "FCN main policy" } },
    extensionRunner: { setUIContext() { events.push("ui"); } },
    modelRuntime: { async refresh() {} },
    getActiveToolNames: () => [...tools],
    setActiveToolsByName(names) { tools = [...names]; events.push("policy"); },
    async prompt(message, options) {
      events.push(`prompt:${message}`);
      assert.deepEqual(tools, FCN_TOOLS, "a prompt must only see the restored FCN policy");
      options.preflightResult(true);
    },
    async reload() {
      events.push("reload");
      tools = [...FCN_TOOLS, "generic-extension-tool"];
    },
    abort() { events.push("abort"); },
    abortBash() { events.push("abortBash"); },
    dispose() { events.push("dispose"); },
  };
  const wrapper = new AgentSessionWrapper(inner, FCN_TOOLS);
  t.after(() => wrapper.destroy());
  events.length = 0;
  return { wrapper, inner, events };
}

test("a busy SDK run, compaction, or shell rejects reload with 409 without aborting", async (t) => {
  for (const flag of ["isStreaming", "isCompacting", "isBashRunning"]) {
    await t.test(flag, async (t) => {
      const { wrapper, inner, events } = fixture(t);
      inner[flag] = true;
      await assert.rejects(wrapper.send({ type: "reload" }), { status: 409 });
      assert.deepEqual(events, [], "rejection must not clear resources, reset policy, or abort work");
      assert.equal(wrapper.isAlive(), true);
      inner[flag] = false;
      assert.deepEqual(await wrapper.send({ type: "reload" }), { success: true });
      assert.equal(wrapper.isRunning(), false);
    });
  }
});

test("reload waits for an earlier prompt preflight, then rejects while that prompt remains active", async (t) => {
  const { wrapper, inner, events } = fixture(t);
  const completion = deferred();
  let accept;
  inner.prompt = (_message, options) => {
    events.push("prompt:started");
    accept = () => options.preflightResult(true);
    return completion.promise;
  };
  const prompt = wrapper.send({ type: "prompt", message: "running" });
  await nextTurn();
  assert.equal(wrapper.isRunning(), true, "pending SDK preflight counts even before streaming begins");
  let rejected = false;
  const reload = assert.rejects(wrapper.send({ type: "reload" }), { status: 409 }).then(() => { rejected = true; });
  await nextTurn();
  assert.equal(rejected, false, "reload must acquire the same admission lock, not race preflight");
  assert.deepEqual(events, ["prompt:started"]);
  accept();
  await Promise.all([prompt, reload]);
  assert.equal(wrapper.isRunning(), true);
  assert.deepEqual(events, ["prompt:started"], "no reload or abort may interrupt the admitted prompt");
  completion.resolve();
  await nextTurn();
  assert.equal(wrapper.isRunning(), false);
  await wrapper.send({ type: "reload" });
  assert.ok(events.includes("reload"), "busy rejection must release admission for later requests");
});

test("reload holds prompt admission across initial binding, SDK reload, and policy restoration", async (t) => {
  const { wrapper, inner, events } = fixture(t);
  const binding = deferred();
  const reloaded = deferred();
  inner.bindExtensions = async () => {
    events.push("binding:start");
    await binding.promise;
    events.push("binding:end");
  };
  const originalReload = inner.reload;
  inner.reload = async () => {
    await originalReload();
    await reloaded.promise;
    events.push("reload:end");
  };
  wrapper.beginExtensionBinding();
  const reload = wrapper.send({ type: "reload" });
  await nextTurn();
  assert.equal(wrapper.isRunning(), true, "reload must be busy while extension binding is awaited");
  const prompt = wrapper.send({ type: "prompt", message: "after reload" });
  await nextTurn();
  assert.deepEqual(events, ["binding:start"]);
  binding.resolve();
  await nextTurn();
  assert.ok(events.includes("reload"));
  assert.ok(!events.includes("prompt:after reload"));
  assert.equal(wrapper.isRunning(), true);
  reloaded.resolve();
  assert.deepEqual(await reload, { success: true });
  await prompt;
  await nextTurn();
  const finish = events.indexOf("reload:end");
  const policy = events.indexOf("policy", finish);
  const submitted = events.indexOf("prompt:after reload");
  assert.ok(finish >= 0 && policy > finish && submitted > policy, events.join(", "));
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(inner.getActiveToolNames(), FCN_TOOLS);
});

test("an SDK reload error restores FCN tools before releasing a queued prompt", async (t) => {
  const { wrapper, inner, events } = fixture(t);
  const failed = deferred();
  const originalReload = inner.reload;
  inner.reload = async () => {
    await originalReload();
    await failed.promise;
  };
  const reload = assert.rejects(wrapper.send({ type: "reload" }), /SDK reload failed/);
  await nextTurn();
  const prompt = wrapper.send({ type: "prompt", message: "after failure" });
  await nextTurn();
  assert.ok(!events.includes("prompt:after failure"));
  failed.reject(new Error("SDK reload failed"));
  await Promise.all([reload, prompt]);
  await nextTurn();
  assert.deepEqual(inner.getActiveToolNames(), FCN_TOOLS);
  assert.ok(events.indexOf("policy") < events.indexOf("prompt:after failure"));
  assert.ok(!events.includes("abort"));
  assert.equal(wrapper.isRunning(), false);
  inner.reload = originalReload;
  assert.deepEqual(await wrapper.send({ type: "reload" }), { success: true });
});

test("failed initial binding releases reload admission so a second request cannot deadlock", { timeout: 3000 }, async (t) => {
  const { wrapper, inner, events } = fixture(t);
  const binding = deferred();
  inner.bindExtensions = () => binding.promise;
  t.mock.method(console, "error", () => {});
  wrapper.beginExtensionBinding();
  const first = assert.rejects(wrapper.send({ type: "reload" }), /binding failed/);
  await nextTurn();
  binding.reject(new Error("binding failed"));
  await first;
  await assert.rejects(wrapper.send({ type: "reload" }), /binding failed/);
  assert.equal(events.includes("reload"), false);
  assert.deepEqual(inner.getActiveToolNames(), FCN_TOOLS);
  assert.equal(wrapper.isRunning(), false);
});

test("a policy-restoration exception cannot strand the reload admission lock", { timeout: 3000 }, async (t) => {
  const { wrapper, inner, events } = fixture(t);
  // Keep the existing safe policy while testing an exceptional setter, so this
  // test makes no claim that a failed policy reset permits unsafe tools.
  inner.reload = async () => { events.push("reload"); };
  const originalPolicy = inner.setActiveToolsByName;
  let fail = true;
  inner.setActiveToolsByName = (names) => {
    if (fail) { fail = false; throw new Error("policy restore failed"); }
    originalPolicy(names);
  };
  await assert.rejects(wrapper.send({ type: "reload" }), /policy restore failed/);
  assert.equal(wrapper.isRunning(), false);
  await wrapper.send({ type: "reload" });
  await wrapper.send({ type: "prompt", message: "policy recovered" });
  assert.ok(events.includes("prompt:policy recovered"));
});

test("idle expiry cannot destroy an extension reload and restarts its grace period afterwards", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { wrapper, inner, events } = fixture(t);
  const reloaded = deferred();
  inner.reload = () => reloaded.promise;
  const reload = wrapper.send({ type: "reload" });
  await nextTurn();
  assert.equal(wrapper.isRunning(), true);
  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(events.includes("dispose"), false);
  reloaded.resolve();
  await reload;
  assert.equal(wrapper.isRunning(), false);
  t.mock.timers.tick(10 * 60 * 1000 - 1);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
  assert.equal(events.filter((event) => event === "dispose").length, 1);
});

test("concurrent reload requests run sequentially and release busy state after each", async (t) => {
  const { wrapper, inner } = fixture(t);
  const first = deferred();
  let calls = 0;
  let active = 0;
  inner.reload = async () => {
    calls += 1;
    active += 1;
    assert.equal(active, 1, "SDK reloads may not overlap");
    if (calls === 1) await first.promise;
    active -= 1;
  };
  const reload1 = wrapper.send({ type: "reload" });
  const reload2 = wrapper.send({ type: "reload" });
  await nextTurn();
  assert.equal(calls, 1);
  first.resolve();
  await Promise.all([reload1, reload2]);
  assert.equal(calls, 2);
  assert.equal(wrapper.isRunning(), false);
});
