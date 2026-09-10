import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { readIfcnWorkspaceConfiguration } from "@/lib/ifcn-workspace";
import { FCN_AGENT_ID } from "@/lib/fcn-agent-policy";
import { CustomAgentFileError, listCustomAgents } from "@/lib/custom-agent-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const workspace = readIfcnWorkspaceConfiguration();
    const agents = workspace.valid && workspace.cwd ? await listCustomAgents(workspace.cwd, accountUid) : [];
    return NextResponse.json({ agents, defaultAgentId: FCN_AGENT_ID });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof CustomAgentFileError ? error.status : 500 });
  }
}
