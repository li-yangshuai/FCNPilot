import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";

const execFileAsync = promisify(execFile);

interface GitStatusEntry {
  path: string;
  absolutePath: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  changed: boolean;
  untracked: boolean;
  conflicted: boolean;
  deleted: boolean;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 12_000,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  return String(stdout);
}

function isConflict(indexStatus: string, worktreeStatus: string): boolean {
  const pair = `${indexStatus}${worktreeStatus}`;
  return indexStatus === "U"
    || worktreeStatus === "U"
    || ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(pair);
}

function parseStatus(output: string, repositoryRoot: string): GitStatusEntry[] {
  const records = output.split("\0");
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;

    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    if (indexStatus === "!" && worktreeStatus === "!") continue;

    const relativePath = record.slice(3);
    if (!relativePath) continue;

    let originalPath: string | undefined;
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      originalPath = records[index + 1] || undefined;
      index += 1;
    }

    const untracked = indexStatus === "?" && worktreeStatus === "?";
    const conflicted = isConflict(indexStatus, worktreeStatus);
    entries.push({
      path: relativePath,
      absolutePath: path.resolve(repositoryRoot, relativePath),
      originalPath,
      indexStatus,
      worktreeStatus,
      staged: !untracked && !conflicted && indexStatus !== " ",
      changed: !untracked && !conflicted && worktreeStatus !== " ",
      untracked,
      conflicted,
      deleted: indexStatus === "D" || worktreeStatus === "D",
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function GET(request: NextRequest) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  try {
    const requestedCwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!requestedCwd || (!requestedCwd.startsWith("/") && !isWindowsAbsolutePath(requestedCwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    let cwd: string;
    let cwdStat: fs.Stats;
    try {
      cwd = fs.realpathSync(path.resolve(requestedCwd));
      cwdStat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!cwdStat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots(accountUid, cwd);
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let repositoryRoot: string;
    try {
      repositoryRoot = fs.realpathSync((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
    } catch {
      return NextResponse.json({
        available: false,
        root: null,
        branch: null,
        ahead: 0,
        behind: 0,
        entries: [],
        graph: [],
        counts: { conflicts: 0, staged: 0, changed: 0, untracked: 0 },
        isGitRepository: false,
        repositoryRoot: null,
        files: [],
        additions: 0,
        deletions: 0,
      });
    }

    if (
      !isFilePathAllowed(repositoryRoot, allowedRoots)
      || !isExistingFilePathAllowed(repositoryRoot, allowedRoots)
    ) {
      return NextResponse.json(
        { error: "Repository root is outside the allowed project roots" },
        { status: 403 },
      );
    }

    const [fileExplorerStatus, statusOutput, branchResult, trackingResult, graphOutput] = await Promise.all([
      getGitStatus(cwd),
      runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      runGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(async () => {
        const commit = (await runGit(repositoryRoot, ["rev-parse", "--short", "HEAD"])).trim();
        return commit ? `detached@${commit}` : "detached";
      }),
      runGit(repositoryRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => ""),
      runGit(repositoryRoot, [
        "log",
        "--graph",
        "--decorate",
        "--date=short",
        "--pretty=format:%h%x09%ad%x09%s%x09%d",
        "--all",
        "-n",
        "80",
      ]).catch(() => ""),
    ]);

    const trackingCounts = trackingResult.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    const behind = Number.isFinite(trackingCounts[0]) ? trackingCounts[0] : 0;
    const ahead = Number.isFinite(trackingCounts[1]) ? trackingCounts[1] : 0;
    const entries = parseStatus(statusOutput, repositoryRoot)
      .filter((entry) => isFilePathAllowed(entry.absolutePath, allowedRoots));

    return NextResponse.json({
      ...fileExplorerStatus,
      available: true,
      root: repositoryRoot,
      branch: branchResult.trim() || "detached",
      ahead,
      behind,
      entries,
      graph: graphOutput.split(/\r?\n/).filter(Boolean),
      counts: {
        conflicts: entries.filter((entry) => entry.conflicted).length,
        staged: entries.filter((entry) => entry.staged).length,
        changed: entries.filter((entry) => entry.changed).length,
        untracked: entries.filter((entry) => entry.untracked).length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
