import { mkdirSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { allowFileRoot, getAccountWorkspaceRoot } from "@/lib/file-access";
import { getIfcnWorkspace } from "@/lib/ifcn-workspace";

// A stable, account-scoped working directory for conversations that are not
// attached to a user-selected project. Pi still requires a real cwd internally,
// but the UI does not treat this directory as an opened workspace.
export async function POST() {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }
    const workspace = await getIfcnWorkspace(accountUid);
    if (workspace.configured) {
      // Selecting the workspace does not grant project trust. The existing
      // trust dialog remains responsible for enabling local code execution.
      if (workspace.cwd && (workspace.available || workspace.trusted === false)) {
        return NextResponse.json(workspace);
      }
      return NextResponse.json({ ...workspace, error: workspace.message ?? "iFCN 工程当前不可用" }, { status: 503 });
    }
    const cwd = join(getAccountWorkspaceRoot(accountUid), "general-chat");
    mkdirSync(cwd, { recursive: true });
    allowFileRoot(accountUid, cwd);
    return NextResponse.json({ cwd });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
