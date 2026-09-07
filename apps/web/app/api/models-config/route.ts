import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { markModelConfigChanged } from "@/lib/model-config-revision";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!await getCurrentAccountUid()) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  return NextResponse.json(readModelsConfig());
}

export async function PUT(req: Request) {
  try {
    if (!await getCurrentAccountUid()) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await req.json() as Record<string, unknown>;
    writeModelsConfig(body);
    markModelConfigChanged();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
