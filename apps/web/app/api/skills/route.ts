import { NextResponse } from "next/server";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "node:path";
import { DefaultResourceLoader, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillInfo } from "@/lib/api-types";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getActiveAgentDir } from "@/lib/agent-suite";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function nearestExistingAncestor(filePath: string): string {
  let candidate = filePath;
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

async function getSkillMutationRoots(accountUid: string): Promise<Set<string>> {
  const roots = new Set(await getAllowedFileRoots(accountUid));
  roots.add(getActiveAgentDir(accountUid));
  const globalSkillsDir = path.join(homedir(), ".agents", "skills");
  if (existsSync(globalSkillsDir)) roots.add(globalSkillsDir);
  return roots;
}

async function isSkillPathAllowed(filePath: string, accountUid: string): Promise<boolean> {
  if (!filePath.toLowerCase().endsWith(".md") || !filePath.replace(/\\/g, "/").includes("/skills/")) return false;
  // Never mutate the cached file API allow-list with the agent directory.
  const roots = await getSkillMutationRoots(accountUid);
  return isExistingFilePathAllowed(filePath, roots);
}

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const allowedRoots = await getAllowedFileRoots(accountUid, cwd);
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "cwd is outside this account's allowed workspaces" }, { status: 403 });
  }

  try {
    const agentDir = getActiveAgentDir(accountUid);
    const trustAgentDir = getAgentDir();
    const loader = new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload(projectTrustReloadOptions(cwd, trustAgentDir));
    const { skills, diagnostics } = loader.getSkills();
    return NextResponse.json({
      skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }),
      diagnostics,
      projectResourcesLoaded: getProjectTrustStatus(cwd, trustAgentDir).trusted,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    if (!await isSkillPathAllowed(filePath, accountUid)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });

    const content = readFileSync(filePath, "utf8");
    const key = "disable-model-invocation";

    // Use parseFrontmatter to check current value, then do a surgical line edit
    // to preserve the original YAML formatting of all other fields.
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const alreadySet = Boolean(frontmatter[key]);

    let updated = content;
    if (disableModelInvocation && !alreadySet) {
      // Add key after the opening --- line
      updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
      // If no frontmatter exists, create one
      if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
    } else if (!disableModelInvocation && alreadySet) {
      // Remove the key line entirely
      updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
    }

    writeFileSync(filePath, updated, "utf8");
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST /api/skills — scaffold a user or project Skill that is immediately
// discoverable by both pi-web and the Pi CLI.
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
    const body = await req.json() as {
      cwd?: string;
      scope?: "global" | "project";
      name?: string;
      description?: string;
      instructions?: string;
    };
    const name = body.name?.trim().toLowerCase() ?? "";
    if (!SKILL_NAME_RE.test(name)) {
      return NextResponse.json({ error: "Skill name must use lowercase letters, numbers, hyphens, or underscores" }, { status: 400 });
    }
    const description = body.description?.trim() ?? "";
    if (!description || description.length > 500) {
      return NextResponse.json({ error: "Description is required and must be at most 500 characters" }, { status: 400 });
    }
    const instructions = body.instructions?.trim() || `# ${name}\n\nDescribe the workflow, references, scripts, and expected output here.`;
    if (instructions.length > 100_000) {
      return NextResponse.json({ error: "Skill instructions are too large" }, { status: 413 });
    }

    let baseDir: string;
    let creationRoots: Set<string>;
    if (body.scope === "project") {
      if (!body.cwd) return NextResponse.json({ error: "cwd is required for a project Skill" }, { status: 400 });
      const roots = await getAllowedFileRoots(accountUid, body.cwd);
      if (!isExistingFilePathAllowed(body.cwd, roots) || !existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
        return NextResponse.json({ error: "Invalid project cwd" }, { status: 403 });
      }
      if (!getProjectTrustStatus(body.cwd, getAgentDir()).trusted) {
        return NextResponse.json({ error: "Project resources must be trusted before creating project Skills" }, { status: 403 });
      }
      baseDir = path.join(body.cwd, ".pi", "skills", name);
      creationRoots = roots;
    } else {
      baseDir = path.join(getActiveAgentDir(accountUid), "skills", name);
      creationRoots = await getSkillMutationRoots(accountUid);
    }
    const filePath = path.join(baseDir, "SKILL.md");
    if (existsSync(filePath)) {
      return NextResponse.json({ error: "A Skill with this name already exists in that scope" }, { status: 409 });
    }
    const existingAncestor = nearestExistingAncestor(baseDir);
    if (!isFilePathAllowed(baseDir, creationRoots) || !isExistingFilePathAllowed(existingAncestor, creationRoots)) {
      return NextResponse.json({ error: "Skill path is outside this account's allowed workspaces" }, { status: 403 });
    }
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const content = [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description)}`,
      "---",
      "",
      instructions,
      "",
    ].join("\n");
    writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
    return NextResponse.json({ success: true, filePath });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

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
    const body = await req.json() as { filePath?: string };
    if (!body.filePath || !await isSkillPathAllowed(body.filePath, accountUid)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (path.basename(body.filePath).toLowerCase() !== "skill.md") {
      return NextResponse.json({ error: "Only directory-based Skills can be deleted" }, { status: 400 });
    }
    if (!existsSync(body.filePath)) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    const parent = path.dirname(body.filePath);
    if (path.basename(parent).toLowerCase() === "skills") {
      return NextResponse.json({ error: "Refusing to delete the Skills root" }, { status: 400 });
    }
    if (lstatSync(body.filePath).isSymbolicLink() || lstatSync(parent).isSymbolicLink()) {
      return NextResponse.json({ error: "Refusing to delete a symbolic link" }, { status: 403 });
    }
    rmSync(parent, { recursive: true, force: false });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
