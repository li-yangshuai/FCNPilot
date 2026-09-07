import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { getCliBridgeAgentState, getCliBridgeState, sendCliCommand } from "@/lib/cli-bridge";
import { accountOwnsSession, bindSessionToAccount, getCurrentAccountUid } from "@/lib/accounts";
import { inheritSessionAgentVersion } from "@/lib/agent-versions";
import { CustomAgentFileError } from "@/lib/custom-agent-files";
import { readSessionAgentProfileId } from "@/lib/session-agent-profile";

async function requireSessionAccess(sessionId: string): Promise<string | Response> {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }
  if (!accountOwnsSession(accountUid, sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return accountUid;
}

function bindForkedSession(result: unknown, accountUid: string, parentSessionId: string): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const newSessionId = (result as { newSessionId?: unknown }).newSessionId;
  if (typeof newSessionId === "string" && newSessionId) {
    bindSessionToAccount(newSessionId, accountUid);
    inheritSessionAgentVersion(accountUid, parentSessionId, newSessionId);
  }
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const accountUidOrResponse = await requireSessionAccess(id);
    if (accountUidOrResponse instanceof Response) return accountUidOrResponse;
    const accountUid = accountUidOrResponse;

    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // An attached interactive CLI owns the AgentSession and session file.
    // Forward commands to its extension instead of creating a second writer.
    const cliBridge = getCliBridgeState(id);
    if (cliBridge) {
      if (body.type === "get_state") {
        return NextResponse.json({ success: true, data: getCliBridgeAgentState(id) });
      }
      const result = await sendCliCommand(id, body);
      promptAccepted = body.type === "prompt";
      bindForkedSession(result, accountUid, id);
      return NextResponse.json({ success: true, data: result });
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      bindForkedSession(result, accountUid, id);
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, { accountUid });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";
    bindForkedSession(result, accountUid, id);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: error instanceof CustomAgentFileError ? error.status : 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const accountUidOrResponse = await requireSessionAccess(id);
    if (accountUidOrResponse instanceof Response) return accountUidOrResponse;

    const cliBridge = getCliBridgeState(id);
    if (cliBridge) {
      return NextResponse.json({
        running: true,
        transport: "cli",
        state: getCliBridgeAgentState(id),
      });
    }

    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      const filePath = await resolveSessionPath(id);
      return NextResponse.json({
        running: false,
        state: { agentProfileId: filePath ? readSessionAgentProfileId(filePath) ?? null : null },
      });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof CustomAgentFileError ? error.status : 500 });
  }
}
