import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPrompt, parseProposal, propose, validateContext } from "./layout-proposer.mjs";

const context = () => ({
  dag: { nodes: [{ id: 0, name: "a", type: "input" }, { id: 1, name: "b", type: "input" }, { id: 2, name: "y", type: "and" }], edges: [[0, 2], [1, 2]] },
  placement: { nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 0, y: 2 }, { id: 2, x: 2, y: 2 }] },
  routes: [{ source: 0, target: 2, path: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]] }],
  rules: { clock: "2DDWave", require_drc: true }, metrics: { area_tiles: 9, qca_cells: 42 }, feedback: [],
  action_space: { coordinate_bounds: { min_x: 0, max_x: 4, min_y: 0, max_y: 4 }, max_operations: 3 },
});
const edit = operations => ({ schema: "ifcn.layout_edit.v1", operations, rationale: "Move the output toward its input cone." });
const good = () => edit([{ op: "move", node: 2, to: [1, 2] }]);

test("direct gate research requires internal relocation in both prompt and parser", () => {
  const ctx = context();
  ctx.dag.nodes[0] = { ...ctx.dag.nodes[0], is_input: true, is_output: false };
  ctx.dag.nodes[1] = { ...ctx.dag.nodes[1], is_input: false, is_output: false };
  ctx.dag.nodes[2] = { ...ctx.dag.nodes[2], is_input: false, is_output: true };
  ctx.action_space = { ...ctx.action_space, proposal_schema: "ifcn.layout_search.v2", selection_mode: "direct",
    must_change_internal_node: true, max_operations: 8 };
  ctx.rules.require_explicit_routing_order = true;
  const base = { schema: "ifcn.layout_search.v2", operations: [], routing_order: ctx.dag.edges, rationale: "Shorten an internal detour." };
  assert.throws(() => parseProposal(JSON.stringify(base), ctx), /internal gate/);
  assert.throws(() => parseProposal(JSON.stringify({ ...base, operations: [{ op: "move", node: 0, to: [1, 0] }] }), ctx), /internal gate/);
  const valid = { ...base, operations: [{ op: "move", node: 1, to: [1, 2] }] };
  assert.deepEqual(parseProposal(JSON.stringify(valid), ctx), valid);
  const prompt = buildPrompt(ctx);
  assert.match(prompt.system, /Use 1\.\.action_space.max_operations/);
  assert.doesNotMatch(prompt.system, /"operations":\[\]/);
  assert.equal(prompt.user, JSON.stringify(ctx));
  ctx.action_space.routing_order_owner = "deterministic_executor";
  ctx.rules.require_explicit_routing_order = false;
  const derived = { ...valid, routing_order: null };
  assert.deepEqual(parseProposal(JSON.stringify(derived), ctx), derived);
  assert.throws(() => parseProposal(JSON.stringify(valid), ctx), /routing_order=null/);
  assert.match(buildPrompt(ctx).system, /order is executor-authored/);
  assert.doesNotMatch(buildPrompt(ctx).system, /retain the original backend default multi-order/);
});
const message = (text, options = {}) => ({ role: "assistant", content: [{ type: "text", text }],
  stopReason: "stop", usage: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 160 }, ...options });
function factory(text, inspect) {
  return async () => ({ model: { id: "mock", provider: "test" }, source: "test", stream: async function* (ctx, options) {
    inspect?.(ctx, options);
    yield { type: "done", message: message(text) };
  } });
}

test("strict valid move and swap retain PI/PO movement by default", () => {
  assert.deepEqual(parseProposal(JSON.stringify(good()), context()), good());
  const proposal = edit([{ op: "swap", nodes: [0, 2] }]);
  assert.deepEqual(parseProposal(JSON.stringify(proposal), context()), proposal);
});

test("schema rejects fences, prose, extra keys, commands and missing fields", () => {
  const valid = JSON.stringify(good());
  for (const value of ["```json\n" + valid + "\n```", "Suggestion: " + valid, valid + " more", "{}",
    JSON.stringify({ ...good(), command: "rm -rf /" }), JSON.stringify(edit([{ op: "shell", command: "echo nope" }]))]) {
    assert.throws(() => parseProposal(value, context()), /schema|JSON|Only/);
  }
});

test("known IDs, integer coordinates, bounds, movable set and operation cap are mandatory", () => {
  const invalid = [edit([{ op: "move", node: 99, to: [1, 1] }]), edit([{ op: "move", node: 2, to: [1.5, 2] }]),
    edit([{ op: "move", node: 2, to: [-1, 2] }]), edit([{ op: "move", node: 2, to: [9, 2] }]),
    edit([{ op: "move", node: 2, to: [2, 2] }]), edit([]), edit(Array(4).fill({ op: "swap", nodes: [0, 1] })),
    edit([{ op: "swap", nodes: [0, 0] }]), edit([{ op: "move", node: 1, to: [1, 2] }, { op: "swap", nodes: [0, 1] }])];
  for (const proposal of invalid) assert.throws(() => parseProposal(JSON.stringify(proposal), context()));
  const fixed = context(); fixed.action_space.movable_node_ids = [0, 1];
  assert.throws(() => parseProposal(JSON.stringify(good()), fixed), /fixed/);
  const bounded = context(); bounded.action_space.coordinate_bounds.max_x = 1;
  assert.throws(() => parseProposal(JSON.stringify(edit([{ op: "swap", nodes: [0, 2] }])), bounded), /bounds/);
});

test("invalid context cannot start a provider request", async () => {
  const ctx = context(); ctx.placement.nodes[1].id = 0;
  assert.throws(() => validateContext(ctx), /repeats/);
  let called = false;
  const audit = await propose({ context: ctx }, { runtimeFactory: async () => { called = true; } });
  assert.equal(audit.status, "error"); assert.equal(audit.error.code, "invalid_input"); assert.equal(called, false);
});

test("a successful request retains exact prompt/response/usage and exposes zero tools", async () => {
  const ctx = context(), raw = JSON.stringify(good());
  const prompt = buildPrompt(ctx);
  const audit = await propose({ request_id: "bounded-1", context: ctx, timeout_ms: 1000, max_tokens: 800 }, {
    runtimeFactory: factory(raw, (sent, options) => {
      assert.deepEqual(sent.tools, []); assert.equal(sent.systemPrompt, prompt.system);
      assert.equal(sent.messages.length, 1); assert.equal(sent.messages[0].content, prompt.user);
      assert.equal(options.maxRetries, 0); assert.equal(options.maxTokens, 800); assert.ok(options.signal);
    }),
  });
  assert.equal(audit.status, "ok"); assert.deepEqual(audit.proposal, good());
  assert.equal(audit.request.user_prompt, prompt.user); assert.equal(audit.response.raw_text, raw);
  assert.equal(audit.usage.totalTokens, 160); assert.deepEqual(audit.model, { provider: "test", modelId: "mock" });
  assert.deepEqual(audit.tools_enabled, []); assert.equal(audit.edits_applied, false); assert.ok(audit.latency_ms >= 0);
});

test("unusable provider JSON remains in audit without a usable proposal", async () => {
  const raw = "```json\n" + JSON.stringify(good()) + "\n```";
  const audit = await propose({ context: context() }, { runtimeFactory: factory(raw) });
  assert.equal(audit.status, "invalid"); assert.equal(audit.proposal, null); assert.equal(audit.response.raw_text, raw);
});

test("unrequested tool calls are rejected and never executed", async () => {
  const audit = await propose({ context: context() }, { runtimeFactory: async () => ({
    model: { provider: "test", id: "mock" }, source: "test", stream: async function* () {
      yield { type: "done", message: message("", { stopReason: "toolUse", content: [{ type: "toolCall", name: "write", arguments: {} }] }) };
    },
  }) });
  assert.equal(audit.status, "invalid"); assert.equal(audit.proposal, null);
  assert.deepEqual(audit.tools_enabled, []); assert.equal(audit.edits_applied, false);
});

test("provider errors do not expose credential-bearing exception text", async () => {
  const secret = "sk-secret-never-save";
  for (const runtimeFactory of [async () => { throw new Error("Authorization: Bearer " + secret); },
    async () => ({ model: { provider: "test", id: "mock" }, source: "test", stream: async function* () {
      yield { type: "error", error: message("", { stopReason: "error", errorMessage: "invalid apiKey=" + secret }) };
    } })]) {
    const audit = await propose({ context: context() }, { runtimeFactory });
    assert.equal(audit.status, "error"); assert.equal(audit.proposal, null);
    assert.equal(JSON.stringify(audit).includes(secret), false); assert.ok(audit.error.code);
  }
});

test("wall-clock timeout aborts the request and retains partial text", async () => {
  let signal;
  const audit = await propose({ context: context(), timeout_ms: 20 }, { runtimeFactory: async () => ({
    model: { provider: "test", id: "mock" }, source: "test", stream: async function* (_ctx, options) {
      signal = options.signal;
      yield { type: "text_delta", partial: message('{"schema":', { stopReason: "pending" }) };
      await new Promise(() => {});
    },
  }) });
  assert.equal(audit.status, "error"); assert.equal(audit.error.code, "timeout");
  assert.equal(audit.proposal, null); assert.equal(audit.response.raw_text, '{"schema":');
  assert.ok(signal.aborted); assert.ok(audit.latency_ms < 500);
});

test("late runtime initialization cannot send a request after timeout", async () => {
  let invoked = false;
  const audit = await propose({ context: context(), timeout_ms: 5 }, { runtimeFactory: async () => {
    await delay(25);
    return { model: { provider: "test", id: "mock" }, source: "test", stream: async function* () { invoked = true; } };
  } });
  await delay(40);
  assert.equal(audit.error.code, "timeout"); assert.equal(invoked, false); assert.equal(audit.proposal, null);
});

test("CLI emits one JSON error and no credentials/tools on malformed stdin", () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./layout-proposer.mjs", import.meta.url))],
    { input: "not JSON", encoding: "utf8", timeout: 2000 });
  assert.equal(child.status, 1);
  const audit = JSON.parse(child.stdout);
  assert.equal(audit.status, "error"); assert.deepEqual(audit.tools_enabled, []); assert.equal(audit.edits_applied, false);
});

const jointContext = () => {
  const ctx = context();
  ctx.rules.clock = "irregular";
  ctx.action_space.proposal_schema = "ifcn.layout_search.v2";
  ctx.action_space.max_operations = 8;
  return ctx;
};
const search = (operations = [], routingOrder = [[1, 2], [0, 2]]) => ({
  schema: "ifcn.layout_search.v2", operations, routing_order: routingOrder,
  rationale: "Route the reconvergent input first, then compact the neighboring gate group.",
});

test("v2 replays the complete directed route order exactly, including route-only proposals", () => {
  const ctx = jointContext(), original = structuredClone(ctx);
  const proposal = search();
  const replay = parseProposal(JSON.stringify(proposal), ctx);
  assert.deepEqual(replay, proposal);
  assert.deepEqual(replay.routing_order, [[1, 2], [0, 2]]);
  assert.deepEqual(ctx, original);
  const locked = jointContext(); locked.action_space.movable_node_ids = [];
  assert.deepEqual(parseProposal(JSON.stringify(proposal), locked), proposal);
  assert.throws(() => parseProposal(JSON.stringify(search(good().operations)), locked), /fixed/);
});

test("v2 routing order rejects repeated, unknown, reversed, missing and malformed edges", () => {
  const invalidOrders = [
    [[0, 2], [0, 2]], // duplicate also omits an existing edge
    [[0, 2], [99, 2]],
    [[2, 0], [1, 2]], // reversed edge does not mean the same route
    [[0, 2]],
    [[0, 2], [1, 2], [1, 2]],
    [[0, 2, 1], [1, 2]],
    [["0", 2], [1, 2]],
    [[false, 2], [1, 2]],
    [[0.5, 2], [1, 2]],
    { first: [0, 2], second: [1, 2] },
    "default",
  ];
  for (const order of invalidOrders) {
    assert.throws(() => parseProposal(JSON.stringify(search([], order)), jointContext()), /routing_order/);
  }
  const repeatedContext = jointContext(); repeatedContext.dag.edges.push([0, 2]);
  assert.throws(() => validateContext(repeatedContext), /edges must be unique/);
});

test("v2 permits null default routing only with a placement edit", () => {
  const ctx = jointContext();
  assert.throws(() => parseProposal(JSON.stringify(search([], null)), ctx), /Zero edits/);
  const proposal = search(good().operations, null);
  assert.deepEqual(parseProposal(JSON.stringify(proposal), ctx), proposal);
  assert.deepEqual(parseProposal(JSON.stringify(search(good().operations)), ctx).operations, good().operations);
  for (const key of ["schema", "operations", "routing_order", "rationale"]) {
    const incomplete = search(); delete incomplete[key];
    assert.throws(() => parseProposal(JSON.stringify(incomplete), ctx), /schema|fields/);
  }
  assert.throws(() => parseProposal(JSON.stringify({ ...search(), phase_map: {} }), ctx), /fields/);
});

test("v2 allows eight coordinated operations without raising the v1 operation budget", () => {
  const ctx = jointContext();
  ctx.dag = { nodes: Array.from({ length: 9 }, (_, id) => ({ id })), edges: Array.from({ length: 8 }, (_, id) => [id, id + 1]) };
  ctx.placement.nodes = ctx.dag.nodes.map(({ id }) => ({ id, x: id, y: 0 }));
  ctx.action_space.coordinate_bounds = { min_x: 0, max_x: 10, min_y: 0, max_y: 2 };
  const operations = Array.from({ length: 8 }, (_, node) => ({ op: "move", node, to: [node, 1] }));
  assert.deepEqual(parseProposal(JSON.stringify(search(operations, null)), ctx).operations, operations);
  const nine = [...operations, { op: "move", node: 8, to: [8, 1] }];
  assert.throws(() => parseProposal(JSON.stringify(search(nine, null)), ctx), /maximum 8/);
  const lowerBudget = structuredClone(ctx); lowerBudget.action_space.max_operations = 3;
  assert.throws(() => parseProposal(JSON.stringify(search(operations, null)), lowerBudget), /max_operations/);
  const old = structuredClone(ctx); delete old.action_space.proposal_schema;
  assert.throws(() => validateContext(old), /1\.\.3/);
  old.action_space.max_operations = 3;
  assert.throws(() => parseProposal(JSON.stringify(edit(operations)), old), /maximum 3/);
  const defaults = jointContext(); delete defaults.action_space.max_operations;
  assert.equal(validateContext(defaults).maxOperations, 8);
  assert.equal(validateContext(context()).maxOperations, 3);
});

test("v1 context cannot authorize v2 schema, fields, or an expanded operation cap", () => {
  const old = context();
  assert.throws(() => parseProposal(JSON.stringify(search()), old), /schema/);
  assert.throws(() => parseProposal(JSON.stringify({ ...good(), routing_order: null }), old), /schema|fields/);
  assert.throws(() => parseProposal(JSON.stringify(good()), jointContext()), /schema/);
  const unknown = context(); unknown.action_space.proposal_schema = "ifcn.layout_search.v999";
  assert.throws(() => validateContext(unknown), /proposal_schema/);
  const explicitOld = context(); explicitOld.action_space.proposal_schema = "ifcn.layout_edit.v1";
  assert.deepEqual(parseProposal(JSON.stringify(good()), explicitOld), good());
  explicitOld.action_space.max_operations = 8;
  assert.throws(() => validateContext(explicitOld), /1\.\.3/);
});

test("v2 retains move/swap bounds and identity guards while legality stays with the executor", () => {
  const ctx = jointContext();
  for (const operations of [
    [{ op: "move", node: 0, to: [-1, 0] }],
    [{ op: "move", node: 2, to: [6, 2] }],
    [{ op: "move", node: 2, to: [2, 2] }],
    [{ op: "move", node: 1, to: [1, 2] }, { op: "swap", nodes: [1, 2] }],
    [{ op: "move", node: 0, to: [1, 1], layer: 2 }],
    [{ op: "phase", node: 0, value: 3 }],
  ]) assert.throws(() => parseProposal(JSON.stringify(search(operations, null)), ctx));
  const bounded = jointContext(); bounded.action_space.coordinate_bounds.max_x = 1;
  assert.throws(() => parseProposal(JSON.stringify(search([{ op: "swap", nodes: [0, 2] }], null)), bounded), /bounds/);
  // Preserve the v1 boundary: parsing validates the action contract, not final
  // occupancy or DRC. The native validator can reject this stationary collision.
  const collision = [{ op: "move", node: 0, to: [0, 2] }];
  assert.deepEqual(parseProposal(JSON.stringify(edit(collision)), context()).operations, collision);
  assert.deepEqual(parseProposal(JSON.stringify(search(collision, null)), ctx).operations, collision);
});

test("v2 prompt preserves supplied evidence and separates model decisions from deterministic execution", () => {
  const ctx = jointContext();
  ctx.clock_arrival = { passed: true, launch_cycle: 0 };
  ctx.phase_map = [{ x: 0, y: 0, phase: 0 }];
  ctx.congestion = { overused_sites: [[1, 1]] };
  ctx.compact_candidates = [{ proposal: search(), validated: false }];
  ctx.feedback = [{ error: "route blocked", requested_order: [[0, 2], [1, 2]], actual_moves: [] }];
  const prompt = buildPrompt(ctx);
  assert.deepEqual(JSON.parse(prompt.user), ctx);
  assert.match(prompt.system, /jointly optimize placement AND route order/);
  assert.match(prompt.system, /unvalidated proposals/);
  assert.match(prompt.system, /explicit_order.*exact order once.*no alternate-order fallback/);
  assert.match(prompt.system, /null.*default multi-order routing/);
  assert.match(prompt.system, /solver remains the executor/);
  assert.match(prompt.system, /not private chain-of-thought/);
  assert.match(prompt.system, /cannot directly change layer, phase or clock/);
  const old = buildPrompt(context());
  assert.match(old.system, /ifcn\.layout_edit\.v1/);
  assert.doesNotMatch(old.system, /ifcn\.layout_search\.v2|routing_order/);
});

test("v2 audit retains exact order with one mocked request and never applies edits", async () => {
  const ctx = jointContext(), proposal = search();
  let calls = 0;
  const audit = await propose({ context: ctx, timeout_ms: 1000 }, {
    runtimeFactory: factory(JSON.stringify(proposal), (sent, options) => {
      calls += 1; assert.deepEqual(sent.tools, []); assert.equal(options.maxRetries, 0);
    }),
  });
  assert.equal(calls, 1); assert.equal(audit.status, "ok");
  assert.deepEqual(audit.proposal, proposal);
  assert.equal(audit.edits_applied, false);
  assert.deepEqual(audit.tools_enabled, []);
  const repeated = search([], [[1, 2], [1, 2]]);
  const rejected = await propose({ context: ctx }, { runtimeFactory: factory(JSON.stringify(repeated)) });
  assert.equal(rejected.status, "invalid"); assert.equal(rejected.proposal, null);
  assert.equal(rejected.response.raw_text, JSON.stringify(repeated));
});


test("required explicit v2 routing rejects null in parsing and model audit", async () => {
  const ctx = jointContext(); ctx.rules.require_explicit_routing_order = true;
  for (const operations of [[], good().operations]) {
    const raw = JSON.stringify(search(operations, null));
    assert.throws(() => parseProposal(raw, ctx), /requires an explicit complete routing_order/);
    const audit = await propose({ context: ctx }, { runtimeFactory: factory(raw) });
    assert.equal(audit.status, "invalid"); assert.equal(audit.proposal, null);
    assert.equal(audit.response.raw_text, raw);
    assert.match(audit.error.message, /null is forbidden/);
  }
});

test("required explicit v2 routing accepts complete orders with or without placement edits", () => {
  const ctx = jointContext(); ctx.rules.require_explicit_routing_order = true;
  for (const operations of [[], good().operations]) {
    const proposal = search(operations);
    assert.deepEqual(parseProposal(JSON.stringify(proposal), ctx), proposal);
  }
  assert.throws(() => parseProposal(JSON.stringify(search([], [[0, 2]])), ctx), /complete permutation/);
  assert.throws(() => parseProposal(JSON.stringify(search([], [[0, 2], [0, 2]])), ctx), /repeats/);
});

test("required explicit routing prompt and example never authorize a null/default order", () => {
  const ctx = jointContext(); ctx.rules.require_explicit_routing_order = true;
  const prompt = buildPrompt(ctx);
  assert.match(prompt.system, /must supply an explicit complete routing_order, never null/);
  assert.match(prompt.system, /each directed \[source,target\] edge exactly once/);
  assert.match(prompt.system, /null and default routing are forbidden/);
  assert.doesNotMatch(prompt.system, /Set routing_order to null|retain the original backend default|"routing_order":null/);
  const example = JSON.parse(prompt.system.split("\n").find(line => line.startsWith('{"schema":')));
  assert.deepEqual(example.routing_order, ctx.dag.edges);
  assert.deepEqual(parseProposal(JSON.stringify(example), ctx), example);
  assert.deepEqual(JSON.parse(prompt.user), ctx);
});

test("explicit-order rule is opt-in for general v2 and does not alter v1", () => {
  for (const flag of [undefined, false, "true", 1]) {
    const ctx = jointContext(); ctx.rules.require_explicit_routing_order = flag;
    const proposal = search(good().operations, null);
    assert.deepEqual(parseProposal(JSON.stringify(proposal), ctx), proposal);
    assert.match(buildPrompt(ctx).system, /Set routing_order to null/);
  }
  const old = context(); old.rules.require_explicit_routing_order = true;
  assert.deepEqual(parseProposal(JSON.stringify(good()), old), good());
  assert.equal(buildPrompt(old).system, buildPrompt(context()).system);
});


const menuContext = () => {
  const ctx = jointContext();
  ctx.rules.require_explicit_routing_order = true;
  ctx.action_space.selection_mode = "candidate_menu";
  ctx.candidate_menu = [
    { id: "cut-x-1-order-a", operations: good().operations, routing_order: [[1, 2], [0, 2]],
      features: { placement_area: 6, native_evaluated: false }, description: "Compress the gate box and route input b first." },
    { id: "route-only-b", operations: [], routing_order: [[0, 2], [1, 2]],
      features: { placement_area: 9, native_evaluated: false }, description: "Keep placement and route input a first." },
  ];
  return ctx;
};
const choice = (id = "cut-x-1-order-a") => ({ schema: "ifcn.layout_choice.v1", candidate_id: id,
  rationale: "The selected group move shortens the gate box while prioritizing the reconvergent input." });

test("menu choice lowers to an exact independent copy of one native v2 candidate", () => {
  const ctx = menuContext(), original = structuredClone(ctx);
  for (const entry of ctx.candidate_menu) {
    const selected = choice(entry.id), lowered = parseProposal(JSON.stringify(selected), ctx);
    assert.deepEqual(lowered, { schema: "ifcn.layout_search.v2", operations: entry.operations,
      routing_order: entry.routing_order, rationale: selected.rationale });
    assert.notEqual(lowered.operations, entry.operations);
    assert.notEqual(lowered.routing_order, entry.routing_order);
    lowered.routing_order[0][0] = 99;
    if (lowered.operations.length) lowered.operations[0].to[0] = 99;
    assert.deepEqual(ctx, original);
  }
});

test("menu response rejects rewritten actions, mixed IDs, unknown IDs and extra fields", () => {
  const ctx = menuContext();
  const invalid = [
    search(), // Free-form v2 is not authorized by a menu context.
    { ...choice(), operations: [] },
    { ...choice(), routing_order: [[0, 2], [1, 2]] },
    { ...choice(), candidate_ids: ["cut-x-1-order-a", "route-only-b"] },
    { ...choice(), candidate_id: ["cut-x-1-order-a", "route-only-b"] },
    choice("cut-x-1-order-a+route-only-b"),
    choice("not-in-this-menu"),
    { schema: "ifcn.layout_choice.v1", candidate_id: "route-only-b" },
    { ...choice(), rationale: "" },
    { ...choice(), rationale: "x".repeat(1201) },
  ];
  for (const proposal of invalid) assert.throws(() => parseProposal(JSON.stringify(proposal), ctx));
});

test("invalid menu identities, cardinality and native actions are rejected before a model request", async () => {
  const invalidMenus = [
    [],
    Array.from({ length: 65 }, (_, id) => ({ ...menuContext().candidate_menu[0], id: String(id) })),
    [menuContext().candidate_menu[0], menuContext().candidate_menu[0]],
    [{ ...menuContext().candidate_menu[0], id: "" }],
    [{ ...menuContext().candidate_menu[0], id: 3 }],
    [{ ...menuContext().candidate_menu[0], operations: [{ op: "move", node: 2, to: [9, 2] }] }],
    [{ ...menuContext().candidate_menu[0], operations: [{ op: "shell", command: "no" }] }],
    [{ ...menuContext().candidate_menu[0], operations: [{ op: "move", node: 2, to: [1, 2], command: undefined }] }],
    [{ ...menuContext().candidate_menu[0], routing_order: null }],
    [{ ...menuContext().candidate_menu[0], routing_order: [[0, 2]] }],
    [{ ...menuContext().candidate_menu[0], routing_order: [[0, 2], [0, 2]] }],
    [{ ...menuContext().candidate_menu[0], routing_order: [[99, 2], [1, 2]] }],
  ];
  for (const entries of invalidMenus) {
    const ctx = menuContext(); ctx.candidate_menu = entries;
    let invoked = false;
    assert.throws(() => validateContext(ctx), /menu|Menu/);
    const audit = await propose({ context: ctx }, { runtimeFactory: async () => { invoked = true; } });
    assert.equal(invoked, false); assert.equal(audit.status, "error");
    assert.equal(audit.error.code, "invalid_input");
  }
});

test("menu limit admits exactly 64 entries with valid immutable action contracts", () => {
  const ctx = menuContext(), entry = ctx.candidate_menu[0];
  ctx.candidate_menu = Array.from({ length: 64 }, (_, index) => ({ ...structuredClone(entry), id: `candidate-${index}` }));
  const parsed = parseProposal(JSON.stringify(choice("candidate-63")), ctx);
  assert.deepEqual(parsed.operations, entry.operations);
  assert.deepEqual(parsed.routing_order, entry.routing_order);
});

test("menu must opt in under v2 and never loosens general v1 or v2 response schemas", () => {
  assert.throws(() => parseProposal(JSON.stringify(choice()), context()), /schema/);
  assert.throws(() => parseProposal(JSON.stringify(choice()), jointContext()), /schema/);
  const old = menuContext(); delete old.action_space.proposal_schema; old.action_space.max_operations = 3;
  assert.throws(() => validateContext(old), /selection requires/);
  const optionalOrder = menuContext(); delete optionalOrder.rules.require_explicit_routing_order;
  optionalOrder.candidate_menu[0].routing_order = null;
  assert.throws(() => validateContext(optionalOrder), /explicit complete routing_order/);
});

test("menu prompt permits only an ID choice, with no free-coordinate output example", () => {
  const ctx = menuContext(), prompt = buildPrompt(ctx);
  assert.deepEqual(JSON.parse(prompt.user), ctx);
  assert.equal(prompt.user, JSON.stringify(ctx));
  assert.equal(buildPrompt(context()).user, JSON.stringify(context(), null, 2));
  assert.equal(buildPrompt(jointContext()).user, JSON.stringify(jointContext(), null, 2));
  assert.match(prompt.system, /select one unevaluated joint placement-and-routing candidate/);
  assert.match(prompt.system, /not native-executor pre-evaluations/);
  assert.match(prompt.system, /copies the selected entry's operations and routing_order exactly/);
  assert.match(prompt.system, /no automatic fallback/);
  assert.match(prompt.system, /Do not rewrite coordinates or routing_order/);
  assert.doesNotMatch(prompt.system, /"operations":|"routing_order":|operation alternatives|Set routing_order to null/);
  const example = JSON.parse(prompt.system.split("\n").find(line => line.startsWith('{"schema":')));
  assert.equal(example.schema, "ifcn.layout_choice.v1");
  assert.equal(example.candidate_id, ctx.candidate_menu[0].id);
  assert.doesNotThrow(() => parseProposal(JSON.stringify(example), ctx));
});

test("menu audit preserves original choice text, lowered actions and explicit decision provenance", async () => {
  const ctx = menuContext(), selected = choice("route-only-b"), raw = JSON.stringify(selected);
  let calls = 0;
  const audit = await propose({ context: ctx }, { runtimeFactory: factory(raw, () => { calls += 1; }) });
  assert.equal(calls, 1); assert.equal(audit.status, "ok");
  assert.equal(audit.response.raw_text, raw);
  assert.deepEqual(audit.decision, { schema: "ifcn.layout_choice.v1", candidate_id: "route-only-b" });
  assert.deepEqual(audit.proposal, { schema: "ifcn.layout_search.v2", operations: [],
    routing_order: ctx.candidate_menu[1].routing_order, rationale: selected.rationale });
  assert.match(audit.scope, /lowered exactly from the selected supplied, unvalidated candidate/);
  assert.equal(audit.edits_applied, false); assert.deepEqual(audit.tools_enabled, []);
  const free = await propose({ context: jointContext() }, { runtimeFactory: factory(JSON.stringify(search())) });
  assert.equal(free.status, "ok"); assert.equal(Object.hasOwn(free, "decision"), false);
});

test("fixed-interior prompt exposes the changed objective without permitting port edits", () => {
  const ctx = jointContext();
  ctx.rules.port_coordinates_movable = false;
  ctx.action_space.movable_node_ids = [2];
  const prompt = buildPrompt(ctx);
  assert.match(prompt.system, /All primary input\/output coordinates are locked/);
  assert.match(prompt.system, /gate bounding box may remain unchanged/);
  assert.match(prompt.system, /synthesize different coordinates and groups/);
  assert.throws(() => parseProposal(JSON.stringify(search([{op:"move", node:0, to:[1,1]}])), ctx), /fixed node/);
  assert.doesNotMatch(buildPrompt(jointContext()).system, /All primary input\/output coordinates are locked/);
});


// Small PNG fixture for transport-contract tests, not circuit or optimization evidence.
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const layoutImage = (bytes = PNG_BYTES) => ({ data_base64: bytes.toString("base64"), mime_type: "image/png",
  sha256: createHash("sha256").update(bytes).digest("hex") });
function imageFactory(text, inspect, input = ["text", "image"]) {
  return async () => ({ model: { id: "mock-vision", provider: "test", input }, source: "test", stream: async function* (ctx, options) {
    inspect?.(ctx, options);
    yield { type: "done", message: message(text) };
  } });
}

test("optional PNG reaches the Pi stream as real image content with compact provenance audit", async () => {
  for (const [ctx, raw] of [[context(), JSON.stringify(good())], [jointContext(), JSON.stringify(search())],
                            [menuContext(), JSON.stringify(choice())]]) {
    let calls = 0;
    const image = layoutImage(), request = { context: ctx, layout_image: image }, original = structuredClone(request);
    const audit = await propose(request, { runtimeFactory: imageFactory(raw, (sent, options) => {
      calls += 1;
      assert.deepEqual(sent.tools, []); assert.equal(options.maxRetries, 0);
      assert.match(sent.systemPrompt, /PNG layout image is attached/);
      assert.match(sent.systemPrompt, /JSON action space remains authoritative/);
      const content = sent.messages[0].content;
      assert.equal(content.length, 2);
      assert.deepEqual(content[0], { type: "text", text: buildPrompt(ctx).user });
      assert.deepEqual(content[1], { type: "image", data: image.data_base64, mimeType: "image/png" });
      assert.deepEqual(Buffer.from(content[1].data, "base64"), PNG_BYTES);
    }) });
    assert.equal(calls, 1); assert.equal(audit.status, "ok");
    assert.deepEqual(request, original);
    const meta = audit.request.layout_image;
    assert.equal(meta.sha256, image.sha256); assert.equal(meta.bytes, PNG_BYTES.length);
    assert.equal(meta.mime_type, "image/png"); assert.equal(meta.png_header_validated, true);
    assert.equal(meta.submitted_to_runtime, true); assert.match(meta.provenance, /Caller-supplied/);
    assert.deepEqual(audit.request.content_types, ["text", "image"]);
    assert.equal(JSON.stringify(audit).includes(image.data_base64), false);
    assert.equal(Object.hasOwn(meta, "data_base64"), false);
    const textOnly = await propose({ context: ctx }, { runtimeFactory: factory(raw) });
    assert.equal(textOnly.status, "ok"); assert.equal(Object.hasOwn(textOnly.request, "layout_image"), false);
    assert.notEqual(audit.request.prompt_sha256, textOnly.request.prompt_sha256);
    const { submitted_to_runtime, ...promptImage } = meta;
    assert.equal(audit.request.prompt_sha256, createHash("sha256").update(JSON.stringify({
      system: audit.request.system_prompt, user: audit.request.user_prompt, layout_image: promptImage,
    })).digest("hex"));
  }
});

test("malformed image shape, base64, PNG, hash and size fail before runtime creation", async () => {
  const valid = layoutImage();
  const badHeader = Buffer.from(PNG_BYTES); badHeader[0] = 0;
  const missingIhdr = Buffer.from(PNG_BYTES); missingIhdr.write("TEXT", 12, "ascii");
  const zeroWidth = Buffer.from(PNG_BYTES); zeroWidth.writeUInt32BE(0, 16);
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
  const invalid = [null, {}, { ...valid, extra: 1 }, { ...valid, mime_type: "image/jpeg" },
    { ...valid, data_base64: "" }, { ...valid, data_base64: valid.data_base64 + "\n" },
    { ...valid, data_base64: "data:image/png;base64," + valid.data_base64 },
    { ...valid, data_base64: valid.data_base64.slice(0, -1) },
    { ...valid, data_base64: valid.data_base64.replace("/", "_") },
    { ...valid, data_base64: "AAAA=AAA" }, { ...valid, data_base64: "AAAA====" },
    { ...valid, sha256: "0".repeat(64) }, { ...valid, sha256: valid.sha256.toUpperCase() },
    layoutImage(badHeader), layoutImage(missingIhdr), layoutImage(zeroWidth), layoutImage(PNG_BYTES.subarray(0, 8)), layoutImage(oversized)];
  for (const image of invalid) {
    let created = false;
    const audit = await propose({ context: context(), layout_image: image }, { runtimeFactory: async () => { created = true; } });
    assert.equal(created, false); assert.equal(audit.status, "error"); assert.equal(audit.error.code, "invalid_input");
    assert.equal(audit.proposal, null); assert.equal(audit.usage, null);
    if (image?.data_base64?.length > 32) assert.equal(JSON.stringify(audit).includes(image.data_base64), false);
  }
});

test("image requests fail closed on text-only or unknown model capability without a fallback", async () => {
  for (const input of [undefined, null, [], ["text"], "image", { image: true }]) {
    let created = 0, invoked = 0;
    const runtime = imageFactory(JSON.stringify(good()), () => { invoked += 1; }, input);
    const audit = await propose({ context: context(), layout_image: layoutImage() }, {
      runtimeFactory: async (...args) => {
        created += 1; const selected = await runtime(...args); selected.model.input = input; return selected;
      },
    });
    assert.equal(created, 1); assert.equal(invoked, 0);
    assert.equal(audit.status, "error"); assert.equal(audit.error.code, "model_image_unsupported");
    assert.equal(audit.request.layout_image.submitted_to_runtime, false);
    assert.equal(audit.proposal, null); assert.equal(audit.usage, null);
    assert.deepEqual(audit.model, { provider: "test", modelId: "mock-vision" });
  }
});

test("a vision-provider failure retains image provenance and never retries as text", async () => {
  let calls = 0;
  const audit = await propose({ context: jointContext(), layout_image: layoutImage() }, { runtimeFactory: async () => ({
    model: { id: "mock-vision", provider: "test", input: ["text", "image"] }, source: "test", stream: async function* (sent) {
      calls += 1; assert.equal(sent.messages[0].content[1].type, "image");
      yield { type: "error", error: message("", { stopReason: "error" }) };
    },
  }) });
  assert.equal(calls, 1); assert.equal(audit.error.code, "provider_error");
  assert.equal(audit.request.layout_image.submitted_to_runtime, true);
  assert.equal(audit.proposal, null);
});

test("CLI permits image envelope overhead but preserves the old text-only byte bound", () => {
  const cli = fileURLToPath(new URL("./layout-proposer.mjs", import.meta.url));
  // A large malformed image reaches image validation, never configuration or a model.
  const image = { ...layoutImage(), data_base64: "!".repeat(2 * 1024 * 1024 + 4) };
  const multimodal = spawnSync(process.execPath, [cli], { input: JSON.stringify({ context: context(), layout_image: image }), encoding: "utf8", timeout: 4000 });
  assert.equal(multimodal.status, 1);
  const error = JSON.parse(multimodal.stdout);
  assert.match(error.error.message, /layout_image/); assert.equal(error.error.code, "invalid_input");
  const textOnly = spawnSync(process.execPath, [cli], { input: JSON.stringify({ context: context(), padding: "x".repeat(2 * 1024 * 1024) }), encoding: "utf8", timeout: 4000 });
  assert.equal(textOnly.status, 1);
  assert.match(JSON.parse(textOnly.stdout).error.message, /bounded JSON request/);
});


test("local-search menu opt-in attributes only the seed to the model without first-ID example bias", () => {
  const ctx = menuContext(); ctx.rules.local_search_guidance = true;
  const prompt = buildPrompt(ctx);
  assert.match(prompt.system, /search seed and its spatial region/);
  assert.match(prompt.system, /internal sparse regions/);
  assert.match(prompt.system, /Only the first candidate's exact coordinates and edge order/);
  assert.match(prompt.system, /bounded deterministic local search.*explicit neighboring candidates/);
  assert.match(prompt.system, /not model-authored moves or silent router-order retries/);
  const example = JSON.parse(prompt.system.split("\n").find(line => line.startsWith('{"schema":')));
  assert.equal(example.candidate_id, "<one supplied candidate ID>");
  assert.deepEqual(JSON.parse(prompt.user), ctx);
  assert.deepEqual(parseProposal(JSON.stringify(choice()), ctx).operations, ctx.candidate_menu[0].operations);
  for (const flag of [undefined, false, "true", 1]) {
    const old = menuContext(); old.rules.local_search_guidance = flag;
    const legacy = buildPrompt(old);
    assert.doesNotMatch(legacy.system, /bounded deterministic local search/);
    const oldExample = JSON.parse(legacy.system.split("\n").find(line => line.startsWith('{"schema":')));
    assert.equal(oldExample.candidate_id, old.candidate_menu[0].id);
  }
  const direct = jointContext(); direct.rules.local_search_guidance = true;
  assert.doesNotMatch(buildPrompt(direct).system, /bounded deterministic local search/);
});
