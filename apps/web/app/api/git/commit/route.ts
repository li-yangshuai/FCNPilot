import { execFile } from "child_process";
import { access, realpath, stat } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{4,64}$/i;

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 12_000,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  return String(stdout);
}

export async function GET(request: Request) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const search = new URL(request.url).searchParams;
  const requestedCwd = search.get("cwd")?.trim();
  const requestedCommit = search.get("commit")?.trim();
  if (!requestedCwd || !requestedCommit) {
    return NextResponse.json({ error: "cwd and commit are required" }, { status: 400 });
  }
  if (!COMMIT_PATTERN.test(requestedCommit)) {
    return NextResponse.json({ error: "Invalid commit id" }, { status: 400 });
  }

  try {
    const cwd = await realpath(path.resolve(requestedCwd));
    if (!(await stat(cwd)).isDirectory()) {
      return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots(accountUid, cwd);
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const repositoryRoot = await realpath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
    if (!isFilePathAllowed(repositoryRoot, allowedRoots)) {
      return NextResponse.json({ error: "Repository root is outside the allowed project roots" }, { status: 403 });
    }

    const fullHash = (await runGit(repositoryRoot, ["rev-parse", "--verify", `${requestedCommit}^{commit}`])).trim();
    const [metadataOutput, filesOutput] = await Promise.all([
      runGit(repositoryRoot, [
        "show",
        "-s",
        "--date=iso-strict",
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b",
        fullHash,
      ]),
      runGit(repositoryRoot, ["show", "--format=", "--name-status", "-M", fullHash]),
    ]);

    const [hash, shortHash, author, email, date, subject, ...bodyParts] = metadataOutput.trimEnd().split("\x1f");
    const rawFiles = filesOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [statusCode = "", firstPath = "", secondPath] = line.split("\t");
        const renamed = statusCode.startsWith("R") || statusCode.startsWith("C");
        const filePath = renamed ? secondPath ?? firstPath : firstPath;
        const previousPath = renamed ? firstPath : undefined;
        return { status: statusCode, path: filePath, previousPath };
      })
      .filter((file) => file.path);

    const files = (await Promise.all(rawFiles.map(async (file) => {
      const absolutePath = path.resolve(repositoryRoot, file.path);
      if (!isFilePathAllowed(absolutePath, allowedRoots)) return null;
      let exists = false;
      try {
        await access(absolutePath);
        exists = true;
      } catch {
        exists = false;
      }
      return { ...file, absolutePath, exists };
    }))).filter((file): file is NonNullable<typeof file> => file !== null);

    return NextResponse.json({
      hash: hash || fullHash,
      shortHash: shortHash || requestedCommit,
      author,
      email,
      date,
      subject,
      body: bodyParts.join("\x1f").trim(),
      files,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
