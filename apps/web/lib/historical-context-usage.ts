import {
  buildSessionContext,
  calculateContextTokens,
  createAgentSessionServices,
  estimateTokens,
  getAgentDir,
  ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { ContextUsage } from "./pi-types";
import { projectTrustReloadOptions } from "./project-trust";
import { SHARED_ACCOUNT_UID } from "./shared-workspace";

type ContextMessage = Parameters<typeof estimateTokens>[0];
type MessageUsage = Parameters<typeof calculateContextTokens>[0];

function validAssistantUsage(message: ContextMessage): MessageUsage | null {
  const candidate = message as unknown as {
    role?: string;
    stopReason?: string;
    usage?: MessageUsage;
  };
  if (
    candidate.role !== "assistant"
    || candidate.stopReason === "aborted"
    || candidate.stopReason === "error"
    || !candidate.usage
  ) return null;

  return calculateContextTokens(candidate.usage) > 0 ? candidate.usage : null;
}

function estimateContextTokens(messages: ContextMessage[]): number {
  let lastUsageIndex = -1;
  let lastUsage: MessageUsage | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = validAssistantUsage(messages[index]);
    if (!usage) continue;
    lastUsageIndex = index;
    lastUsage = usage;
    break;
  }

  let tokens = lastUsage ? calculateContextTokens(lastUsage) : 0;
  const firstEstimatedIndex = lastUsageIndex >= 0 ? lastUsageIndex + 1 : 0;
  for (let index = firstEstimatedIndex; index < messages.length; index += 1) {
    tokens += estimateTokens(messages[index]);
  }
  return tokens;
}

/**
 * Reconstruct the SDK's context usage for a read-only historical session.
 * This avoids starting an AgentSession merely to populate the top-bar meter.
 */
export async function getHistoricalContextUsage(
  sessionManager: SessionManager,
  leafId?: string | null,
  accountUid: string = SHARED_ACCOUNT_UID,
): Promise<ContextUsage | null> {
  if (!accountUid) return null;
  try {
    const entries = sessionManager.getEntries();
    const context = buildSessionContext(entries, leafId);
    const selection = context.model;
    if (!selection) return null;

    const cwd = sessionManager.getCwd();
    const sharedAgentDir = getAgentDir();
    const agentDir = getAgentDir();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(sharedAgentDir, "auth.json"),
      modelsPath: join(sharedAgentDir, "models.json"),
    });
    const trustReloadOptions = projectTrustReloadOptions(cwd, sharedAgentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const directModel = services.modelRuntime.getModel(selection.provider, selection.modelId);
    const idMatches = directModel
      ? []
      : services.modelRuntime.getModels().filter((candidate) => candidate.id === selection.modelId);
    const matchingWindows = new Set(idMatches.map((candidate) => candidate.contextWindow).filter((value) => value > 0));
    // Provider labels may be renamed in models.json after a session was saved.
    // Falling back by model id is safe only when every match agrees on size.
    const contextWindow = directModel?.contextWindow
      ?? (matchingWindows.size === 1 ? [...matchingWindows][0] : 0);
    if (contextWindow <= 0) return null;

    const branch = sessionManager.getBranch(leafId ?? undefined);
    let latestCompactionIndex = -1;
    for (let index = 0; index < branch.length; index += 1) {
      if (branch[index].type === "compaction") latestCompactionIndex = index;
    }

    // Match AgentSession.getContextUsage(): usage recorded before the latest
    // compaction is stale, so the token count stays unknown until a later reply.
    if (latestCompactionIndex >= 0) {
      let hasUsageAfterCompaction = false;
      for (let index = branch.length - 1; index > latestCompactionIndex; index -= 1) {
        const entry = branch[index] as unknown as { type?: string; message?: ContextMessage };
        if (entry.type === "message" && entry.message && validAssistantUsage(entry.message)) {
          hasUsageAfterCompaction = true;
          break;
        }
      }
      if (!hasUsageAfterCompaction) return { tokens: null, contextWindow, percent: null };
    }

    const tokens = estimateContextTokens(context.messages);
    return {
      tokens,
      contextWindow,
      percent: (tokens / contextWindow) * 100,
    };
  } catch {
    return null;
  }
}
