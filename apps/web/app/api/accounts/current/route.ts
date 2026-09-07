import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/accounts";

export async function GET() {
  try {
    const account = await getCurrentAccount();
    return NextResponse.json({
      uid: account?.uid ?? null,
      username: account?.username ?? null,
      account: account ? { uid: account.uid, username: account.username } : null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
