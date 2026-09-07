import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Login is disabled; this deployment uses one shared workspace" },
    { status: 410 },
  );
}
