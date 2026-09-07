import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { bindSessionToAccount, getCurrentAccountUid, unbindSession } from "@/lib/accounts";
import { CustomAgentFileError } from "@/lib/custom-agent-files";
import { resolveNewSessionAgentConfig } from "@/lib/new-session-agent";
import {
  bindSessionToAgentVersion,
  getAgentVersion,
  getDefaultAgentVersionId,
} from "@/lib/agent-versions";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }

    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!isFilePathAllowed(cwd, await getAllowedFileRoots(accountUid, cwd))) {
      return NextResponse.json({ error: "cwd is outside this account's allowed workspaces" }, { status: 403 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const {
      provider,
      modelId,
      toolNames,
      thinkingLevel,
      agentConfig: requestedAgentConfig,
      agentVersionId,
      ...promptCommand
    } = command as {
      provider?: string;
      modelId?: string;
      toolNames?: string[];
      thinkingLevel?: unknown;
      agentConfig?: { id?: unknown };
      agentVersionId?: string;
      [key: string]: unknown;
    };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);
    // Agent profiles contain privileged system prompts and tool/skill policy.
    // Accept only the stable id from the browser and re-read the definition
    // through the trust- and path-checked server-side registry.
    const agentConfig = await resolveNewSessionAgentConfig(cwd, accountUid, requestedAgentConfig);
    const effectiveToolNames = agentConfig?.tools ?? toolNames;

    const selectedAgentVersionId = agentVersionId ?? getDefaultAgentVersionId(accountUid);
    const selectedAgentVersion = getAgentVersion(selectedAgentVersionId);
    if (!selectedAgentVersion) {
      return NextResponse.json({ error: "Agent version is unavailable" }, { status: 400 });
    }
    // This is the adapter seam for independently deployed Agent images. The
    // HTTP transport is deliberately explicit until its event/command proxy is
    // implemented, so a configured remote version can never silently run local.
    if (selectedAgentVersion.transport !== "local") {
      return NextResponse.json({
        error: `Agent version '${selectedAgentVersionId}' uses the reserved HTTP transport, which is not connected yet`,
      }, { status: 501 });
    }

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(effectiveToolNames ? { toolNames: effectiveToolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      ...(agentConfig ? { agentConfig } : {}),
      accountUid,
    });
    try {
      bindSessionToAccount(realSessionId, accountUid);
      bindSessionToAgentVersion(accountUid, realSessionId, selectedAgentVersionId);
    } catch (error) {
      session.destroy();
      unbindSession(realSessionId);
      throw error;
    }

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(accountUid, cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
      agentProfileId?: string | null;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
        agentProfileId: state.agentProfileId ?? null,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
      agentProfileId: state.agentProfileId ?? null,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: error instanceof CustomAgentFileError ? error.status : 500 });
  }
}
