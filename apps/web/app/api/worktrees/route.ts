import { NextResponse } from "next/server";
import { existsSync } from "fs";
import {
  addWorktree,
  findCurrentWorktreePath,
  getCheckoutRoot,
  listWorktrees,
  removeWorktree,
  resolveProject,
} from "@/lib/worktree";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { getCurrentAccountUid } from "@/lib/accounts";
import { projectIdentityKey } from "@/lib/project-identity";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(
  cwd: string,
  accountUid: string,
  requireExisting = false,
): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots(accountUid, cwd);
  if (
    !isFilePathAllowed(cwd, allowedRoots)
    || ((requireExisting || existsSync(cwd)) && !isExistingFilePathAllowed(cwd, allowedRoots))
  ) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

// GET /api/worktrees?cwd=  →  { projectRoot, projectKey, isGit, isTopLevel, currentWorktreePath, worktrees }
export async function GET(req: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd, accountUid);
    if (denied) return denied;

    const project = await resolveProject(cwd);
    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let checkoutRoot: string | null = null;
    let currentWorktreePath: string | null = null;
    let isGit = true;
    try {
      // For a removed-worktree cwd (session of a deleted worktree), fall back
      // to the inferred project root so the switcher still shows the project.
      worktrees = await listWorktrees(existsSync(cwd) ? cwd : project.projectRoot);
      checkoutRoot = await getCheckoutRoot(existsSync(cwd) ? cwd : project.projectRoot);
    } catch {
      isGit = false;
    }
    // `git worktree list` includes every checkout attached to the repository,
    // including checkouts assigned to other Web accounts. Listing must never
    // turn those paths into new permissions; return only paths that were
    // already authorized for the current UID.
    const allowedRoots = await getAllowedFileRoots(accountUid);
    worktrees = worktrees.filter((worktree) => (
      isFilePathAllowed(worktree.path, allowedRoots)
      && isExistingFilePathAllowed(worktree.path, allowedRoots)
    ));
    currentWorktreePath = findCurrentWorktreePath(worktrees, cwd);
    if (
      checkoutRoot
      && (!isFilePathAllowed(checkoutRoot, allowedRoots) || !isExistingFilePathAllowed(checkoutRoot, allowedRoots))
    ) {
      checkoutRoot = null;
    }
    return NextResponse.json({
      projectRoot: project.projectRoot,
      checkoutRoot,
      projectKey: projectIdentityKey(project.projectRoot),
      isGit,
      isTopLevel: project.isTopLevel,
      currentWorktreePath,
      worktrees,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/worktrees  body: { cwd, branch }  →  { path, branch }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await req.json() as { cwd?: string; branch?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.branch || typeof body.branch !== "string") {
      return NextResponse.json({ error: "branch is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd, accountUid, true);
    if (denied) return denied;
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }

    const result = await addWorktree(body.cwd, body.branch, accountUid);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/worktrees  body: { cwd, path, force? }
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await req.json() as { cwd?: string; path?: string; force?: boolean };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.path || typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd, accountUid, true);
    if (denied) return denied;
    const targetDenied = await checkCwdAllowed(body.path, accountUid, true);
    if (targetDenied) return targetDenied;

    await removeWorktree(body.cwd, body.path, body.force === true);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // git refuses to remove dirty worktrees without --force; surface that so
    // the UI can offer a force-remove confirmation.
    const dirty = /contains modified or untracked files|is dirty/i.test(message);
    return NextResponse.json({ error: message, dirty }, { status: dirty ? 409 : 400 });
  }
}
