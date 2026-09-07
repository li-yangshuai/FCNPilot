import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getIfcnWorkspace } from "@/lib/ifcn-workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  try {
    return NextResponse.json(await getIfcnWorkspace(accountUid));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
