import { existsSync, statSync } from "fs";
import { NextResponse } from "next/server";
import { filterSessionsForAccount, getCurrentAccount } from "@/lib/accounts";
import { createCliBridgePairing } from "@/lib/cli-bridge";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requestOrigin(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.headers.get("host")?.trim();
  if (!host) return new URL(req.url).origin;
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || new URL(req.url).protocol.replace(/:$/, "") || "http";
  return `${protocol}://${host}`;
}

export async function POST(req: Request) {
  try {
    const account = await getCurrentAccount();
    if (!account) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({})) as { cwd?: unknown; sessionId?: unknown };
    const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const requestedCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    let targetSession: Awaited<ReturnType<typeof listAllSessions>>[number] | undefined;
    if (requestedSessionId) {
      const visibleSessions = filterSessionsForAccount(await listAllSessions(), account.uid);
      targetSession = visibleSessions.find((session) => session.id === requestedSessionId);
      if (!targetSession) {
        return NextResponse.json({ error: "The selected Web session no longer exists" }, { status: 404 });
      }
    }

    // A sync requested from an open chat must resume that exact session. Its
    // header cwd is authoritative; the file explorer may currently point at a
    // different directory.
    const cwd = targetSession?.cwd?.trim() || requestedCwd;
    if (!cwd) {
      return NextResponse.json({ error: "Select a project directory before starting CLI sync" }, { status: 400 });
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return NextResponse.json({ error: `Directory does not exist or is not a directory: ${cwd}` }, { status: 400 });
    }
    if (!isFilePathAllowed(cwd, await getAllowedFileRoots(account.uid))) {
      return NextResponse.json({ error: "cwd is outside this account's allowed workspaces" }, { status: 403 });
    }

    const webRoot = process.cwd();
    // When Next.js listens on 0.0.0.0, req.url may also expose that wildcard
    // address. It is valid for binding but not as a CLI destination. Preserve
    // the host the browser actually used (or the reverse-proxy host) instead.
    const origin = requestOrigin(req);
    const pairingToken = createCliBridgePairing(account, cwd);
    const resumeArgs = targetSession ? ` --session ${shellQuote(targetSession.id)}` : "";
    const passwordGuard = process.env.PI_WEB_PASSWORD
      ? 'PI_WEB_PASSWORD="${PI_WEB_PASSWORD:?Set PI_WEB_PASSWORD to the server Basic Auth password}"'
      : "";
    const command = [
      passwordGuard,
      `PI_WEB_CWD=${shellQuote(cwd)}`,
      `PI_WEB_URL=${shellQuote(origin)} npm --prefix ${shellQuote(webRoot)} run sync:cli -- --web-user ${shellQuote(account.username)} --web-uid ${shellQuote(account.uid)} --bridge-token ${shellQuote(pairingToken)}${resumeArgs}`,
    ].join(" ").trim();

    return NextResponse.json({
      command,
      uid: account.uid,
      username: account.username,
      cwd,
      webRoot,
      webUrl: origin,
      sessionId: targetSession?.id ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
