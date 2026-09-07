import { NextResponse } from "next/server";
import { getCliBridgeToken, publishCliEvents } from "@/lib/cli-bridge";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      clientId?: string;
      sessionId?: string;
      events?: Record<string, unknown>[];
    };
    const pairingToken = getCliBridgeToken(req);
    if (!body.clientId || !body.sessionId || !pairingToken || !Array.isArray(body.events)) {
      return NextResponse.json({ error: "clientId, sessionId, pairingToken and events are required" }, { status: 400 });
    }
    const accepted = publishCliEvents(body.sessionId, body.clientId, pairingToken, body.events);
    return NextResponse.json({ success: true, registered: accepted });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
