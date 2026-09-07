import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getIfcnWorkspace, readIfcnWorkspaceConfiguration, probeIfcnCapabilities, isIfcnWorkspace } =
  await jiti.import("./ifcn-workspace.ts");
const { trustProject } = await jiti.import("./project-trust.ts");

test("iFCN workspace validates its installation and respects trust before invoking capabilities", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ifcn-workspace-"));
  const web = path.join(root, "web");
  const engine = path.join(root, "engine");
  const agentDir = path.join(root, "agent");
  const originalCwd = process.cwd();
  const environment = Object.fromEntries(
    ["IFCN_ROOT", "PI_CODING_AGENT_DIR", "PI_WEB_CONFIG_DIR", "PI_WEB_SHARED_ROOTS"]
      .map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const directory of [web, engine]) {
    fs.mkdirSync(path.join(directory, ".pi", "extensions", "ifcn"), { recursive: true });
  }
  fs.mkdirSync(path.join(engine, "scripts"));
  fs.mkdirSync(path.join(engine, ".pi", "agents"));
  fs.mkdirSync(agentDir);
  delete process.env.IFCN_ROOT;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEB_CONFIG_DIR = path.join(root, "web-config");
  process.env.PI_WEB_SHARED_ROOTS = root;
  process.chdir(web);
  assert.equal(readIfcnWorkspaceConfiguration().configured, false);

  const configFile = path.join(web, ".pi", "extensions", "ifcn", "ifcn-config.json");
  const engineConfigFile = path.join(engine, ".pi", "extensions", "ifcn", "ifcn-config.json");
  const runner = path.join(engine, "scripts", "ifcn_agent.py");
  const marker = path.join(engine, "doctor-ran");
  const capabilities = {
    schema: "ifcn.pi.capabilities.v1", ready: true,
    stages: ["parse", "pnr", "map", "simulate", "energy"],
    algorithms: [{ id: "normal_2ddwave", available: true }],
    combinational: { supported: true },
  };
  const writeRunner = (value) => fs.writeFileSync(runner,
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\nprint(${JSON.stringify(JSON.stringify(value))})\n`,
  );
  fs.writeFileSync(configFile, JSON.stringify({ root: engine }));
  fs.writeFileSync(engineConfigFile, JSON.stringify({ root: engine }));
  fs.writeFileSync(path.join(engine, ".pi", "extensions", "ifcn", "index.ts"), "export default function () {}\n");
  fs.writeFileSync(path.join(engine, ".pi", "agents", "ifcn.md"),
    '---\nname: ifcn\ndescription: iFCN workflow\ntools: "read, ifcn_capabilities, ifcn_run, ifcn_status, ifcn_artifact"\n---\nUse the iFCN tools.\n',
  );
  writeRunner(capabilities);
  assert.deepEqual(readIfcnWorkspaceConfiguration(), { configured: true, cwd: engine, valid: true });
  assert.equal(isIfcnWorkspace(engine), true);
  assert.equal(isIfcnWorkspace(web), false);
  // Installation paths remain valid when the whole repository is moved.
  fs.writeFileSync(configFile, JSON.stringify({ root: path.relative(path.dirname(configFile), engine) }));
  fs.writeFileSync(engineConfigFile, JSON.stringify({ root: "../../.." }));
  assert.deepEqual(readIfcnWorkspaceConfiguration(), { configured: true, cwd: engine, valid: true });
  const bundledWeb = path.join(root, "apps", "web");
  fs.mkdirSync(bundledWeb, { recursive: true });
  assert.deepEqual(readIfcnWorkspaceConfiguration({ webRoot: bundledWeb, environment: {} }),
    { configured: true, cwd: engine, valid: true });
  const accountUid = "00000000-0000-4000-8000-000000000000";
  const untrusted = await getIfcnWorkspace(accountUid);
  assert.equal(untrusted.cwd, engine);
  assert.equal(untrusted.agentId, "project:ifcn");
  assert.equal(untrusted.available, false);
  assert.equal(untrusted.requiresTrust, true);
  assert.equal(untrusted.trusted, false);
  assert.equal(fs.existsSync(marker), false, "merely inspecting an untrusted project must not run its code");

  trustProject(engine, agentDir);
  const connected = await getIfcnWorkspace(accountUid);
  assert.equal(connected.available, true);
  assert.equal(connected.trusted, true);
  assert.deepEqual(connected.capabilities, capabilities);
  assert.equal(fs.existsSync(marker), true);

  writeRunner({ ...capabilities, ready: false });
  const unavailable = await getIfcnWorkspace(accountUid);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.capabilities.ready, false);
  assert.ok(unavailable.message);
  fs.writeFileSync(runner, "import time\ntime.sleep(10)\n");
  await assert.rejects(probeIfcnCapabilities(engine, 50), /超时/);
  fs.writeFileSync(runner, 'print("bad response")\n');
  await assert.rejects(probeIfcnCapabilities(engine), /响应无效/);

  fs.writeFileSync(engineConfigFile, JSON.stringify({ root: web }));
  assert.match(readIfcnWorkspaceConfiguration().message, /不一致/);
  assert.equal(readIfcnWorkspaceConfiguration({ environment: { IFCN_ROOT: engine } }).valid, true);
  fs.writeFileSync(configFile, "not json");
  const broken = await getIfcnWorkspace(accountUid);
  assert.equal(broken.configured, true, "a broken configured installation cannot silently become general chat");
  assert.equal(broken.available, false);
  assert.ok(broken.message);
});
