import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPiWebUserDir, migrateLegacyFile } from "./pi-web-paths";

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_PRESETS = new Set(["none", "read-only", "default", "full"]);
const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh"]);
const BUILTIN_SUBAGENT_IDS = new Set(["general-purpose", "Explore", "Plan"]);
const PINNED_ACTIVITY_ITEMS = new Set([
  "cli", "terminal", "branches", "source-control", "export",
  "models", "agents", "mcp", "skills", "plugins",
]);

export type AccountToolPreset = "none" | "read-only" | "default" | "full";
export type AccountThinkingLevel = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AccountBuiltinSubagentId = "general-purpose" | "Explore" | "Plan";
export type AccountPinnedActivityItem =
  | "cli" | "terminal" | "branches" | "source-control" | "export"
  | "models" | "agents" | "mcp" | "skills" | "plugins";

export interface AccountPreferences {
  defaultModel?: { provider: string; modelId: string };
  /** Default Agent backend version for newly-created sessions. */
  agentVersionId?: string;
  toolPreset?: AccountToolPreset;
  thinkingLevel?: AccountThinkingLevel;
  selectedAgentId?: string | null;
  /** Pi Agent root used for new Web sessions (settings, agents, skills, extensions). */
  agentSuitePath?: string;
  /** Undefined means all configured MCP servers are enabled. */
  enabledMcpServers?: string[];
  /** Built-in subagent shortcuts hidden above the chat input; all are hidden when undefined. */
  hiddenBuiltinSubagentIds?: AccountBuiltinSubagentId[];
  /** Account-scoped starter prompts shown on the new-session welcome card. */
  welcomeSuggestions?: string[];
  /** Account-scoped shortcuts pinned to the left activity rail. */
  pinnedActivityItems?: AccountPinnedActivityItem[];
}

export type AccountPreferencesPatch = {
  defaultModel?: AccountPreferences["defaultModel"] | null;
  agentVersionId?: string | null;
  toolPreset?: AccountToolPreset | null;
  thinkingLevel?: AccountThinkingLevel | null;
  selectedAgentId?: string | null;
  agentSuitePath?: string | null;
  enabledMcpServers?: string[] | null;
  hiddenBuiltinSubagentIds?: AccountBuiltinSubagentId[] | null;
  welcomeSuggestions?: string[] | null;
  pinnedActivityItems?: AccountPinnedActivityItem[] | null;
};

function assertUid(uid: string): string {
  if (!UID_RE.test(uid)) throw new Error("Invalid account UID");
  return uid.toLowerCase();
}

function preferencesPath(uid: string): string {
  const canonicalUid = assertUid(uid);
  const nextPath = join(getPiWebUserDir(canonicalUid), "preferences.json");
  migrateLegacyFile(join(getAgentDir(), "pi-web-users", canonicalUid, "preferences.json"), nextPath);
  return nextPath;
}

function shortString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function normalizePreferences(value: unknown): AccountPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const preferences: AccountPreferences = {};

  if (raw.defaultModel && typeof raw.defaultModel === "object" && !Array.isArray(raw.defaultModel)) {
    const model = raw.defaultModel as Record<string, unknown>;
    const provider = shortString(model.provider);
    const modelId = shortString(model.modelId);
    if (provider && modelId) preferences.defaultModel = { provider, modelId };
  }
  const agentVersionId = shortString(raw.agentVersionId, 64);
  if (agentVersionId) preferences.agentVersionId = agentVersionId;
  if (typeof raw.toolPreset === "string" && TOOL_PRESETS.has(raw.toolPreset)) {
    preferences.toolPreset = raw.toolPreset as AccountToolPreset;
  }
  if (typeof raw.thinkingLevel === "string" && THINKING_LEVELS.has(raw.thinkingLevel)) {
    preferences.thinkingLevel = raw.thinkingLevel as AccountThinkingLevel;
  }
  if (raw.selectedAgentId === null) preferences.selectedAgentId = null;
  else {
    const selectedAgentId = shortString(raw.selectedAgentId);
    if (selectedAgentId) preferences.selectedAgentId = selectedAgentId;
  }
  const agentSuitePath = shortString(raw.agentSuitePath, 4096);
  if (agentSuitePath) preferences.agentSuitePath = agentSuitePath;
  if (Array.isArray(raw.enabledMcpServers)) {
    const names = raw.enabledMcpServers
      .map((name) => shortString(name, 128))
      .filter((name): name is string => Boolean(name));
    preferences.enabledMcpServers = [...new Set(names)].slice(0, 100);
  }
  if (Array.isArray(raw.hiddenBuiltinSubagentIds)) {
    const ids = raw.hiddenBuiltinSubagentIds
      .filter((id): id is AccountBuiltinSubagentId => typeof id === "string" && BUILTIN_SUBAGENT_IDS.has(id));
    preferences.hiddenBuiltinSubagentIds = [...new Set(ids)];
  }
  if (Array.isArray(raw.welcomeSuggestions)) {
    const suggestions = raw.welcomeSuggestions
      .map((suggestion) => shortString(suggestion, 240))
      .filter((suggestion): suggestion is string => Boolean(suggestion));
    if (suggestions.length > 0) preferences.welcomeSuggestions = suggestions.slice(0, 6);
  }
  if (Array.isArray(raw.pinnedActivityItems)) {
    const items = raw.pinnedActivityItems
      .filter((item): item is AccountPinnedActivityItem => typeof item === "string" && PINNED_ACTIVITY_ITEMS.has(item));
    preferences.pinnedActivityItems = [...new Set(items)];
  }
  return preferences;
}

export function getAccountPreferences(uid: string): AccountPreferences {
  const filePath = preferencesPath(uid);
  if (!existsSync(filePath)) return {};
  try {
    return normalizePreferences(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    throw new Error(`Unable to read account preferences: ${String(error)}`);
  }
}

function writePreferences(uid: string, preferences: AccountPreferences): void {
  const filePath = preferencesPath(uid);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(preferences, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function updateAccountPreferences(uid: string, patch: AccountPreferencesPatch): AccountPreferences {
  const next = getAccountPreferences(uid);

  if ("defaultModel" in patch) {
    if (patch.defaultModel === null) delete next.defaultModel;
    else {
      const provider = shortString(patch.defaultModel?.provider);
      const modelId = shortString(patch.defaultModel?.modelId);
      if (!provider || !modelId) throw new Error("Invalid default model preference");
      next.defaultModel = { provider, modelId };
    }
  }
  if ("agentVersionId" in patch) {
    if (patch.agentVersionId === null) delete next.agentVersionId;
    else {
      const agentVersionId = shortString(patch.agentVersionId, 64);
      if (!agentVersionId) throw new Error("Invalid Agent version preference");
      next.agentVersionId = agentVersionId;
    }
  }
  if ("toolPreset" in patch) {
    if (patch.toolPreset === null) delete next.toolPreset;
    else if (!patch.toolPreset || !TOOL_PRESETS.has(patch.toolPreset)) throw new Error("Invalid tool preset preference");
    else next.toolPreset = patch.toolPreset;
  }
  if ("thinkingLevel" in patch) {
    if (patch.thinkingLevel === null) delete next.thinkingLevel;
    else if (!patch.thinkingLevel || !THINKING_LEVELS.has(patch.thinkingLevel)) throw new Error("Invalid thinking level preference");
    else next.thinkingLevel = patch.thinkingLevel;
  }
  if ("selectedAgentId" in patch) {
    if (patch.selectedAgentId === null) next.selectedAgentId = null;
    else {
      const selectedAgentId = shortString(patch.selectedAgentId);
      if (!selectedAgentId) throw new Error("Invalid Agent preference");
      next.selectedAgentId = selectedAgentId;
    }
  }
  if ("agentSuitePath" in patch) {
    if (patch.agentSuitePath === null) delete next.agentSuitePath;
    else {
      const agentSuitePath = shortString(patch.agentSuitePath, 4096);
      if (!agentSuitePath) throw new Error("Invalid Agent suite path");
      next.agentSuitePath = agentSuitePath;
    }
  }
  if ("enabledMcpServers" in patch) {
    if (patch.enabledMcpServers === null) delete next.enabledMcpServers;
    else if (!Array.isArray(patch.enabledMcpServers)) throw new Error("Invalid MCP server preference");
    else {
      const names = patch.enabledMcpServers.map((name) => shortString(name, 128));
      if (names.some((name) => !name)) throw new Error("Invalid MCP server preference");
      next.enabledMcpServers = [...new Set(names as string[])].slice(0, 100);
    }
  }
  if ("hiddenBuiltinSubagentIds" in patch) {
    if (patch.hiddenBuiltinSubagentIds === null) delete next.hiddenBuiltinSubagentIds;
    else if (!Array.isArray(patch.hiddenBuiltinSubagentIds)
      || patch.hiddenBuiltinSubagentIds.some((id) => !BUILTIN_SUBAGENT_IDS.has(id))) {
      throw new Error("Invalid hidden built-in subagent preference");
    } else {
      next.hiddenBuiltinSubagentIds = [...new Set(patch.hiddenBuiltinSubagentIds)];
    }
  }
  if ("welcomeSuggestions" in patch) {
    if (patch.welcomeSuggestions === null) delete next.welcomeSuggestions;
    else if (!Array.isArray(patch.welcomeSuggestions) || patch.welcomeSuggestions.length < 1 || patch.welcomeSuggestions.length > 6) {
      throw new Error("Welcome suggestions must contain between 1 and 6 prompts");
    } else {
      const suggestions = patch.welcomeSuggestions.map((suggestion) => shortString(suggestion, 240));
      if (suggestions.some((suggestion) => !suggestion)) throw new Error("Invalid welcome suggestion");
      next.welcomeSuggestions = suggestions as string[];
    }
  }
  if ("pinnedActivityItems" in patch) {
    if (patch.pinnedActivityItems === null) delete next.pinnedActivityItems;
    else if (!Array.isArray(patch.pinnedActivityItems) || patch.pinnedActivityItems.some((item) => !PINNED_ACTIVITY_ITEMS.has(item))) {
      throw new Error("Invalid pinned activity items preference");
    } else {
      next.pinnedActivityItems = [...new Set(patch.pinnedActivityItems)];
    }
  }

  writePreferences(uid, next);
  return next;
}

export function deleteAccountPreferences(uid: string): void {
  const filePath = preferencesPath(uid);
  rmSync(dirname(filePath), { recursive: true, force: true });
  rmSync(join(getAgentDir(), "pi-web-users", assertUid(uid)), { recursive: true, force: true });
}
