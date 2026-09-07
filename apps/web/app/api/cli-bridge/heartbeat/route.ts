import { NextResponse } from "next/server";
import { getCliBridgeToken, touchCliBridge, type CliBridgeRegistration } from "@/lib/cli-bridge";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      clientId?: string;
      sessionId?: string;
      state?: Partial<CliBridgeRegistration>;
    };
    const pairingToken = getCliBridgeToken(req);
    if (!body.clientId || !body.sessionId || !pairingToken) {
      return NextResponse.json({ error: "clientId, sessionId and pairingToken are required" }, { status: 400 });
    }
    const found = touchCliBridge(body.sessionId, body.clientId, pairingToken, body.state);
    return NextResponse.json({ success: true, registered: found });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
