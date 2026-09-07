import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAccountPreferences } from "./account-preferences";
import { getPiWebConfigDir, getPiWebUserDir } from "./pi-web-paths";

export type AgentVersionTransport = "local" | "http";

export interface AgentVersionDefinition {
  id: string;
  label: string;
  enabled: boolean;
  transport: AgentVersionTransport;
  /** Reserved for the future HTTP Agent adapter. Never returned to the browser. */
  baseUrl?: string;
  description?: string;
}

interface AgentVersionsConfig {
  version: 1;
  defaultVersionId: string;
  versions: AgentVersionDefinition[];
}

interface SessionVersionStore {
  version: 1;
  sessions: Record<string, string>;
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const CURRENT_AGENT_VERSION_ID = "current";

const FALLBACK_CONFIG: AgentVersionsConfig = {
  version: 1,
  defaultVersionId: CURRENT_AGENT_VERSION_ID,
  versions: [{
    id: CURRENT_AGENT_VERSION_ID,
    label: "Current",
    enabled: true,
    transport: "local",
    description: "Agent bundled with this Web deployment",
  }],
};

export function getAgentVersionsConfigPath(): string {
  return join(getPiWebConfigDir(), "agent-versions.json");
}

function shortString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= maxLength ? result : undefined;
}

function normalizeConfig(value: unknown): AgentVersionsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return FALLBACK_CONFIG;
  const raw = value as Record<string, unknown>;
  const versions: AgentVersionDefinition[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.versions)) {
    for (const item of raw.versions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const id = shortString(entry.id, 64);
      const label = shortString(entry.label, 100);
      const transport = entry.transport === "http" ? "http" : entry.transport === "local" ? "local" : undefined;
      if (!id || !ID_RE.test(id) || !label || !transport || seen.has(id)) continue;
      const baseUrl = transport === "http" ? shortString(entry.baseUrl, 2048) : undefined;
      if (transport === "http" && !baseUrl) continue;
      seen.add(id);
      versions.push({
        id,
        label,
        enabled: entry.enabled !== false,
        transport,
        ...(baseUrl ? { baseUrl } : {}),
        ...(shortString(entry.description, 300) ? { description: shortString(entry.description, 300) } : {}),
      });
    }
  }
  if (versions.length === 0) return FALLBACK_CONFIG;
  const requestedDefault = shortString(raw.defaultVersionId, 64);
  const defaultVersionId = versions.some((entry) => entry.id === requestedDefault && entry.enabled)
    ? requestedDefault!
    : versions.find((entry) => entry.enabled)?.id ?? versions[0].id;
  return { version: 1, defaultVersionId, versions };
}

export function getAgentVersionsConfig(): AgentVersionsConfig {
  const filePath = getAgentVersionsConfigPath();
  if (!existsSync(filePath)) return FALLBACK_CONFIG;
  try {
    return normalizeConfig(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    throw new Error(`Unable to read Agent versions config: ${String(error)}`);
  }
}

export function getAgentVersion(versionId: string): AgentVersionDefinition | null {
  return getAgentVersionsConfig().versions.find((entry) => entry.id === versionId && entry.enabled) ?? null;
}

export function getDefaultAgentVersionId(accountUid: string): string {
  const config = getAgentVersionsConfig();
  const preferred = getAccountPreferences(accountUid).agentVersionId;
  return config.versions.some((entry) => entry.id === preferred && entry.enabled)
    ? preferred!
    : config.defaultVersionId;
}

function sessionStorePath(accountUid: string): string {
  return join(getPiWebUserDir(accountUid), "session-agent-versions.json");
}

function readSessionStore(accountUid: string): SessionVersionStore {
  const filePath = sessionStorePath(accountUid);
  if (!existsSync(filePath)) return { version: 1, sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: 1, sessions: {} };
    const sessions = (raw as Record<string, unknown>).sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return { version: 1, sessions: {} };
    return {
      version: 1,
      sessions: Object.fromEntries(Object.entries(sessions).filter(([id, value]) => id && typeof value === "string" && ID_RE.test(value))),
    };
  } catch (error) {
    throw new Error(`Unable to read Session Agent version bindings: ${String(error)}`);
  }
}

function writeSessionStore(accountUid: string, store: SessionVersionStore): void {
  const filePath = sessionStorePath(accountUid);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* preserve write error */ }
    throw error;
  }
}

export function bindSessionToAgentVersion(accountUid: string, sessionId: string, versionId: string): void {
  if (!sessionId || !getAgentVersion(versionId)) throw new Error("Invalid Agent version binding");
  const store = readSessionStore(accountUid);
  if (store.sessions[sessionId] === versionId) return;
  store.sessions[sessionId] = versionId;
  writeSessionStore(accountUid, store);
}

export function getSessionAgentVersionId(accountUid: string, sessionId: string): string {
  const stored = readSessionStore(accountUid).sessions[sessionId];
  return stored && getAgentVersion(stored) ? stored : CURRENT_AGENT_VERSION_ID;
}

export function unbindSessionAgentVersion(accountUid: string, sessionId: string): void {
  const store = readSessionStore(accountUid);
  if (!(sessionId in store.sessions)) return;
  delete store.sessions[sessionId];
  writeSessionStore(accountUid, store);
}

export function inheritSessionAgentVersion(accountUid: string, parentSessionId: string, childSessionId: string): void {
  bindSessionToAgentVersion(accountUid, childSessionId, getSessionAgentVersionId(accountUid, parentSessionId));
}
