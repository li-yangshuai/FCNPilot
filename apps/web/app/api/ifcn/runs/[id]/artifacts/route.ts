import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import {
  authorizeIfcnResults, ifcnArtifactHeaders, IfcnResultsError, readIfcnArtifact,
} from "@/lib/ifcn-results";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const root = await authorizeIfcnResults(await getCurrentAccountUid() ?? "");
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const result = readIfcnArtifact(root, id, query.get("name") ?? "");
    return new Response(new Uint8Array(result.bytes), {
      headers: ifcnArtifactHeaders(result.artifact, query.get("preview") === "1"),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取电路结果文件" },
      { status: error instanceof IfcnResultsError ? error.status : 500 });
  }
}
