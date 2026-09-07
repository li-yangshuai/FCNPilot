import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { discoverSubagents } from "@/lib/subagents";
import { getActiveAgentDir } from "@/lib/agent-suite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function validateCwd(value: string | null, accountUid: string): Promise<string> {
  if (!value) throw new Error("cwd is required");
  const cwd = path.resolve(value);
  if (!isFilePathAllowed(cwd, await getAllowedFileRoots(accountUid))) {
    throw new Error("cwd is outside the allowed project roots");
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error("cwd is not a directory");
  }
  return cwd;
}

export async function GET(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const cwd = await validateCwd(new URL(request.url).searchParams.get("cwd"), accountUid);
    return NextResponse.json(discoverSubagents(cwd, getActiveAgentDir(accountUid)));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
