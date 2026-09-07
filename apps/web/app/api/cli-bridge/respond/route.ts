import { NextResponse } from "next/server";
import { getCliBridgeToken, resolveCliCommand } from "@/lib/cli-bridge";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      clientId?: string;
      sessionId?: string;
      commandId?: string;
      success?: boolean;
      data?: unknown;
      error?: string;
    };
    const pairingToken = getCliBridgeToken(req);
    if (!body.clientId || !body.sessionId || !pairingToken || !body.commandId || typeof body.success !== "boolean") {
      return NextResponse.json(
        { error: "clientId, sessionId, pairingToken, commandId and success are required" },
        { status: 400 },
      );
    }
    const accepted = resolveCliCommand(body.sessionId, body.clientId, pairingToken, body.commandId, {
      success: body.success,
      data: body.data,
      error: body.error,
    });
    return NextResponse.json({ success: true, accepted });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
