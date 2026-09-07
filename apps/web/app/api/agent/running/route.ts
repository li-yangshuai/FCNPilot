import { NextResponse } from "next/server";
import { filterSessionIdsForAccount, getCurrentAccountUid } from "@/lib/accounts";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  return NextResponse.json(
    { runningSessionIds: filterSessionIdsForAccount(getRunningRpcSessionIds(), accountUid) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
