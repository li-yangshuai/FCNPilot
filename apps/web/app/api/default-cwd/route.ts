import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { join } from "path";
import { allowFileRoot, getAccountWorkspaceRoot } from "@/lib/file-access";
import { getCurrentAccountUid } from "@/lib/accounts";

// POST /api/default-cwd
// Creates an account-scoped ~/pi-web-workspaces/<uid>/<YYYYMMDD> and returns it.
export async function POST() {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = join(getAccountWorkspaceRoot(accountUid), date);
    mkdirSync(dir, { recursive: true });
    allowFileRoot(accountUid, dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
