import { NextResponse } from "next/server";
import { homedir } from "os";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getAccountWorkspaceRoot, getPrimarySharedFileRoot } from "@/lib/file-access";

export async function GET() {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  return NextResponse.json({
    home: homedir(),
    libraryRoot: getPrimarySharedFileRoot(),
    privateRoot: getAccountWorkspaceRoot(accountUid),
  });
}
