import { NextResponse } from "next/server";
import { closeSync, openSync, readSync, realpathSync, statSync } from "fs";
import {
  claimCliBridgePairing,
  getCliBridgeToken,
  registerCliBridge,
  type CliBridgePairingClaim,
  type CliBridgeRegistration,
} from "@/lib/cli-bridge";
import { getRpcSession } from "@/lib/rpc-manager";
import { bindSessionToAccount, getSessionOwnerUid } from "@/lib/accounts";
import { isPathInsidePiSessions } from "@/lib/file-access";

export const dynamic = "force-dynamic";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;

function readSessionHeader(sessionFile: string): Record<string, unknown> {
  const handle = openSync(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 && bytesRead === buffer.length) throw new Error("Session header is too large");
    const firstLine = buffer.subarray(0, newline >= 0 ? newline : bytesRead).toString("utf8").trim();
    const parsed = JSON.parse(firstLine) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid session header");
    }
    return parsed as Record<string, unknown>;
  } finally {
    closeSync(handle);
  }
}

function validateSessionRegistration(
  registration: Pick<CliBridgeRegistration, "sessionId" | "sessionFile">,
  claim: CliBridgePairingClaim,
): string {
  const sessionFile = realpathSync(registration.sessionFile);
  if (!statSync(sessionFile).isFile() || !isPathInsidePiSessions(sessionFile)) {
    throw new Error("Session file is outside the Pi sessions directory");
  }

  const header = readSessionHeader(sessionFile);
  if (header.type !== "session" || header.id !== registration.sessionId || typeof header.cwd !== "string") {
    throw new Error("Session file does not match the CLI registration");
  }
  if (realpathSync(header.cwd) !== claim.cwd) {
    throw new Error("Session workspace does not match the pairing workspace");
  }

  const ownerUid = getSessionOwnerUid(registration.sessionId);
  if (ownerUid && ownerUid !== claim.uid) {
    throw new Error("Session is owned by another account");
  }
  if (!ownerUid) {
    const createdAt = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    if (!Number.isFinite(createdAt) || createdAt < claim.createdAt - 5_000) {
      throw new Error("Existing unowned sessions require explicit administrator recovery");
    }
  }
  return sessionFile;
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as Partial<CliBridgeRegistration>;
    if (!body.clientId || !body.sessionId || !body.sessionFile || !body.cwd) {
      return NextResponse.json(
        { error: "clientId, sessionId, sessionFile and cwd are required" },
        { status: 400 },
      );
    }

    const pairingToken = getCliBridgeToken(req);
    const account = claimCliBridgePairing(pairingToken, body.clientId, body.cwd);
    if (!account) {
      return NextResponse.json({ error: "Invalid or expired CLI pairing token" }, { status: 403 });
    }
    if ((body.accountUid && body.accountUid !== account.uid) || (body.username && body.username !== account.username)) {
      return NextResponse.json({ error: "CLI account identity does not match pairing token" }, { status: 403 });
    }
    let sessionFile: string;
    try {
      sessionFile = validateSessionRegistration(body as CliBridgeRegistration, account);
    } catch (error) {
      console.warn("[pi-web] CLI session registration rejected:", error);
      return NextResponse.json({ error: "CLI session registration is not authorized" }, { status: 403 });
    }
    bindSessionToAccount(body.sessionId, account.uid);
    // The interactive CLI becomes the sole owner of this session. Only stop
    // the in-process writer after account ownership has been validated.
    const rpcSession = getRpcSession(body.sessionId);
    if (rpcSession) {
      try {
        await rpcSession.send({ type: "abort" });
      } catch {
        // It may already be idle or shutting down.
      }
      rpcSession.destroy();
    }
    const registration = { ...body };
    delete registration.pairingToken;
    registerCliBridge({
      ...registration as CliBridgeRegistration,
      sessionFile,
      accountUid: account.uid,
      username: account.username,
      pairingToken,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
