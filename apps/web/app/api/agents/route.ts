import { NextResponse } from "next/server";
import type { CustomAgent, CustomAgentScope } from "@/lib/custom-agents";
import { getCurrentAccountUid } from "@/lib/accounts";
import { IFCN_AGENT_ID, isIfcnWorkspace } from "@/lib/ifcn-workspace";
import {
  createCustomAgent,
  CustomAgentFileError,
  deleteCustomAgent,
  listCustomAgents,
  updateCustomAgent,
} from "@/lib/custom-agent-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: error instanceof CustomAgentFileError ? error.status : 500 },
  );
}

export async function GET(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const cwd = new URL(request.url).searchParams.get("cwd");
    const agents = await listCustomAgents(cwd, accountUid);
    const defaultAgentId = isIfcnWorkspace(cwd) && agents.some((agent) => agent.id === IFCN_AGENT_ID)
      ? IFCN_AGENT_ID : undefined;
    return NextResponse.json({ agents, ...(defaultAgentId ? { defaultAgentId } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as { cwd?: string; agent?: Partial<CustomAgent> };
    const agent = await createCustomAgent(body.cwd, accountUid, body.agent ?? {});
    return NextResponse.json({ success: true, agent });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as {
      cwd?: string;
      original?: { name?: string; scope?: CustomAgentScope; mtimeMs?: number };
      agent?: Partial<CustomAgent>;
    };
    const agent = await updateCustomAgent(
      body.cwd,
      accountUid,
      body.original ?? {},
      body.agent ?? {},
    );
    return NextResponse.json({ success: true, agent });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as { cwd?: string; name?: string; scope?: CustomAgentScope };
    await deleteCustomAgent(body.cwd, accountUid, body.name, body.scope);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
