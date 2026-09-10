import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { authorizeIfcnResults, IfcnResultsError, listIfcnRuns } from "@/lib/ifcn-results";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const root = await authorizeIfcnResults(await getCurrentAccountUid() ?? "");
    return NextResponse.json(listIfcnRuns(root), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取电路运行列表" },
      { status: error instanceof IfcnResultsError ? error.status : 500 });
  }
}
