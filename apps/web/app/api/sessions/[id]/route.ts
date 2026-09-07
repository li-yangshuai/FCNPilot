import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession } from "@/lib/rpc-manager";
import { getCliBridgeAgentState } from "@/lib/cli-bridge";
import { accountOwnsSession, getCurrentAccountUid, unbindSession } from "@/lib/accounts";
import { getSessionAgentVersionId, unbindSessionAgentVersion } from "@/lib/agent-versions";
import { getHistoricalContextUsage } from "@/lib/historical-context-usage";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";

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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const accountUidOrResponse = await requireSessionAccess(id);
    if (accountUidOrResponse instanceof Response) return accountUidOrResponse;
    const accountUid = accountUidOrResponse;

    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
    });
    const [contextUsage, totalActiveMs] = await Promise.all([
      getHistoricalContextUsage(sm, leafId, accountUid),
      Promise.resolve(computeSessionTotalActiveMs(entries)),
    ]);

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const resolvedParentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const parentSessionId = resolvedParentSessionId
      && accountOwnsSession(accountUid, resolvedParentSessionId)
      ? resolvedParentSessionId
      : undefined;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((message) => message.role === "user")
        ? (() => {
            const message = context.messages.find((candidate) => candidate.role === "user")!;
            const content = (message as { content: unknown }).content;
            return typeof content === "string"
              ? content
              : (Array.isArray(content)
                  ? (content.find((block: { type: string }) => block.type === "text") as { text: string } | undefined)?.text ?? ""
                  : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      transient: !filePath || !existsSync(filePath),
    } : null;

    let agentState: { running: boolean; state?: unknown } | undefined;
    if (searchParams.has("includeState")) {
      const cliState = getCliBridgeAgentState(id);
      if (cliState) {
        agentState = { running: true, state: cliState };
      } else if (liveRpc) {
        agentState = { running: true, state: await liveRpc.send({ type: "get_state" }) };
      } else {
        agentState = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      contextUsage,
      totalActiveMs,
      agentVersionId: getSessionAgentVersionId(accountUid, id),
      ...(agentState !== undefined ? { agentState } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const accountUidOrResponse = await requireSessionAccess(id);
    if (accountUidOrResponse instanceof Response) return accountUidOrResponse;

    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const accountUidOrResponse = await requireSessionAccess(id);
    if (accountUidOrResponse instanceof Response) return accountUidOrResponse;
    const accountUid = accountUidOrResponse;

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (!existsSync(filePath)) {
      await getRpcSession(id)?.shutdown();
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      unbindSessionAgentVersion(accountUid, id);
      unbindSession(id);
      return NextResponse.json({ ok: true, missingFile: true });
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;

    // Re-attach direct children to this session's parent (cascade re-parent).
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as {
            type?: string;
            id?: string;
            parentSession?: string;
          };
          if (
            header.type === "session"
            && typeof header.id === "string"
            && accountOwnsSession(accountUid, header.id)
            && header.parentSession
            && sessionPathKey(header.parentSession) === targetPathKey
          ) {
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    await getRpcSession(id)?.shutdown();
    unlinkSync(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    unbindSessionAgentVersion(accountUid, id);
    unbindSession(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
