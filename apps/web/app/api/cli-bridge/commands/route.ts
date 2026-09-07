import { NextResponse } from "next/server";
import { getCliBridgeToken, waitForCliCommands } from "@/lib/cli-bridge";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get("clientId");
  const sessionId = searchParams.get("sessionId");
  const pairingToken = getCliBridgeToken(req);
  if (!clientId || !sessionId || !pairingToken) {
    return NextResponse.json({ error: "clientId, sessionId and pairingToken are required" }, { status: 400 });
  }

  const commands = await waitForCliCommands(sessionId, clientId, pairingToken);
  if (commands === null) {
    return NextResponse.json({ error: "CLI bridge is not registered" }, { status: 404 });
  }
  return NextResponse.json({ commands });
}
