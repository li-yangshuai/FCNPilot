import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { closeWebTerminal, getWebTerminal, resizeWebTerminal, writeWebTerminal } from "@/lib/web-terminal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { id } = await params;
    if (!getWebTerminal(accountUid, id)) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    const body = await request.json() as { data?: string; cols?: number; rows?: number };
    if (typeof body.data === "string" && body.data) writeWebTerminal(accountUid, id, body.data.slice(0, 64 * 1024));
    if (typeof body.cols === "number" && typeof body.rows === "number") {
      resizeWebTerminal(accountUid, id, body.cols, body.rows);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const { id } = await params;
  if (!closeWebTerminal(accountUid, id)) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
