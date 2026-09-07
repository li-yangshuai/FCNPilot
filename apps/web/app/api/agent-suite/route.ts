import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getAccountPreferences, updateAccountPreferences } from "@/lib/account-preferences";
import { inspectAgentSuite, trustAgentSuite } from "@/lib/agent-suite";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const configuredPath = getAccountPreferences(accountUid).agentSuitePath;
    const defaultSuite = inspectAgentSuite(getAgentDir());
    let suite = defaultSuite;
    let warning: string | undefined;
    if (configuredPath) {
      try {
        suite = inspectAgentSuite(configuredPath);
        if (!suite.trusted) {
          warning = "The configured Agent suite is inactive until you explicitly trust it";
        }
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error);
      }
    }
    return NextResponse.json({ suite, defaultPath: defaultSuite.path, configuredPath, warning });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as { path?: unknown; trust?: unknown };
    if (typeof body.path !== "string") throw new Error("Agent suite path is required");
    let suite = inspectAgentSuite(body.path);
    if (!suite.trusted) {
      if (body.trust !== true) {
        return NextResponse.json({
          error: "Trust this Agent suite before loading its settings and executable extensions",
          requiresTrust: true,
          suite,
        }, { status: 409 });
      }
      suite = trustAgentSuite(suite.path);
    }
    updateAccountPreferences(accountUid, {
      agentSuitePath: suite.isDefault ? null : suite.path,
      selectedAgentId: null,
    });
    return NextResponse.json({ success: true, suite });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    updateAccountPreferences(accountUid, { agentSuitePath: null, selectedAgentId: null });
    return NextResponse.json({ success: true, suite: inspectAgentSuite(getAgentDir()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
