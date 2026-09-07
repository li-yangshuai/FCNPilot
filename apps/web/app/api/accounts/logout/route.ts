import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Logout is unavailable in shared workspace mode" },
    { status: 410 },
  );
}
