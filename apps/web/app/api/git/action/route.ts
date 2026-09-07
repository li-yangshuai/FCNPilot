import { execFile } from "child_process";
import { realpath, rm, stat } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";

const execFileAsync = promisify(execFile);
const MAX_PATHS = 500;
const MAX_COMMIT_MESSAGE_LENGTH = 10_000;

type GitAction = "stage" | "unstage" | "discard" | "commit";

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  return String(stdout).trim();
}

async function resolveRepository(accountUid: string, requestedCwd: string) {
  const cwd = await realpath(path.resolve(requestedCwd));
  if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory");

  const allowedRoots = await getAllowedFileRoots(accountUid, cwd);
  if (!isFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");

  const repositoryRoot = await realpath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
  if (!isFilePathAllowed(repositoryRoot, allowedRoots)) {
    throw new Error("Repository root is outside the allowed project roots");
  }
  return { repositoryRoot, allowedRoots };
}

function validatePaths(rawPaths: unknown, repositoryRoot: string, allowedRoots: Set<string>): string[] {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_PATHS) {
    throw new Error(`paths must contain between 1 and ${MAX_PATHS} entries`);
  }

  return [...new Set(rawPaths.map((rawPath) => {
    if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("Invalid Git path");
    const normalized = path.posix.normalize(rawPath.trim().replace(/\\/g, "/"));
    if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error("Git path must stay inside the repository");
    }
    const absolutePath = path.resolve(repositoryRoot, ...normalized.split("/"));
    const relative = path.relative(repositoryRoot, absolutePath);
    if (
      relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || !isFilePathAllowed(absolutePath, allowedRoots)
    ) {
      throw new Error("Git path is outside the allowed repository");
    }
    return normalized;
  }))];
}

async function discardPaths(repositoryRoot: string, paths: string[]): Promise<void> {
  const tracked: string[] = [];
  const untracked: string[] = [];

  for (const filePath of paths) {
    try {
      await runGit(repositoryRoot, ["ls-files", "--error-unmatch", "--", filePath]);
      tracked.push(filePath);
    } catch {
      untracked.push(filePath);
    }
  }

  if (tracked.length > 0) {
    await runGit(repositoryRoot, ["restore", "--worktree", "--", ...tracked]);
  }
  for (const filePath of untracked) {
    await rm(path.resolve(repositoryRoot, ...filePath.split("/")), { recursive: true, force: true });
  }
}

export async function POST(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

    const body = await request.json() as {
      cwd?: unknown;
      action?: unknown;
      paths?: unknown;
      message?: unknown;
    };
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!["stage", "unstage", "discard", "commit"].includes(String(body.action))) {
      return NextResponse.json({ error: "Unsupported Git action" }, { status: 400 });
    }

    const action = body.action as GitAction;
    const { repositoryRoot, allowedRoots } = await resolveRepository(accountUid, body.cwd);
    let output = "";

    if (action === "commit") {
      if (typeof body.message !== "string") throw new Error("Commit message is required");
      const message = body.message.trim();
      if (!message || message.length > MAX_COMMIT_MESSAGE_LENGTH) {
        throw new Error(`Commit message must contain between 1 and ${MAX_COMMIT_MESSAGE_LENGTH} characters`);
      }
      output = await runGit(repositoryRoot, ["commit", "-m", message]);
    } else {
      const paths = validatePaths(body.paths, repositoryRoot, allowedRoots);
      if (action === "stage") {
        output = await runGit(repositoryRoot, ["add", "-A", "--", ...paths]);
      } else if (action === "unstage") {
        try {
          output = await runGit(repositoryRoot, ["reset", "-q", "HEAD", "--", ...paths]);
        } catch {
          output = await runGit(repositoryRoot, ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths]);
        }
      } else {
        await discardPaths(repositoryRoot, paths);
      }
    }

    return NextResponse.json({ ok: true, output });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
