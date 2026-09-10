import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const UID = "00000000-0000-4000-8000-000000000000";
const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

test("Agent identity survives reload and forks, while current trust and policy remain authoritative", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-session-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspaces", "circuit");
  const sessionDir = path.join(root, "sessions");
  const profileDir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const env = {
    IFCN_ROOT: cwd,
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEB_CONFIG_DIR: path.join(root, "web-config"),
    PI_WEB_SHARED_ROOTS: path.join(root, "workspaces"),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  fs.mkdirSync(path.join(cwd, "scripts"));
  fs.writeFileSync(path.join(cwd, "scripts", "ifcn_agent.py"), "# must not run when reading profile\n");
  fs.mkdirSync(path.join(cwd, ".pi", "extensions", "ifcn"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "extensions", "ifcn", "index.ts"), "export default function () {}\n");
  const profilePath = path.join(profileDir, "ifcn.md");
  function writeProfile(prompt, tools = "read, write, edit, ifcn_capabilities, ifcn_run, ifcn_status, ifcn_artifact") {
    fs.writeFileSync(profilePath, `---\nname: ifcn\ndescription: Circuit design\ntools: "${tools}"\nskills: ""\n---\n\n${prompt}\n`);
  }
  writeProfile("Original circuit policy");
  const trust = new ProjectTrustStore(agentDir);
  trust.set(cwd, true);
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const {
    initializeSessionAgentProfile,
    getSessionAgentProfileId,
    readSessionAgentProfileId,
    persistUnflushedSession,
    forkSessionBeforeEntry,
  } = await jiti.import("./session-agent-profile.ts");

  const fresh = SessionManager.create(cwd, sessionDir);
  const selected = await initializeSessionAgentProfile(fresh, UID, "project:ifcn");
  assert.equal(selected.systemPrompt, "Original circuit policy");
  assert.deepEqual(selected.tools, ["read", "write", "edit", "ifcn_capabilities", "ifcn_run", "ifcn_status", "ifcn_artifact"]);
  assert.deepEqual(selected.skills, []);
  persistUnflushedSession(fresh);
  const file = fresh.getSessionFile();
  const initialText = fs.readFileSync(file, "utf8");
  assert.ok(initialText.includes('"agentId":"project:ifcn"'));
  assert.ok(!initialText.includes("Original circuit policy"));
  const initialMtime = fs.statSync(file).mtimeMs;
  assert.equal(readSessionAgentProfileId(file), "project:ifcn");
  assert.equal(fs.statSync(file).mtimeMs, initialMtime);
  assert.equal(fs.readFileSync(file, "utf8"), initialText);
  assert.equal(fresh.getEntries().filter((entry) => entry.type === "message").length, 0);

  // Restart before any model response must retain the same session id/profile.
  const reopened = SessionManager.open(file, sessionDir);
  assert.equal(reopened.getSessionId(), fresh.getSessionId());
  writeProfile("Updated circuit policy");
  const restored = await initializeSessionAgentProfile(reopened, UID);
  assert.equal(restored.systemPrompt, "Updated circuit policy");
  assert.deepEqual(restored.tools, ["read", "write", "edit", "ifcn_capabilities", "ifcn_run", "ifcn_status", "ifcn_artifact"]);
  assert.equal(reopened.getEntries().length, 1);
  await assert.rejects(initializeSessionAgentProfile(reopened, UID, "global:other"), /cannot be changed/);

  const first = reopened.appendMessage(userMessage("first task"));
  const second = reopened.appendMessage(userMessage("second task"));
  const emptyFork = forkSessionBeforeEntry(reopened, first);
  const emptyReload = SessionManager.open(emptyFork.getSessionFile(), sessionDir);
  assert.equal(emptyReload.getSessionId(), emptyFork.getSessionId());
  assert.equal(emptyReload.getHeader().parentSession, file);
  assert.equal(emptyReload.getEntries().filter((entry) => entry.type === "message").length, 0);
  assert.equal((await initializeSessionAgentProfile(emptyReload, UID)).id, "project:ifcn");
  const historicalFork = forkSessionBeforeEntry(reopened, second);
  assert.equal(getSessionAgentProfileId(historicalFork), "project:ifcn");
  assert.deepEqual(historicalFork.getEntries().filter((entry) => entry.type === "message").map((entry) => entry.message.content[0].text), ["first task"]);
  assert.equal(getSessionAgentProfileId(SessionManager.open(file, sessionDir)), "project:ifcn");

  // A stale binding cannot bypass a later trust revocation or missing definition.
  trust.set(cwd, false);
  assert.equal(readSessionAgentProfileId(file), "project:ifcn");
  await assert.rejects(initializeSessionAgentProfile(SessionManager.open(file, sessionDir), UID), /must be trusted/);
  trust.set(cwd, true);
  fs.unlinkSync(profilePath);
  await assert.rejects(initializeSessionAgentProfile(SessionManager.open(file, sessionDir), UID), { status: 409 });
  writeProfile("Restored policy");

  const legacy = SessionManager.create(cwd, sessionDir);
  const legacyFirst = legacy.appendMessage(userMessage("ordinary session"));
  persistUnflushedSession(legacy);
  const legacyReload = SessionManager.open(legacy.getSessionFile(), sessionDir);
  assert.equal((await initializeSessionAgentProfile(legacyReload, UID)).id, "project:ifcn");
  assert.equal(readSessionAgentProfileId(legacy.getSessionFile()), "project:ifcn");
  assert.equal(getSessionAgentProfileId(forkSessionBeforeEntry(legacyReload, legacyFirst)), "project:ifcn");
  assert.equal(legacyReload.getEntries().length, 2);

  const corrupt = SessionManager.create(cwd, sessionDir);
  corrupt.appendCustomEntry("pi-web-agent-profile", { version: 1, agentId: "project:../../escape" });
  await assert.rejects(initializeSessionAgentProfile(corrupt, UID), /binding is invalid/);
});
