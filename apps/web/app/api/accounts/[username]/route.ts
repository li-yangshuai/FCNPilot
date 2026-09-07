import { NextResponse } from "next/server";

export async function DELETE() {
  return NextResponse.json(
    { error: "Account deletion is unavailable in shared workspace mode" },
    { status: 410 },
  );
}
