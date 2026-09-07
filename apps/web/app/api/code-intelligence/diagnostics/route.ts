import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NextResponse } from "next/server";
import { getClangdManager } from "@/lib/clangd-manager";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { getCurrentAccountUid } from "@/lib/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CPP_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".m", ".mm"]);
const MAX_CONTENT_BYTES = 512 * 1024;

export async function POST(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as { filePath?: string; cwd?: string; content?: string };
    if (typeof body.filePath !== "string" || typeof body.cwd !== "string" || typeof body.content !== "string") {
      return NextResponse.json({ error: "filePath, cwd and content are required" }, { status: 400 });
    }
    if (!CPP_EXTENSIONS.has(path.extname(body.filePath).toLowerCase())) {
      return NextResponse.json({ diagnostics: [] });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_CONTENT_BYTES) {
      return NextResponse.json({ error: "File is too large for C++ diagnostics" }, { status: 413 });
    }
    const roots = await getAllowedFileRoots(accountUid);
    if (!isFilePathAllowed(body.filePath, roots) || !isFilePathAllowed(body.cwd, roots)) {
      return NextResponse.json({ error: "Path is outside the allowed project roots" }, { status: 403 });
    }
    if (
      !fs.existsSync(body.filePath)
      || fs.lstatSync(body.filePath).isSymbolicLink()
      || !fs.statSync(body.filePath).isFile()
    ) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    const manager = getClangdManager(body.cwd);
    await manager.sync(body.filePath, body.content);
    await delay(180);
    return NextResponse.json({ diagnostics: manager.getDiagnostics(body.filePath) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
