import { NextResponse } from "next/server";
import type { AppUpdateResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

/** FCNPilot is installed from its own repository, without an upstream binary channel. */
export function GET() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0";
  return NextResponse.json({
    currentVersion: version,
    latestVersion: version,
    updateAvailable: false,
    releaseUrl: "",
  } satisfies AppUpdateResponse);
}
