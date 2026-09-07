import fs from "node:fs";
import path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type SubagentScope = "builtin" | "global" | "project";

/**
 * Safe, UI-facing subset of a pi-subagents agent definition. System prompts
 * and source paths intentionally stay on the server.
 */
export interface SubagentOption {
  id: string;
  name: string;
  displayName: string;
  description: string;
  scope: SubagentScope;
  model?: string;
}

export interface SubagentDiscovery {
  subagents: SubagentOption[];
  extensionAvailable: boolean;
  packageVersion?: string;
}

interface DiscoveredAgent extends SubagentOption {
  enabled: boolean;
}

interface PackageSettings {
  packages?: unknown;
}

type ConfiguredPackage = string | {
  source?: unknown;
  extensions?: unknown;
};

const PACKAGE_NAME = "@tintinweb/pi-subagents";
const PACKAGE_SOURCE_PREFIX = `npm:${PACKAGE_NAME}`;

const BUILTIN_AGENTS: readonly DiscoveredAgent[] = [
  {
    id: "builtin:general-purpose",
    name: "general-purpose",
    displayName: "Agent",
    description: "General-purpose agent for research, code search, and multi-step tasks.",
    scope: "builtin",
    enabled: true,
  },
  {
    id: "builtin:Explore",
    name: "Explore",
    displayName: "Explore",
    description: "Fast read-only agent for locating files, symbols, and references.",
    scope: "builtin",
    model: "anthropic/claude-haiku-4-5",
    enabled: true,
  },
  {
    id: "builtin:Plan",
    name: "Plan",
    displayName: "Plan",
    description: "Read-only software architect for implementation plans and trade-off analysis.",
    scope: "builtin",
    enabled: true,
  },
];

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function packageSource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  return typeof (entry as { source?: unknown }).source === "string"
    ? (entry as { source: string }).source
    : undefined;
}

function isConfiguredPackageSource(source: string): boolean {
  return source === PACKAGE_SOURCE_PREFIX || source.startsWith(`${PACKAGE_SOURCE_PREFIX}@`);
}

function settingsPackages(filePath: string): unknown[] | undefined {
  const settings = readJsonObject(filePath) as PackageSettings;
  return Array.isArray(settings.packages) ? settings.packages : undefined;
}

function configuredPackage(packages: unknown[] | undefined): ConfiguredPackage | undefined {
  return packages?.find((entry) => {
    const source = packageSource(entry);
    return source ? isConfiguredPackageSource(source) : false;
  }) as ConfiguredPackage | undefined;
}

function normalizeResourcePattern(value: string): string {
  return value.replace(/^\.\//, "").replaceAll("\\", "/");
}

function packageExtensionIsEnabled(entry: ConfiguredPackage): boolean {
  if (typeof entry === "string" || !Array.isArray(entry.extensions)) return true;
  const patterns = entry.extensions.filter((value): value is string => typeof value === "string");
  if (patterns.length === 0) return false;

  const resource = "src/index.ts";
  const includes = patterns.filter((pattern) => !/^[+!-]/.test(pattern));
  const excludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const forceIncludes = patterns.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
  const forceExcludes = patterns.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));
  const matches = (pattern: string) => path.matchesGlob(resource, normalizeResourcePattern(pattern));
  const exact = (pattern: string) => normalizeResourcePattern(pattern) === resource;

  let enabled = includes.length === 0 || includes.some(matches);
  if (excludes.some(matches)) enabled = false;
  if (forceIncludes.some(exact)) enabled = true;
  if (forceExcludes.some(exact)) enabled = false;
  return enabled;
}

function installedPackageManifest(cwd: string, scope: "project" | "global", agentDir: string): { path: string; version?: string } | undefined {
  const relativeManifest = path.join("npm", "node_modules", "@tintinweb", "pi-subagents", "package.json");
  const candidates = scope === "project"
    ? [path.join(cwd, ".pi", relativeManifest)]
    : [path.join(agentDir, relativeManifest)];
  for (const manifestPath of candidates) {
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJsonObject(manifestPath);
    if (manifest.name !== PACKAGE_NAME) continue;
    return {
      path: manifestPath,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    };
  }
  return undefined;
}

function installationStatus(cwd: string, agentDir: string): Pick<SubagentDiscovery, "extensionAvailable" | "packageVersion"> {
  const globalPackages = settingsPackages(path.join(agentDir, "settings.json"));
  const projectPackages = settingsPackages(path.join(cwd, ".pi", "settings.json"));
  // Pi loads both scopes, but a project entry with the same package identity
  // overrides the global entry and its resource filters.
  const projectEntry = configuredPackage(projectPackages);
  const globalEntry = configuredPackage(globalPackages);
  const configured = projectEntry ?? globalEntry;
  const manifest = installedPackageManifest(cwd, projectEntry ? "project" : "global", agentDir);
  return {
    extensionAvailable: configured !== undefined
      && packageExtensionIsEnabled(configured)
      && manifest !== undefined,
    packageVersion: manifest?.version,
  };
}

function defaultsAreDisabled(cwd: string, agentDir: string): boolean {
  const globalSettings = readJsonObject(path.join(agentDir, "subagents.json"));
  const projectSettings = readJsonObject(path.join(cwd, ".pi", "subagents.json"));
  const globalValue = typeof globalSettings.disableDefaultAgents === "boolean"
    ? globalSettings.disableDefaultAgents
    : undefined;
  const projectValue = typeof projectSettings.disableDefaultAgents === "boolean"
    ? projectSettings.disableDefaultAgents
    : undefined;
  return projectValue ?? globalValue ?? false;
}

function optionalFrontmatterString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function loadAgentDirectory(
  directory: string,
  scope: Exclude<SubagentScope, "builtin">,
  agents: Map<string, DiscoveredAgent>,
): void {
  let entries: fs.Dirent[];
  try {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = path.basename(entry.name, ".md");
    if (!name) continue;
    try {
      const source = fs.readFileSync(path.join(directory, entry.name), "utf8");
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(source);
      agents.set(name, {
        id: `${scope}:${name}`,
        name,
        displayName: optionalFrontmatterString(frontmatter.display_name) ?? name,
        description: optionalFrontmatterString(frontmatter.description) ?? name,
        scope,
        model: optionalFrontmatterString(frontmatter.model),
        enabled: frontmatter.enabled !== false,
      });
    } catch {
      // Match pi-subagents' tolerant discovery behavior: one unreadable or
      // malformed definition must not hide the rest of the registry.
    }
  }
}

/**
 * Discover the same registry used by @tintinweb/pi-subagents. Overlay order is
 * global -> .agents/agents -> .pi/agents, with custom definitions overriding
 * built-ins by name. A disabled custom definition remains a tombstone so it
 * can also disable a built-in with the same name.
 */
export function discoverSubagents(cwd: string, agentDir = getAgentDir()): SubagentDiscovery {
  const installation = installationStatus(cwd, agentDir);
  const agents = new Map<string, DiscoveredAgent>();

  if (!defaultsAreDisabled(cwd, agentDir)) {
    for (const agent of BUILTIN_AGENTS) agents.set(agent.name, { ...agent });
  }

  loadAgentDirectory(path.join(agentDir, "agents"), "global", agents);
  loadAgentDirectory(path.join(cwd, ".agents", "agents"), "project", agents);
  loadAgentDirectory(path.join(cwd, ".pi", "agents"), "project", agents);

  const subagents = [...agents.values()]
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      scope: agent.scope,
      ...(agent.model ? { model: agent.model } : {}),
    }));

  return { subagents, ...installation };
}
