import { NextResponse } from "next/server";
import { getCurrentAccount, listAccounts } from "@/lib/accounts";

export async function GET() {
  try {
    const account = await getCurrentAccount();
    if (!account) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }
    const accounts = listAccounts().map(({ uid, username }) => ({ uid, username }));
    return NextResponse.json({ accounts });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
