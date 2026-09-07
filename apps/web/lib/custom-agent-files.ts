import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { getActiveAgentDir } from "./agent-suite";
import type { AgentRuntimeConfig, CustomAgent, CustomAgentScope } from "./custom-agents";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "./file-access";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { getProjectTrustStatus, trustProject } from "./project-trust";

export const CUSTOM_AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const MAX_AGENT_FILE_BYTES = 128 * 1024;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_SYSTEM_PROMPT_LENGTH = 50_000;
const MAX_LIST_ITEMS = 100;

export class CustomAgentFileError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CustomAgentFileError";
    this.status = status;
  }
}

type SanitizedAgent = Omit<CustomAgent, "id" | "filePath" | "mtimeMs">;

type AgentLocation = {
  boundary: string;
  directory: string;
  scope: CustomAgentScope;
};

function listValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function optionalShortString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const selected = value.trim();
  return selected && selected.length <= maxLength ? selected : undefined;
}

export function sanitizeCustomAgent(input: Partial<CustomAgent>): SanitizedAgent {
  const name = input.name?.trim().toLowerCase() ?? "";
  if (!CUSTOM_AGENT_NAME_RE.test(name)) {
    throw new CustomAgentFileError("Agent name must use lowercase letters, numbers, hyphens, or underscores");
  }
  const description = input.description?.trim() ?? "";
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new CustomAgentFileError(`Description is required and must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const systemPrompt = input.systemPrompt?.trim() ?? "";
  if (!systemPrompt || systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
    throw new CustomAgentFileError(`System prompt is required and must be at most ${MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()} characters`);
  }
  const scope: CustomAgentScope = input.scope === "project" ? "project" : "global";
  const tools = input.tools
    ? [...new Set(input.tools.map((tool) => tool.trim()).filter((tool) => TOOL_NAME_RE.test(tool)))].slice(0, MAX_LIST_ITEMS)
    : undefined;
  const skills = input.allSkills
    ? undefined
    : [...new Set(input.skills ?? [])]
      .map((skill) => skill.trim())
      .filter((skill) => SKILL_NAME_RE.test(skill))
      .slice(0, MAX_LIST_ITEMS);
  const thinkingLevel = input.thinkingLevel && THINKING_LEVELS.has(input.thinkingLevel)
    ? input.thinkingLevel
    : undefined;
  return {
    name,
    description,
    scope,
    systemPrompt,
    subagentEnabled: typeof input.subagentEnabled === "boolean" ? input.subagentEnabled : undefined,
    provider: optionalShortString(input.provider),
    modelId: optionalShortString(input.modelId),
    tools,
    skills,
    allSkills: skills === undefined,
    thinkingLevel,
  };
}

function serializeCustomAgent(agent: SanitizedAgent): string {
  const quote = (value: string) => JSON.stringify(value);
  const lines = [
    "---",
    `name: ${quote(agent.name)}`,
    `description: ${quote(agent.description)}`,
  ];
  if (agent.subagentEnabled !== undefined) lines.push(`enabled: ${agent.subagentEnabled}`);
  if (agent.provider) lines.push(`provider: ${quote(agent.provider)}`);
  if (agent.modelId) lines.push(`model: ${quote(agent.modelId)}`);
  if (agent.thinkingLevel) lines.push(`thinking-level: ${quote(agent.thinkingLevel)}`);
  if (agent.tools) lines.push(`tools: ${quote(agent.tools.join(", "))}`);
  lines.push(`skills: ${quote(agent.allSkills ? "*" : (agent.skills ?? []).join(", "))}`);
  lines.push("---", "", agent.systemPrompt, "");
  return lines.join("\n");
}

function parseCustomAgentFile(filePath: string, scope: CustomAgentScope): CustomAgent | null {
  try {
    const fileStat = fs.lstatSync(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_AGENT_FILE_BYTES) return null;
    const source = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(source);
    const name = optionalShortString(frontmatter.name, 64) ?? "";
    const description = optionalShortString(frontmatter.description, MAX_DESCRIPTION_LENGTH) ?? "";
    const systemPrompt = body.trim();
    if (!CUSTOM_AGENT_NAME_RE.test(name) || !description || !systemPrompt || systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
      return null;
    }

    const rawSkills = frontmatter.skills;
    const skills = rawSkills === "*" || rawSkills === undefined
      ? undefined
      : (listValue(rawSkills) ?? []).filter((skill) => SKILL_NAME_RE.test(skill)).slice(0, MAX_LIST_ITEMS);
    const tools = listValue(frontmatter.tools)?.filter((tool) => TOOL_NAME_RE.test(tool)).slice(0, MAX_LIST_ITEMS);
    const thinking = optionalShortString(frontmatter["thinking-level"]);
    return {
      id: `${scope}:${name}`,
      name,
      description,
      scope,
      filePath,
      systemPrompt,
      // `enabled` controls pi-subagents discovery, not this main-session registry.
      subagentEnabled: typeof frontmatter.enabled === "boolean" ? frontmatter.enabled : undefined,
      provider: optionalShortString(frontmatter.provider),
      modelId: optionalShortString(frontmatter.model),
      tools,
      skills,
      allSkills: skills === undefined,
      thinkingLevel: thinking && THINKING_LEVELS.has(thinking)
        ? thinking as CustomAgent["thinkingLevel"]
        : undefined,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function isRelativePathInside(relative: string): boolean {
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(boundary: string, target: string): void {
  const relative = path.relative(boundary, target);
  if (!isRelativePathInside(relative)) {
    throw new CustomAgentFileError("Agent definition path is outside its configured root", 403);
  }
  let current = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new CustomAgentFileError("Agent definition paths cannot contain symbolic links", 403);
      }
    } catch (error) {
      if (error instanceof CustomAgentFileError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function nearestExistingAncestor(filePath: string): string {
  let candidate = filePath;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function canonicalBoundary(value: string): string {
  const resolved = path.resolve(value);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function getAgentLocation(cwd: string, accountUid: string, scope: CustomAgentScope): AgentLocation {
  const boundary = scope === "project"
    ? cwd
    : canonicalBoundary(getActiveAgentDir(accountUid));
  const directory = scope === "project"
    ? path.join(boundary, CONFIG_DIR_NAME, "agents")
    : path.join(boundary, "agents");
  return { boundary, directory, scope };
}

function ensureBoundary(location: AgentLocation): AgentLocation {
  if (!fs.existsSync(location.boundary)) {
    if (location.scope === "project") {
      throw new CustomAgentFileError("Project directory does not exist", 404);
    }
    fs.mkdirSync(location.boundary, { recursive: true, mode: 0o700 });
  }
  const boundary = fs.realpathSync(location.boundary);
  return {
    ...location,
    boundary,
    directory: location.scope === "project"
      ? path.join(boundary, CONFIG_DIR_NAME, "agents")
      : path.join(boundary, "agents"),
  };
}

function assertSafeLocation(location: AgentLocation, createDirectory = false): AgentLocation {
  const selected = createDirectory ? ensureBoundary(location) : location;
  const boundaryRoots = new Set([selected.boundary]);
  const definitionRoots = new Set([selected.directory]);
  if (!isPathWithinRoots(selected.directory, boundaryRoots)) {
    throw new CustomAgentFileError("Agent definition directory is outside its configured root", 403);
  }
  if (!isFilePathAllowed(selected.directory, definitionRoots)) {
    throw new CustomAgentFileError("Agent definition directory is not allowed", 403);
  }
  assertNoSymlinkComponents(selected.boundary, selected.directory);

  if (fs.existsSync(selected.directory)) {
    const directoryStat = fs.lstatSync(selected.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new CustomAgentFileError("Agent definition directory must be a regular directory", 403);
    }
    if (!isExistingPathWithinRoots(selected.directory, boundaryRoots)) {
      throw new CustomAgentFileError("Agent definition directory escapes its configured root", 403);
    }
  } else if (createDirectory) {
    const ancestor = nearestExistingAncestor(selected.directory);
    if (!isExistingPathWithinRoots(ancestor, boundaryRoots)) {
      throw new CustomAgentFileError("Agent definition directory escapes its configured root", 403);
    }
    fs.mkdirSync(selected.directory, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(selected.boundary, selected.directory);
    if (!isExistingPathWithinRoots(selected.directory, boundaryRoots)) {
      throw new CustomAgentFileError("Agent definition directory escapes its configured root", 403);
    }
  }
  return selected;
}

function assertSafeAgentFile(location: AgentLocation, filePath: string, requireExisting: boolean): void {
  const definitionRoots = new Set([location.directory]);
  if (!isPathWithinRoots(filePath, definitionRoots) || !isFilePathAllowed(filePath, definitionRoots)) {
    throw new CustomAgentFileError("Agent definition path is not allowed", 403);
  }
  assertNoSymlinkComponents(location.boundary, filePath);
  const ancestor = nearestExistingAncestor(filePath);
  if (!isExistingPathWithinRoots(ancestor, new Set([location.boundary]))) {
    throw new CustomAgentFileError("Agent definition path escapes its configured root", 403);
  }
  if (!fs.existsSync(filePath)) {
    if (requireExisting) throw new CustomAgentFileError("Agent definition not found", 404);
    return;
  }
  const fileStat = fs.lstatSync(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || !isExistingPathWithinRoots(filePath, definitionRoots)) {
    throw new CustomAgentFileError("Agent definition must be a regular file inside its configured root", 403);
  }
}

async function canonicalizeAllowedCwd(value: unknown, accountUid: string): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new CustomAgentFileError("cwd is required");
  const requested = path.resolve(value);
  let cwd: string;
  try {
    cwd = fs.realpathSync(requested);
    if (!fs.statSync(cwd).isDirectory()) throw new CustomAgentFileError("cwd is not a directory");
  } catch (error) {
    if (error instanceof CustomAgentFileError) throw error;
    throw new CustomAgentFileError("cwd is not a directory");
  }
  const roots = await getAllowedFileRoots(accountUid, cwd);
  if (!isExistingFilePathAllowed(cwd, roots)) {
    throw new CustomAgentFileError("cwd is outside the allowed project roots", 403);
  }
  return cwd;
}

function readAgentDirectory(location: AgentLocation): CustomAgent[] {
  if (!fs.existsSync(location.directory)) return [];
  let selected: AgentLocation;
  try {
    selected = assertSafeLocation(location);
  } catch {
    return [];
  }
  const agents: CustomAgent[] = [];
  for (const entry of fs.readdirSync(selected.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(selected.directory, entry.name);
    try {
      assertSafeAgentFile(selected, filePath, true);
      const agent = parseCustomAgentFile(filePath, selected.scope);
      if (agent) agents.push(agent);
    } catch {
      // A malformed or unsafe entry must not hide the remaining definitions.
    }
  }
  return agents;
}

function assertProjectAgentAccess(cwd: string): { requiresTrust: boolean; trusted: boolean } {
  const status = getProjectTrustStatus(cwd, getAgentDir());
  if (status.requiresTrust && !status.trusted) {
    throw new CustomAgentFileError("Project resources must be trusted before using project Agents", 403);
  }
  return status;
}

export async function listCustomAgents(cwdValue: unknown, accountUid: string): Promise<CustomAgent[]> {
  const cwd = await canonicalizeAllowedCwd(cwdValue, accountUid);
  const globalAgents = readAgentDirectory(getAgentLocation(cwd, accountUid, "global"));
  const projectStatus = getProjectTrustStatus(cwd, getAgentDir());
  const projectAgents = projectStatus.trusted
    ? readAgentDirectory(getAgentLocation(cwd, accountUid, "project"))
    : [];
  const merged = new Map(globalAgents.map((agent) => [agent.name, agent]));
  for (const agent of projectAgents) merged.set(agent.name, agent);
  return [...merged.values()];
}

export async function resolveCustomAgentRuntimeConfig(
  cwdValue: unknown,
  accountUid: string,
  id: unknown,
): Promise<AgentRuntimeConfig> {
  if (typeof id !== "string") throw new CustomAgentFileError("A valid Agent id is required");
  const match = id.match(/^(global|project):([a-z0-9][a-z0-9_-]{0,63})$/);
  if (!match) throw new CustomAgentFileError("A valid Agent id is required");
  const [, rawScope, name] = match;
  const scope = rawScope as CustomAgentScope;
  const cwd = await canonicalizeAllowedCwd(cwdValue, accountUid);
  if (scope === "project") assertProjectAgentAccess(cwd);
  const agent = readAgentDirectory(getAgentLocation(cwd, accountUid, scope))
    .find((candidate) => candidate.name === name);
  if (!agent) throw new CustomAgentFileError("Agent definition not found", 404);
  return {
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    ...(agent.allSkills ? {} : { skills: agent.skills ?? [] }),
  };
}

export async function createCustomAgent(
  cwdValue: unknown,
  accountUid: string,
  input: Partial<CustomAgent>,
): Promise<CustomAgent> {
  const cwd = await canonicalizeAllowedCwd(cwdValue, accountUid);
  const agent = sanitizeCustomAgent(input);
  const projectStatus = agent.scope === "project" ? assertProjectAgentAccess(cwd) : null;
  const location = assertSafeLocation(getAgentLocation(cwd, accountUid, agent.scope), true);
  const filePath = path.join(location.directory, `${agent.name}.md`);
  assertSafeAgentFile(location, filePath, false);
  if (fs.existsSync(filePath)) throw new CustomAgentFileError("An Agent with this name already exists in that scope", 409);
  fs.writeFileSync(filePath, serializeCustomAgent(agent), { encoding: "utf8", flag: "wx", mode: 0o600 });
  // Creating the first project Agent is itself an explicit authoring action.
  // Record trust after the new resource exists so it remains usable on reload.
  if (agent.scope === "project" && projectStatus && !projectStatus.requiresTrust) {
    trustProject(cwd, getAgentDir());
  }
  const created = parseCustomAgentFile(filePath, agent.scope);
  if (!created) throw new CustomAgentFileError("Failed to read the new Agent definition", 500);
  return created;
}

export async function updateCustomAgent(
  cwdValue: unknown,
  accountUid: string,
  original: { name?: string; scope?: CustomAgentScope; mtimeMs?: number },
  input: Partial<CustomAgent>,
): Promise<CustomAgent> {
  const cwd = await canonicalizeAllowedCwd(cwdValue, accountUid);
  const agent = sanitizeCustomAgent(input);
  const originalScope: CustomAgentScope = original.scope === "project" ? "project" : "global";
  const originalName = original.name ?? agent.name;
  if (!CUSTOM_AGENT_NAME_RE.test(originalName)) throw new CustomAgentFileError("Invalid original Agent name");
  if (originalScope === "project" || agent.scope === "project") assertProjectAgentAccess(cwd);

  const originalLocation = assertSafeLocation(getAgentLocation(cwd, accountUid, originalScope));
  const originalPath = path.join(originalLocation.directory, `${originalName}.md`);
  assertSafeAgentFile(originalLocation, originalPath, true);
  if (
    typeof original.mtimeMs === "number"
    && Math.abs(fs.statSync(originalPath).mtimeMs - original.mtimeMs) > 0.001
  ) {
    throw new CustomAgentFileError("Agent definition changed on disk", 409);
  }

  // Older editors may omit this field. Saving other properties must not make a
  // main-only profile available for child-agent spawning again.
  if (agent.subagentEnabled === undefined) {
    agent.subagentEnabled = parseCustomAgentFile(originalPath, originalScope)?.subagentEnabled;
  }

  const nextLocation = assertSafeLocation(getAgentLocation(cwd, accountUid, agent.scope), true);
  const nextPath = path.join(nextLocation.directory, `${agent.name}.md`);
  assertSafeAgentFile(nextLocation, nextPath, nextPath === originalPath);
  if (nextPath !== originalPath && fs.existsSync(nextPath)) {
    throw new CustomAgentFileError("The target Agent name already exists", 409);
  }
  if (nextPath === originalPath) {
    writePrivateFileAtomicSync(nextPath, serializeCustomAgent(agent));
  } else {
    fs.writeFileSync(nextPath, serializeCustomAgent(agent), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.unlinkSync(originalPath);
  }
  const updated = parseCustomAgentFile(nextPath, agent.scope);
  if (!updated) throw new CustomAgentFileError("Failed to read the updated Agent definition", 500);
  return updated;
}

export async function deleteCustomAgent(
  cwdValue: unknown,
  accountUid: string,
  name: unknown,
  scopeValue: unknown,
): Promise<void> {
  if (typeof name !== "string" || !CUSTOM_AGENT_NAME_RE.test(name)) {
    throw new CustomAgentFileError("Invalid Agent name");
  }
  const cwd = await canonicalizeAllowedCwd(cwdValue, accountUid);
  const scope: CustomAgentScope = scopeValue === "project" ? "project" : "global";
  if (scope === "project") assertProjectAgentAccess(cwd);
  const location = assertSafeLocation(getAgentLocation(cwd, accountUid, scope));
  const filePath = path.join(location.directory, `${name}.md`);
  assertSafeAgentFile(location, filePath, true);
  fs.unlinkSync(filePath);
}
