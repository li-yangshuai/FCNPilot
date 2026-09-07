import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SHARED_ACCOUNT_UID = "00000000-0000-4000-8000-000000000000";

function agentSource(name, prompt) {
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(`${name} description`)}`,
    'tools: "read, bash"',
    'skills: "*"',
    "---",
    "",
    prompt,
    "",
  ].join("\n");
}

test("project Agents require trust, are server-resolved, and cannot escape through symlinks", async (t) => {
  const nativeSubagentsDir = path.join(
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
    "npm", "node_modules", "@tintinweb", "pi-subagents", "dist",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-custom-agents-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const configDir = path.join(root, "web-config");
  const workspaces = path.join(root, "workspaces");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.mkdirSync(workspaces, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "agents", "global.md"),
    agentSource("global", "Trusted global prompt"),
  );

  const previousEnvironment = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_WEB_CONFIG_DIR: process.env.PI_WEB_CONFIG_DIR,
    PI_WEB_SHARED_ROOTS: process.env.PI_WEB_SHARED_ROOTS,
  };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEB_CONFIG_DIR: configDir,
    PI_WEB_SHARED_ROOTS: workspaces,
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const {
    createCustomAgent,
    listCustomAgents,
    resolveCustomAgentRuntimeConfig,
    updateCustomAgent,
  } = await jiti.import("./custom-agent-files.ts");
  const { getProjectTrustStatus, trustProject } = await jiti.import("./project-trust.ts");

  const untrustedProject = path.join(workspaces, "untrusted");
  fs.mkdirSync(path.join(untrustedProject, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(untrustedProject, ".pi", "agents", "reviewer.md"),
    agentSource("reviewer", "Untrusted project prompt"),
  );

  assert.deepEqual(getProjectTrustStatus(untrustedProject, agentDir), {
    requiresTrust: true,
    trusted: false,
  });
  assert.deepEqual(
    (await listCustomAgents(untrustedProject, SHARED_ACCOUNT_UID)).map((agent) => agent.id),
    ["global:global"],
  );
  await assert.rejects(
    resolveCustomAgentRuntimeConfig(untrustedProject, SHARED_ACCOUNT_UID, "project:reviewer"),
    /must be trusted/,
  );

  trustProject(untrustedProject, agentDir);
  const resolved = await resolveCustomAgentRuntimeConfig(
    untrustedProject,
    SHARED_ACCOUNT_UID,
    "project:reviewer",
  );
  assert.equal(resolved.systemPrompt, "Untrusted project prompt");
  assert.deepEqual(resolved.tools, ["read", "bash"]);

  const authoredProject = path.join(workspaces, "authored");
  fs.mkdirSync(authoredProject);
  const authored = await createCustomAgent(authoredProject, SHARED_ACCOUNT_UID, {
    name: "author",
    description: "Created by the current operator",
    scope: "project",
    systemPrompt: "Operator-authored prompt",
    allSkills: true,
  });
  assert.equal(authored.id, "project:author");
  assert.deepEqual(getProjectTrustStatus(authoredProject, agentDir), {
    requiresTrust: true,
    trusted: true,
  });

  const mainOnly = await createCustomAgent(authoredProject, SHARED_ACCOUNT_UID, {
    name: "ifcn",
    description: "Circuit design main agent",
    scope: "project",
    systemPrompt: "Own the circuit design session and call iFCN tools directly.",
    tools: ["read", "ifcn_run"],
    allSkills: true,
    subagentEnabled: false,
  });
  assert.equal(mainOnly.subagentEnabled, false);
  assert.equal(
    (await listCustomAgents(authoredProject, SHARED_ACCOUNT_UID))
      .find((agent) => agent.id === "project:ifcn")?.subagentEnabled,
    false,
  );

  // Simulate an older editor that edits the prompt without knowing this flag.
  const edited = { ...mainOnly, systemPrompt: "Updated main-session instructions." };
  delete edited.subagentEnabled;
  const updatedMain = await updateCustomAgent(
    authoredProject, SHARED_ACCOUNT_UID, mainOnly, edited,
  );
  assert.equal(updatedMain.subagentEnabled, false);
  assert.match(fs.readFileSync(updatedMain.filePath, "utf8"), /^enabled: false$/m);
  const mainRuntime = await resolveCustomAgentRuntimeConfig(
    authoredProject, SHARED_ACCOUNT_UID, "project:ifcn",
  );
  assert.equal(mainRuntime.systemPrompt, edited.systemPrompt);
  assert.deepEqual(mainRuntime.tools, ["read", "ifcn_run"]);

  await t.test("native subagent discovery excludes the main-only profile", {
    skip: !fs.existsSync(path.join(nativeSubagentsDir, "custom-agents.js"))
      && "Optional pi-subagents package is not installed",
  }, async () => {
    // Extensions use the host SDK; the optional package need not install its peer.
    const nativeJiti = createJiti(import.meta.url, {
      alias: { "@earendil-works/pi-coding-agent": jiti.resolve("@earendil-works/pi-coding-agent") },
    });
    const { loadCustomAgents } = await nativeJiti.import(path.join(nativeSubagentsDir, "custom-agents.js"));
    const { registerAgents, getAvailableTypes, isValidType } = await nativeJiti.import(
      path.join(nativeSubagentsDir, "agent-types.js"),
    );
    registerAgents(loadCustomAgents(authoredProject));
    assert.equal(isValidType("ifcn"), false);
    assert.equal(getAvailableTypes().includes("ifcn"), false);
    assert.equal(isValidType("author"), true);
  });

  const outside = path.join(root, "outside");
  const linkedProject = path.join(workspaces, "linked");
  fs.mkdirSync(path.join(outside, "agents"), { recursive: true });
  fs.mkdirSync(linkedProject);
  fs.symlinkSync(outside, path.join(linkedProject, ".pi"), process.platform === "win32" ? "junction" : "dir");
  trustProject(linkedProject, agentDir);
  await assert.rejects(
    createCustomAgent(linkedProject, SHARED_ACCOUNT_UID, {
      name: "escape",
      description: "Must not be written outside",
      scope: "project",
      systemPrompt: "unsafe",
      allSkills: true,
    }),
    /symbolic links/,
  );
  assert.equal(fs.existsSync(path.join(outside, "agents", "escape.md")), false);
});

test("new-session route resolves Agent profiles on the server", () => {
  const source = fs.readFileSync(
    new URL("../app/api/agent/new/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /resolveNewSessionAgentConfig\(cwd, accountUid, requestedAgentConfig\)/);
  assert.match(source, /const effectiveToolNames = agentConfig\?\.tools \?\? toolNames/);
  assert.doesNotMatch(source, /requestedAgentConfig\s*\?\s*\{\s*agentConfig:\s*requestedAgentConfig/);
});
