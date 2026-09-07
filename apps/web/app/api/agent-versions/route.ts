import { NextResponse } from "next/server";
import { accountOwnsSession, getCurrentAccountUid } from "@/lib/accounts";
import {
  getAgentVersionsConfig,
  getDefaultAgentVersionId,
  getSessionAgentVersionId,
} from "@/lib/agent-versions";
import { updateAccountPreferences } from "@/lib/account-preferences";

export async function GET(req: Request) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (sessionId && !accountOwnsSession(accountUid, sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const config = getAgentVersionsConfig();
  return NextResponse.json({
    versions: config.versions.filter((entry) => entry.enabled).map((entry) => ({
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      transport: entry.transport,
      ...(entry.description ? { description: entry.description } : {}),
    })),
    defaultVersionId: config.defaultVersionId,
    selectedVersionId: sessionId
      ? getSessionAgentVersionId(accountUid, sessionId)
      : getDefaultAgentVersionId(accountUid),
    selectionLocked: Boolean(sessionId),
  });
}

export async function PATCH(req: Request) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const body = await req.json() as { selectedVersionId?: unknown };
  if (typeof body.selectedVersionId !== "string") {
    return NextResponse.json({ error: "selectedVersionId is required" }, { status: 400 });
  }
  const config = getAgentVersionsConfig();
  if (!config.versions.some((entry) => entry.id === body.selectedVersionId && entry.enabled)) {
    return NextResponse.json({ error: "Agent version is unavailable" }, { status: 400 });
  }
  updateAccountPreferences(accountUid, { agentVersionId: body.selectedVersionId });
  return NextResponse.json({ ok: true, selectedVersionId: body.selectedVersionId });
}
