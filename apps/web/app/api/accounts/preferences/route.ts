import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import {
  getAccountPreferences,
  updateAccountPreferences,
  type AccountPreferencesPatch,
} from "@/lib/account-preferences";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export async function GET() {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    return NextResponse.json({ preferences: getAccountPreferences(accountUid) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const patch = await request.json() as AccountPreferencesPatch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return NextResponse.json({ error: "Invalid preferences" }, { status: 400 });
    }
    // Agent suites may contain settings and extensions that execute with the
    // Web service user's permissions. Only the dedicated, trust-aware endpoint
    // may change this preference.
    if (Object.prototype.hasOwnProperty.call(patch, "agentSuitePath")) {
      return NextResponse.json(
        { error: "Use /api/agent-suite to change the Agent suite" },
        { status: 400 },
      );
    }
    return NextResponse.json({ preferences: updateAccountPreferences(accountUid, patch) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
