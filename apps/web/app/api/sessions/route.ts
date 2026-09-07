import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { filterSessionIdsForAccount, filterSessionsForAccount, getCurrentAccountUid } from "@/lib/accounts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }

    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(filterSessionsForAccount(getRpcSessionInfos(), accountUid)),
    ]);
    const sessions = mergeSessionLists(
      filterSessionsForAccount(persistedSessions, accountUid),
      runtimeSessions,
    );
    return NextResponse.json(
      {
        sessions,
        runningSessionIds: filterSessionIdsForAccount(getRunningRpcSessionIds(), accountUid),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
