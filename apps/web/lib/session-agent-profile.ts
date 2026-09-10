import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { CustomAgentFileError } from "./custom-agent-files";
import { resolveNewSessionAgentConfig } from "./new-session-agent";
import type { AgentRuntimeConfig } from "./custom-agents";

const PROFILE_ENTRY_TYPE = "pi-web-agent-profile";
const PROFILE_ID = /^(global|project):[a-z0-9][a-z0-9_-]{0,63}$/;

/** Session metadata holds identity only; prompts and tool policy are re-read. */
export function getSessionAgentProfileId(manager: Pick<SessionManager, "getEntries">): string | undefined {
  let agentId: string | undefined;
  for (const entry of manager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== PROFILE_ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; agentId?: unknown } | null;
    if (!data || data.version !== 1 || typeof data.agentId !== "string" || !PROFILE_ID.test(data.agentId)) {
      throw new CustomAgentFileError("Session Agent binding is invalid; cannot restore its policy", 409);
    }
    if (agentId && agentId !== data.agentId) {
      throw new CustomAgentFileError("Session has conflicting Agent bindings", 409);
    }
    agentId = data.agentId;
  }
  return agentId;
}

/** Browsing dormant state must not instantiate a runtime or migrate its file. */
export function readSessionAgentProfileId(file: string): string | undefined {
  const entries = parseSessionEntries(readFileSync(file, "utf8")).filter((entry) => entry.type !== "session");
  return getSessionAgentProfileId({ getEntries: () => entries });
}

export async function initializeSessionAgentProfile(
  manager: SessionManager,
  accountUid: string,
  requestedAgentId?: string,
): Promise<AgentRuntimeConfig> {
  const savedAgentId = getSessionAgentProfileId(manager);
  if (savedAgentId && requestedAgentId && savedAgentId !== requestedAgentId) {
    throw new CustomAgentFileError("An existing session's Agent cannot be changed", 409);
  }
  const agentId = savedAgentId ?? requestedAgentId;
  const config = await resolveNewSessionAgentConfig(manager.getCwd(), accountUid, agentId ? { id: agentId } : undefined);
  if (!savedAgentId) manager.appendCustomEntry(PROFILE_ENTRY_TYPE, { version: 1, agentId: config.id });
  return config;
}

/** Pi defers its first write until an assistant replies. Keep selected profiles
 * and empty forks durable without manufacturing a message or changing entries. */
export function persistUnflushedSession(manager: SessionManager): void {
  const file = manager.getSessionFile();
  if (!manager.isPersisted() || !file || existsSync(file)) return;
  const header = manager.getHeader();
  if (!header) throw new Error("Cannot persist a session without its header");
  const content = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  // Use the public reload API to synchronize SDK persistence state.
  manager.setSessionFile(file);
}

export function forkSessionBeforeEntry(manager: SessionManager, entryId: string): SessionManager {
  const currentFile = manager.getSessionFile();
  if (!manager.isPersisted() || !currentFile) throw new Error("Cannot fork an unpersisted session");
  const entry = manager.getEntry(entryId);
  if (!entry) throw new Error("Invalid entry ID for forking");
  let forked: SessionManager;
  if (!entry.parentId) {
    forked = SessionManager.create(manager.getCwd(), manager.getSessionDir(), { parentSession: currentFile });
  } else {
    forked = SessionManager.open(currentFile, manager.getSessionDir());
    forked.createBranchedSession(entry.parentId);
  }
  // The initial profile entry normally lies before every user message. Preserve
  // identity even when the selected fork point precedes that metadata entry.
  const agentId = getSessionAgentProfileId(manager);
  if (agentId && !getSessionAgentProfileId(forked)) {
    forked.appendCustomEntry(PROFILE_ENTRY_TYPE, { version: 1, agentId });
  }
  persistUnflushedSession(forked);
  return forked;
}
