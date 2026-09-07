import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getAllowedFileRoots, getPrimarySharedFileRoot, isFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

function resolveDirectoryPath(input: string | null): string {
  const raw = (input ?? getPrimarySharedFileRoot()).trim();
  if (!raw || raw === "~") return homedir();
  if (raw.startsWith("~/")) return path.resolve(homedir(), raw.slice(2));
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(homedir(), raw);
}

// GET /api/directories?path=/some/path
// Returns directory children only, for the local project picker UI.
export async function GET(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const targetPath = resolveDirectoryPath(searchParams.get("path"));
    const allowedRoots = await getAllowedFileRoots(accountUid, targetPath);
    if (!isFilePathAllowed(targetPath, allowedRoots)) {
      return NextResponse.json({ error: "Directory is not assigned to the current account" }, { status: 403 });
    }
    const targetStat = await stat(targetPath);

    if (!targetStat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${targetPath}` }, { status: 400 });
    }

    const directoryEntries = await readdir(targetPath, { withFileTypes: true });
    const entries = (await Promise.all(directoryEntries.map(async (entry): Promise<DirectoryEntry | null> => {
      const fullPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        return { name: entry.name, path: fullPath, hidden: entry.name.startsWith(".") };
      }
      if (!entry.isSymbolicLink()) return null;

      // Keep usable in-root directory links, but do not let a stale network
      // mount or broken link delay the complete picker.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const linkedStat = await Promise.race([
          stat(fullPath),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 250);
          }),
        ]);
        if (!linkedStat?.isDirectory() || !isFilePathAllowed(fullPath, allowedRoots)) return null;
        return { name: entry.name, path: fullPath, hidden: entry.name.startsWith(".") };
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }))).filter((entry): entry is DirectoryEntry => entry !== null);

    entries.sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    const parent = path.dirname(targetPath);
    return NextResponse.json({
      path: targetPath,
      parent: parent !== targetPath && isFilePathAllowed(parent, allowedRoots) ? parent : null,
      entries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
