import { NextResponse } from "next/server";
import { getCliBridgeToken, unregisterCliBridge } from "@/lib/cli-bridge";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json() as { clientId?: string; sessionId?: string };
    const pairingToken = getCliBridgeToken(req);
    if (!body.clientId || !body.sessionId || !pairingToken) {
      return NextResponse.json({ error: "clientId, sessionId and pairingToken are required" }, { status: 400 });
    }
    unregisterCliBridge(body.sessionId, body.clientId, pairingToken);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
