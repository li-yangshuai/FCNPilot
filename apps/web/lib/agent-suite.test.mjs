import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const SHARED_ACCOUNT_UID = "00000000-0000-4000-8000-000000000000";

test("non-default Agent suites stay inactive until their canonical path is trusted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-agent-suite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaultAgentDir = path.join(root, "default-agent");
  const customSuite = path.join(root, "custom-suite");
  const suiteAlias = path.join(root, "suite-alias");
  const webConfigDir = path.join(root, "web-config");
  fs.mkdirSync(defaultAgentDir, { recursive: true });
  fs.mkdirSync(path.join(customSuite, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(customSuite, "extensions", "probe.js"), "export default () => {};\n");
  fs.symlinkSync(customSuite, suiteAlias, process.platform === "win32" ? "junction" : "dir");

  const previousEnvironment = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_WEB_CONFIG_DIR: process.env.PI_WEB_CONFIG_DIR,
  };
  process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
  process.env.PI_WEB_CONFIG_DIR = webConfigDir;
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const jiti = createJiti(import.meta.url);
  const { getActiveAgentDir, inspectAgentSuite, trustAgentSuite } = await jiti.import("./agent-suite.ts");
  const { updateAccountPreferences } = await jiti.import("./account-preferences.ts");

  const inspected = inspectAgentSuite(suiteAlias);
  assert.equal(inspected.path, fs.realpathSync(customSuite));
  assert.equal(inspected.requiresTrust, true);
  assert.equal(inspected.trusted, false);
  assert.equal(inspected.extensions, 1);

  updateAccountPreferences(SHARED_ACCOUNT_UID, { agentSuitePath: inspected.path });
  assert.equal(getActiveAgentDir(SHARED_ACCOUNT_UID), defaultAgentDir);

  const trusted = trustAgentSuite(suiteAlias);
  assert.equal(trusted.path, fs.realpathSync(customSuite));
  assert.equal(trusted.trusted, true);
  assert.equal(getActiveAgentDir(SHARED_ACCOUNT_UID), fs.realpathSync(customSuite));
});

test("Agent suite activation cannot bypass the dedicated trust flow", () => {
  const preferencesRoute = fs.readFileSync(
    new URL("../app/api/accounts/preferences/route.ts", import.meta.url),
    "utf8",
  );
  const suiteRoute = fs.readFileSync(
    new URL("../app/api/agent-suite/route.ts", import.meta.url),
    "utf8",
  );
  const suiteUi = fs.readFileSync(
    new URL("../components/AgentsConfig.tsx", import.meta.url),
    "utf8",
  );

  assert.match(preferencesRoute, /hasOwnProperty\.call\(patch, "agentSuitePath"\)/);
  assert.match(preferencesRoute, /Use \/api\/agent-suite to change the Agent suite/);
  assert.match(suiteRoute, /if \(!suite\.trusted\)/);
  assert.match(suiteRoute, /body\.trust !== true/);
  assert.match(suiteRoute, /trustAgentSuite\(suite\.path\)/);
  assert.match(suiteUi, /Trust Agent Suite\?/);
  assert.match(suiteUi, /trust: true/);
});
