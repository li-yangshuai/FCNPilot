import { createHash, randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getPiWebConfigDir } from "./pi-web-paths";
import { projectConfigDirectories } from "./project-config-dirs";
import { getProjectTrustStatus } from "./project-trust";

export type McpServerConfig = {
  url: string;
  directTools?: boolean;
  lifecycle?: "keep-alive" | "per-request" | string;
  idleTimeout?: number;
  toolTimeoutMs?: number;
  connectTimeoutMs?: number;
  headers?: Record<string, string>;
  enabled?: boolean;
};

export type McpServerEntry = {
  name: string;
  config: McpServerConfig;
  source: "global" | "project";
  settingsPath: string;
};

type RawSettings = {
  mcpServers?: Record<string, McpServerConfig | false | null | undefined>;
  [key: string]: unknown;
};

export type McpConfigScope = "global" | "project";

function readSettings(filePath: string): RawSettings {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as RawSettings;
}

function writeSettings(filePath: string, settings: RawSettings): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function projectDirectoryKey(cwd: string): string {
  return createHash("sha256").update(path.resolve(cwd), "utf8").digest("hex").slice(0, 20);
}

function sharedMcpRoot(): string {
  return path.join(getPiWebConfigDir(), "MCP");
}

function sharedProjectMcpDirectory(cwd: string): string {
  return path.join(sharedMcpRoot(), "projects", projectDirectoryKey(cwd));
}

function mcpDirectoryForScope(cwd: string, scope: McpConfigScope): string {
  return scope === "global"
    ? path.join(sharedMcpRoot(), "global")
    : sharedProjectMcpDirectory(cwd);
}

function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function normalizeMcpServerName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("MCP name must use 1-80 letters, numbers, dots, underscores, or hyphens");
  }
  return name;
}

export function normalizeMcpServerConfig(value: McpServerConfig): McpServerConfig {
  let url: URL;
  try {
    url = new URL(value.url.trim());
  } catch {
    throw new Error("MCP URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP URL must use http or https");
  }
  const headers = value.headers === undefined
    ? undefined
    : Object.fromEntries(Object.entries(value.headers).map(([key, headerValue]) => {
      const normalizedKey = key.trim();
      if (!normalizedKey || typeof headerValue !== "string" || /[\r\n]/.test(normalizedKey + headerValue)) {
        throw new Error("MCP headers must contain valid string names and values");
      }
      return [normalizedKey, headerValue];
    }));
  return {
    url: url.toString(),
    ...(value.directTools !== undefined ? { directTools: value.directTools } : {}),
    ...(value.lifecycle ? { lifecycle: value.lifecycle } : {}),
    ...(value.idleTimeout !== undefined ? { idleTimeout: value.idleTimeout } : {}),
    ...(value.toolTimeoutMs !== undefined ? { toolTimeoutMs: value.toolTimeoutMs } : {}),
    ...(value.connectTimeoutMs !== undefined ? { connectTimeoutMs: value.connectTimeoutMs } : {}),
    ...(headers && Object.keys(headers).length ? { headers } : {}),
  };
}

export function upsertMcpServer(
  cwd: string,
  agentDir: string,
  accountUid: string,
  scope: McpConfigScope,
  rawName: string,
  rawConfig: McpServerConfig,
): McpServerEntry {
  const name = normalizeMcpServerName(rawName);
  const config = normalizeMcpServerConfig(rawConfig);
  migrateLegacyMcpConfigs(
    cwd,
    agentDir,
    accountUid,
    getProjectTrustStatus(cwd, getAgentDir()).trusted,
  );
  const settingsPath = path.join(mcpDirectoryForScope(cwd, scope), `${name}.json`);
  writeSettings(settingsPath, { name, ...config });
  return { name, config, source: scope, settingsPath };
}

export function removeMcpServer(
  cwd: string,
  agentDir: string,
  accountUid: string,
  rawName: string,
  source: McpConfigScope,
): boolean {
  const name = normalizeMcpServerName(rawName);
  const entry = loadMcpServers(cwd, agentDir, accountUid).find((server) => (
    server.name === name && server.source === source
  ));
  if (!entry) return false;

  // Account-scoped MCP definitions are stored as one JSON file per server in
  // MCP/global or MCP/projects/<workspace-key>. The former check only accepted
  // files whose immediate parent was literally named "MCP", so every config
  // written by upsertMcpServer() was mistakenly handled as legacy settings.json.
  if (path.extname(entry.settingsPath).toLowerCase() === ".json"
    && isPathInsideDirectory(sharedMcpRoot(), entry.settingsPath)) {
    unlinkSync(entry.settingsPath);
    return true;
  }
  // Legacy compatibility: MCP entries formerly lived inside .pi/settings.json.
  const settings = readSettings(entry.settingsPath);
  if (!settings.mcpServers || !Object.prototype.hasOwnProperty.call(settings.mcpServers, name)) return false;
  const nextServers = { ...settings.mcpServers };
  delete nextServers[name];
  writeSettings(entry.settingsPath, {
    ...settings,
    ...(Object.keys(nextServers).length ? { mcpServers: nextServers } : { mcpServers: {} }),
  });
  return true;
}

function isValidServerConfig(value: unknown): value is McpServerConfig {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as McpServerConfig).url === "string"
    && (value as McpServerConfig).url.trim().length > 0;
}

function collectServers(
  settings: RawSettings,
  source: McpServerEntry["source"],
  settingsPath: string,
  out: Map<string, McpServerEntry>,
): void {
  if (!settings.mcpServers || typeof settings.mcpServers !== "object") return;
  for (const [name, config] of Object.entries(settings.mcpServers)) {
    if (config === false || config === null) {
      out.delete(name);
      continue;
    }
    if (!isValidServerConfig(config)) continue;
    if (config.enabled === false) {
      out.delete(name);
      continue;
    }
    out.set(name, { name, config: { ...config, url: config.url.trim() }, source, settingsPath });
  }
}

function collectServerFiles(
  directory: string,
  source: McpServerEntry["source"],
  out: Map<string, McpServerEntry>,
): void {
  if (!existsSync(directory)) return;
  for (const fileName of readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".json")).sort()) {
    const settingsPath = path.join(directory, fileName);
    try {
      const raw = readSettings(settingsPath);
      const rawName = typeof raw.name === "string" ? raw.name : path.basename(fileName, path.extname(fileName));
      const name = normalizeMcpServerName(rawName);
      if (raw.enabled === false) {
        out.delete(name);
        continue;
      }
      if (!isValidServerConfig(raw)) continue;
      const config = normalizeMcpServerConfig(raw);
      out.set(name, { name, config, source, settingsPath });
    } catch {
      // One malformed MCP file must not hide the remaining valid servers.
    }
  }
}

function writeMigrationMarker(markerPath: string): void {
  mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  writeFileSync(markerPath, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
}

function existingAccountMcpRoots(): string[] {
  const usersDirectory = path.join(getPiWebConfigDir(), "users");
  if (!existsSync(usersDirectory)) return [];
  return readdirSync(usersDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(usersDirectory, entry.name, "MCP"));
}

function importLegacyServers(
  destination: string,
  collect: (servers: Map<string, McpServerEntry>) => void,
): void {
  const servers = new Map<string, McpServerEntry>();
  collect(servers);
  for (const server of servers.values()) {
    const target = path.join(destination, `${server.name}.json`);
    if (!existsSync(target)) writeSettings(target, { name: server.name, ...server.config });
  }
}

/**
 * Consolidate former account-scoped and legacy MCP definitions into the shared
 * Pi Web store. Definitions are global; only each account's enabled selection
 * remains in account preferences.
 */
function migrateLegacyMcpConfigs(
  cwd: string,
  agentDir: string,
  _accountUid: string,
  projectTrusted: boolean,
): void {
  void _accountUid;
  const root = sharedMcpRoot();
  const globalMarker = path.join(root, ".shared-global-v1");
  if (!existsSync(globalMarker)) {
    importLegacyServers(path.join(root, "global"), (servers) => {
      const legacySettings = path.join(agentDir, "settings.json");
      if (existsSync(legacySettings)) collectServers(readSettings(legacySettings), "global", legacySettings, servers);
      collectServerFiles(path.join(agentDir, "MCP"), "global", servers);
      for (const accountRoot of existingAccountMcpRoots()) {
        collectServerFiles(path.join(accountRoot, "global"), "global", servers);
      }
    });
    writeMigrationMarker(globalMarker);
  }

  if (!projectTrusted) return;

  for (const projectDir of projectConfigDirectories(cwd)) {
    const legacySettings = path.join(projectDir, ".pi", "settings.json");
    const legacyDirectory = path.join(projectDir, ".pi", "MCP");
    const accountProjectDirectories = existingAccountMcpRoots()
      .map((accountRoot) => path.join(accountRoot, "projects", projectDirectoryKey(projectDir)));
    if (!existsSync(legacySettings)
      && !existsSync(legacyDirectory)
      && !accountProjectDirectories.some((directory) => existsSync(directory))) continue;
    const destination = sharedProjectMcpDirectory(projectDir);
    const marker = path.join(destination, ".shared-project-v1");
    if (existsSync(marker)) continue;
    importLegacyServers(destination, (servers) => {
      if (existsSync(legacySettings)) collectServers(readSettings(legacySettings), "project", legacySettings, servers);
      collectServerFiles(legacyDirectory, "project", servers);
      for (const accountProjectDirectory of accountProjectDirectories) {
        collectServerFiles(accountProjectDirectory, "project", servers);
      }
    });
    writeMigrationMarker(marker);
  }
}

export function getMcpSettingsPaths(cwd: string, agentDir: string, accountUid: string): {
  global: string;
  projects: string[];
  mcpDirectories: { global: string; projects: string[] };
} {
  const projectTrusted = getProjectTrustStatus(cwd, getAgentDir()).trusted;
  migrateLegacyMcpConfigs(cwd, agentDir, accountUid, projectTrusted);
  const projects = projectTrusted
    ? projectConfigDirectories(cwd).map((directory) => sharedProjectMcpDirectory(directory))
    : [];
  return {
    global: path.join(sharedMcpRoot(), "global"),
    projects,
    mcpDirectories: {
      global: path.join(sharedMcpRoot(), "global"),
      projects,
    },
  };
}

export function loadMcpServers(
  cwd: string,
  agentDir: string,
  accountUid: string,
  enabledNames?: ReadonlySet<string>,
): McpServerEntry[] {
  const paths = getMcpSettingsPaths(cwd, agentDir, accountUid);
  const servers = new Map<string, McpServerEntry>();

  // Account-global definitions are overridden by progressively more specific
  // account/project definitions for the current workspace.
  collectServerFiles(paths.mcpDirectories.global, "global", servers);
  for (const projectDirectory of paths.mcpDirectories.projects) {
    collectServerFiles(projectDirectory, "project", servers);
  }

  const configured = [...servers.values()];
  return enabledNames === undefined
    ? configured
    : configured.filter((server) => enabledNames.has(server.name));
}
