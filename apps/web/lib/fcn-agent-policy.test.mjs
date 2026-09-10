import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FCN_TOOL_NAMES, isFcnToolSelection, isFcnSessionCommand, fcnResourceLoaderOptions } =
  await jiti.import("./fcn-agent-policy.ts");

test("FCN tool and command policy rejects shell, delegation, and tool escalation", () => {
  assert.equal(isFcnToolSelection([...FCN_TOOL_NAMES]), true);
  assert.equal(isFcnToolSelection([...FCN_TOOL_NAMES].reverse()), true);
  for (const tools of [[], ["bash"], [...FCN_TOOL_NAMES, "bash"], [...FCN_TOOL_NAMES, "Agent"],
    [...FCN_TOOL_NAMES.slice(1), "mcp_private_tool"], [...FCN_TOOL_NAMES, FCN_TOOL_NAMES[0]]]) {
    assert.equal(isFcnToolSelection(tools), false);
  }
  for (const command of ["prompt", "abort", "steer", "reload", "get_state", "get_tools", "set_model", "compact"]) {
    assert.equal(isFcnSessionCommand(command), true);
  }
  for (const command of ["bash", "abort_bash", "get_commands", "install", "Agent", "", null]) {
    assert.equal(isFcnSessionCommand(command), false);
  }
});

test("SDK loads only the explicit FCN extension and excludes ambient extensions, skills, and prompts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fcn-resource-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "engine");
  const agentDir = path.join(root, "agent");
  for (const directory of [path.join(cwd, ".pi", "extensions", "ifcn"), path.join(agentDir, "extensions"),
    path.join(agentDir, "skills", "unrelated"), path.join(agentDir, "prompts")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const marker = path.join(root, "unrelated-extension-executed");
  fs.writeFileSync(path.join(agentDir, "extensions", "unrelated.js"),
    `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  fs.writeFileSync(path.join(cwd, ".pi", "extensions", "unrelated.js"),
    `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  fs.writeFileSync(path.join(agentDir, "skills", "unrelated", "SKILL.md"), "---\nname: unrelated\ndescription: generic skill\n---\nDo other work.\n");
  fs.writeFileSync(path.join(agentDir, "prompts", "unrelated.md"), "Generic prompt\n");
  const extension = path.join(cwd, ".pi", "extensions", "ifcn", "index.js");
  fs.writeFileSync(extension, "export default (pi) => { pi.registerTool({name:'ifcn_run', label:'FCN', description:'Circuit workflow', parameters:{type:'object',properties:{}}, execute:async()=>({content:[]})}); };\n");
  const loader = new DefaultResourceLoader({ cwd, agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [] }, { projectTrusted: true }),
    ...fcnResourceLoaderOptions(extension, "Design FCN circuits"),
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(loader.getExtensions().errors.length, 0);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.equal(loader.getExtensions().extensions[0].tools.has("ifcn_run"), true);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.equal(loader.getSystemPrompt(), "Design FCN circuits");
});

test("retired management endpoints are deleted and the main client no longer fetches them", () => {
  const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const retired = ["plugins", "skills", "mcp/tools", "subagents", "agent-suite", "agent-versions",
    "terminals", "worktrees", "app-update", "git", "feedback"];
  for (const route of retired) {
    assert.equal(fs.existsSync(path.join(web, "app", "api", route, "route.ts")), false, route);
  }
  for (const name of ["hooks/useAgentSession.ts", "components/ChatInput.tsx", "components/ChatWindow.tsx", "components/AppShell.tsx"]) {
    const source = fs.readFileSync(path.join(web, name), "utf8");
    for (const route of retired) assert.equal(source.includes(`/api/${route}`), false, `${name}: ${route}`);
  }
  const agents = fs.readFileSync(path.join(web, "app/api/agents/route.ts"), "utf8");
  assert.match(agents, /export async function GET/);
  assert.doesNotMatch(agents, /export async function (POST|PUT|DELETE)/);
});
