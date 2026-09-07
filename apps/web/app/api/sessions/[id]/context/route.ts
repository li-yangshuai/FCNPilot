import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { accountOwnsSession, getCurrentAccountUid } from "@/lib/accounts";
import { getHistoricalContextUsage } from "@/lib/historical-context-usage";
import { getRpcSession } from "@/lib/rpc-manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");

  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }
    if (!accountOwnsSession(accountUid, id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(filePath!);
    const context = buildSessionContext(sm.getEntries() as never, leafId, {
      deferThinking,
      deferToolResultImages,
    });
    const contextUsage = await getHistoricalContextUsage(sm, leafId, accountUid);

    return NextResponse.json({ context, contextUsage });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
