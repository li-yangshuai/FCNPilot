import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

test("new iFCN sessions default to the trusted main profile and reject other agent profiles", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-new-session-agent-"));
  const cwd = path.join(root, "engine");
  const otherCwd = path.join(root, "other");
  const agentDir = path.join(root, "agent");
  const profileDir = path.join(cwd, ".pi", "agents");
  const extensionDir = path.join(cwd, ".pi", "extensions", "ifcn");
  for (const directory of [profileDir, extensionDir, path.join(cwd, "scripts"), otherCwd, agentDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const environment = {
    IFCN_ROOT: cwd,
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEB_CONFIG_DIR: path.join(root, "web-config"),
    PI_WEB_SHARED_ROOTS: root,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profilePath = path.join(profileDir, "ifcn.md");
  fs.writeFileSync(profilePath, '---\nname: ifcn\ndescription: Circuit design main agent\ntools: "read, ifcn_capabilities, ifcn_run, ifcn_status, ifcn_artifact"\nskills: ""\n---\nDirectly own the circuit design workflow.\n');
  fs.writeFileSync(path.join(profileDir, "review.md"), '---\nname: review\ndescription: Reviewer\ntools: "read"\n---\nReview the circuit.\n');
  fs.writeFileSync(path.join(extensionDir, "index.ts"), "export default function () {}\n");
  fs.writeFileSync(path.join(cwd, "scripts", "ifcn_agent.py"), "raise RuntimeError('must not execute when resolving a main agent')\n");
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const { resolveNewSessionAgentConfig } = await jiti.import("./new-session-agent.ts");
  const uid = "00000000-0000-4000-8000-000000000000";
  const trust = new ProjectTrustStore(agentDir);

  await assert.rejects(resolveNewSessionAgentConfig(cwd, uid), /must be trusted/);
  trust.set(cwd, true);
  const main = await resolveNewSessionAgentConfig(cwd, uid);
  assert.equal(main.id, "project:ifcn");
  assert.equal(main.systemPrompt, "Directly own the circuit design workflow.");
  assert.deepEqual(main.tools, ["read", "write", "edit", "ifcn_capabilities", "ifcn_run", "ifcn_status", "ifcn_artifact"]);
  await assert.rejects(resolveNewSessionAgentConfig(cwd, uid, { id: "project:review" }), /only supports/);
  await assert.rejects(resolveNewSessionAgentConfig(otherCwd, uid));
  await assert.rejects(resolveNewSessionAgentConfig(cwd, uid, { id: "project:missing" }), /only supports/);
  await assert.rejects(resolveNewSessionAgentConfig(cwd, uid, {}), /only supports/);

  fs.unlinkSync(profilePath);
  await assert.rejects(resolveNewSessionAgentConfig(cwd, uid), { status: 409 });
  await assert.rejects(resolveNewSessionAgentConfig(cwd, uid, { id: "project:review" }), /only supports/);
  await assert.rejects(resolveNewSessionAgentConfig(otherCwd, uid));
});
