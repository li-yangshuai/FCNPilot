import fs from "node:fs";
import path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeConfig, CustomAgent } from "./custom-agents";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { getProjectTrustStatus } from "./project-trust";
import { FCN_AGENT_ID, FCN_TOOL_NAMES } from "./fcn-agent-policy";

export class CustomAgentFileError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "CustomAgentFileError";
  }
}

async function profilePath(cwdValue: unknown, accountUid: string): Promise<string> {
  if (typeof cwdValue !== "string" || !cwdValue.trim()) throw new CustomAgentFileError("FCN workspace is required");
  let cwd: string;
  try { cwd = fs.realpathSync(cwdValue); } catch { throw new CustomAgentFileError("FCN workspace does not exist", 404); }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots(accountUid, cwd))) {
    throw new CustomAgentFileError("FCN workspace is outside this account's allowed roots", 403);
  }
  if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) {
    throw new CustomAgentFileError("FCN project resources must be trusted before loading the main Agent", 403);
  }
  let current = cwd;
  for (const segment of [".pi", "agents", "ifcn.md"]) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { throw new CustomAgentFileError("FCN main Agent definition not found", 404); }
    if (stat.isSymbolicLink()) throw new CustomAgentFileError("FCN Agent definition cannot contain symbolic links", 403);
  }
  return current;
}

function readMainProfile(filename: string): CustomAgent {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new CustomAgentFileError("FCN main Agent definition is invalid", 409);
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filename, "utf8"));
  const rawTools = Array.isArray(frontmatter.tools) ? frontmatter.tools.map(String)
    : String(frontmatter.tools ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (frontmatter.name !== "ifcn" || typeof frontmatter.description !== "string" || !frontmatter.description.trim()
    || !body.trim() || rawTools.some((name) => !(FCN_TOOL_NAMES as readonly string[]).includes(name))
    || !FCN_TOOL_NAMES.filter((name) => name.startsWith("ifcn_")).every((name) => rawTools.includes(name))) {
    throw new CustomAgentFileError("FCN main Agent must declare only circuit-design tools and all four FCN tools", 409);
  }
  return {
    id: FCN_AGENT_ID, name: "ifcn", description: frontmatter.description.trim(), scope: "project",
    filePath: filename, systemPrompt: body.trim(), tools: [...FCN_TOOL_NAMES], skills: [], allSkills: false,
    mtimeMs: stat.mtimeMs,
  };
}

/** Read-only registry: FCNPilot has exactly one project-owned main Agent. */
export async function listCustomAgents(cwd: unknown, accountUid: string): Promise<CustomAgent[]> {
  try { return [readMainProfile(await profilePath(cwd, accountUid))]; }
  catch (error) {
    if (error instanceof CustomAgentFileError && [403, 404].includes(error.status)) return [];
    throw error;
  }
}

export async function resolveCustomAgentRuntimeConfig(
  cwd: unknown, accountUid: string, id: unknown,
): Promise<AgentRuntimeConfig> {
  if (id !== FCN_AGENT_ID) throw new CustomAgentFileError("FCNPilot only supports the FCN main Agent", 409);
  const profile = readMainProfile(await profilePath(cwd, accountUid));
  return { id: profile.id, name: profile.name, systemPrompt: profile.systemPrompt,
    tools: [...FCN_TOOL_NAMES], skills: [] };
}
