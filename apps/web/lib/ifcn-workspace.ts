import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { listCustomAgents } from "./custom-agent-files";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { getProjectTrustStatus } from "./project-trust";

export const IFCN_AGENT_ID = "project:ifcn" as const;
const IFCN_TOOLS = ["ifcn_capabilities", "ifcn_run", "ifcn_status", "ifcn_artifact"];

export interface IfcnCapabilities {
  schema: string;
  ready: boolean;
  stages: string[];
  algorithms: { id: string; available: boolean; clock_scheme?: string; description?: string }[];
  combinational?: { supported: boolean; input?: string };
  sequential?: { supported: boolean; status?: string };
  [key: string]: unknown;
}

export interface IfcnWorkspace {
  configured: boolean;
  cwd: string | null;
  agentId: typeof IFCN_AGENT_ID;
  available: boolean;
  message?: string;
  requiresTrust?: boolean;
  trusted?: boolean;
  capabilities?: IfcnCapabilities;
}

interface WorkspaceConfiguration {
  configured: boolean;
  cwd: string | null;
  valid: boolean;
  message?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveConfiguredRoot(value: string, webRoot: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/")
    ? path.join(homedir(), value.slice(2)) : value;
  return path.resolve(webRoot, expanded);
}

function requireProjectFile(cwd: string, relativePath: string): string {
  const filename = path.join(cwd, relativePath);
  let current = cwd;
  for (const segment of relativePath.split(path.sep)) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`iFCN 配置不能通过符号链接加载：${relativePath}`);
  }
  if (!statSync(filename).isFile()) throw new Error(`iFCN 缺少文件：${relativePath}`);
  return filename;
}

/** Resolve the installed adapter, never a machine-specific repository path. */
export function readIfcnWorkspaceConfiguration(options: {
  webRoot?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): WorkspaceConfiguration {
  const webRoot = options.webRoot ?? process.cwd();
  const environment = options.environment ?? process.env;
  const configurationFile = [webRoot, path.dirname(webRoot)]
    .map((directory) => path.join(directory, ".pi", "extensions", "ifcn", "ifcn-config.json"))
    .find((filename) => existsSync(filename));
  const override = environment.IFCN_ROOT?.trim();
  const bundledEngine = path.resolve(webRoot, "..", "..", "engine");
  const hasBundledEngine = existsSync(path.join(bundledEngine, "scripts", "ifcn_agent.py"));
  if (!override && !configurationFile && !hasBundledEngine) {
    return { configured: false, cwd: null, valid: false };
  }

  let cwd: string | null = null;
  try {
    const configured = override || (configurationFile
      ? JSON.parse(readFileSync(configurationFile, "utf8")).root : bundledEngine);
    if (typeof configured !== "string" || !configured.trim()) throw new Error("iFCN 配置缺少有效的 root");
    const base = !override && configurationFile ? path.dirname(configurationFile) : webRoot;
    cwd = realpathSync(resolveConfiguredRoot(configured.trim(), base));
    if (!statSync(cwd).isDirectory()) throw new Error("iFCN root 不是工程目录");
    requireProjectFile(cwd, path.join("scripts", "ifcn_agent.py"));
    const extensionDirectory = path.join(".pi", "extensions", "ifcn");
    requireProjectFile(cwd, path.join(extensionDirectory, "index.ts"));
    // The extension and web workspace must address the same engine. IFCN_ROOT
    // overrides both; without it the extension needs its own installed config.
    if (!override) {
      const extensionConfigurationFile = requireProjectFile(cwd, path.join(extensionDirectory, "ifcn-config.json"));
      const extensionConfiguration = JSON.parse(readFileSync(extensionConfigurationFile, "utf8"));
      if (typeof extensionConfiguration.root !== "string"
        || realpathSync(resolveConfiguredRoot(extensionConfiguration.root, path.dirname(extensionConfigurationFile))) !== cwd) {
        throw new Error("iFCN 扩展配置与 Web 工程目录不一致");
      }
    }
    const source = readFileSync(requireProjectFile(cwd, path.join(".pi", "agents", "ifcn.md")), "utf8");
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(source);
    const tools = Array.isArray(frontmatter.tools) ? frontmatter.tools.map(String)
      : String(frontmatter.tools ?? "").split(",").map((tool) => tool.trim());
    if (frontmatter.name !== "ifcn" || !frontmatter.description || !body.trim()
      || !IFCN_TOOLS.every((tool) => tools.includes(tool))) {
      throw new Error("iFCN 主智能体配置无效或缺少流程工具");
    }
    return { configured: true, cwd, valid: true };
  } catch (error) {
    return { configured: true, cwd, valid: false, message: errorMessage(error) };
  }
}

/** This is the same local capability command as ifcn_capabilities, without an LLM call. */
export function probeIfcnCapabilities(cwd: string, timeoutMs = 5_000): Promise<IfcnCapabilities> {
  return new Promise((resolve, reject) => {
    execFile("python3", [path.join(cwd, "scripts", "ifcn_agent.py"), "doctor"], {
      cwd,
      env: { ...process.env, IFCN_ROOT: cwd },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.killed ? "iFCN 能力检查超时" : `iFCN 能力检查失败：${stderr.trim() || error.message}`));
        return;
      }
      try {
        const value = JSON.parse(stdout) as IfcnCapabilities;
        if (value.schema !== "ifcn.pi.capabilities.v1" || typeof value.ready !== "boolean"
          || !Array.isArray(value.stages) || !Array.isArray(value.algorithms)) {
          throw new Error("iFCN 能力检查返回了无法识别的结果");
        }
        resolve(value);
      } catch (parseError) {
        reject(new Error(`iFCN 能力检查响应无效：${errorMessage(parseError)}`));
      }
    });
  });
}

export async function getIfcnWorkspace(accountUid: string): Promise<IfcnWorkspace> {
  const configuration = readIfcnWorkspaceConfiguration();
  const workspace: IfcnWorkspace = {
    configured: configuration.configured,
    cwd: configuration.cwd,
    agentId: IFCN_AGENT_ID,
    available: false,
    ...(configuration.message ? { message: configuration.message } : {}),
  };
  if (!configuration.valid || !configuration.cwd) return workspace;
  const cwd = configuration.cwd;
  // This server-installed workspace uses the same account-scoped authorization
  // as selecting a directory, including private workspace/credential exclusions.
  allowFileRoot(accountUid, cwd);
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots(accountUid, cwd))) {
    return { ...workspace, cwd: null, message: "当前账户无权访问配置的 iFCN 工程" };
  }
  const trust = getProjectTrustStatus(cwd, getAgentDir());
  Object.assign(workspace, trust);
  if (!trust.trusted) return { ...workspace, message: "进入工程后，请通过现有项目确认启用 iFCN 智能体与工具" };
  try {
    const agents = await listCustomAgents(cwd, accountUid);
    if (!agents.some((agent) => agent.id === IFCN_AGENT_ID)) {
      return { ...workspace, message: "iFCN 主智能体未能加载，请检查工程的智能体配置" };
    }
    const capabilities = await probeIfcnCapabilities(cwd);
    const available = capabilities.ready && capabilities.combinational?.supported === true
      && capabilities.algorithms.some((algorithm) => algorithm.available === true);
    return { ...workspace, capabilities, available,
      ...(!available ? { message: "iFCN 环境检查未通过，请检查返回的能力与依赖状态" } : {}),
    };
  } catch (error) {
    return { ...workspace, message: errorMessage(error) };
  }
}

export function isIfcnWorkspace(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const configuration = readIfcnWorkspaceConfiguration();
  if (!configuration.valid || !configuration.cwd) return false;
  try {
    return realpathSync(cwd) === configuration.cwd;
  } catch {
    return false;
  }
}
