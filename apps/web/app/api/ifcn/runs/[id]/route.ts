import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { authorizeIfcnResults, IfcnResultsError, readIfcnRun } from "@/lib/ifcn-results";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const root = await authorizeIfcnResults(await getCurrentAccountUid() ?? "");
    const { id } = await params;
    return NextResponse.json(readIfcnRun(root, id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取电路运行结果" },
      { status: error instanceof IfcnResultsError ? error.status : 500 });
  }
}
