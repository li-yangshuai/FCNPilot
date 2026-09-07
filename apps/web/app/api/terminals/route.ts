import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { createWebTerminal } from "@/lib/web-terminal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as { cwd?: string; cols?: number; rows?: number };
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const terminal = await createWebTerminal(accountUid, body.cwd, body.cols, body.rows);
    return NextResponse.json(terminal, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
