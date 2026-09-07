import path from "path";
import { existsSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { listAllSessions } from "./session-reader";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { filterSessionsForAccount } from "./accounts";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { isWindowsAbsolutePath } from "./paths";
import { getPiWebConfigDir } from "./pi-web-paths";
import { SHARED_ACCOUNT_UID } from "./shared-workspace";
export { isWindowsAbsolutePath };

// Short-TTL cache for Session-derived roots. Shared projects and explicit
// account roots take a synchronous fast path; stale Session roots remain usable
// while one background refresh runs. Stored on globalThis so the cache and
// single-flight lock survive Next.js hot-reload.
declare global {
  var __amedacAllowedRootsCache: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
  var __amedacAllowedRootsRefreshes: Map<string, Promise<Set<string>>> | undefined;
  var __amedacAdditionalAllowedRoots: Map<string, Set<string>> | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 30_000;

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function getAdditionalAllowedRoots(accountUid: string): Set<string> {
  if (!(globalThis.__amedacAdditionalAllowedRoots instanceof Map)) {
    globalThis.__amedacAdditionalAllowedRoots = new Map();
  }
  let roots = globalThis.__amedacAdditionalAllowedRoots.get(accountUid);
  if (!roots) {
    roots = new Set();
    globalThis.__amedacAdditionalAllowedRoots.set(accountUid, roots);
  }
  return roots;
}

export function allowFileRoot(accountUidOrRoot: string, maybeRoot?: string): void {
  const accountUid = maybeRoot === undefined ? SHARED_ACCOUNT_UID : accountUidOrRoot;
  const root = maybeRoot ?? accountUidOrRoot;
  if (!accountUid || !root) return;
  const normalizedRoot = normalizeSlashes(root);
  if (!isAccountPrivateRootAllowed(accountUid, normalizedRoot)) return;
  getAdditionalAllowedRoots(accountUid).add(normalizedRoot);
  if (!(globalThis.__amedacAllowedRootsCache instanceof Map)) globalThis.__amedacAllowedRootsCache = new Map();
  globalThis.__amedacAllowedRootsCache.get(accountUid)?.roots.add(normalizedRoot);
}

export function revokeFileRootsForAccount(accountUid: string): void {
  globalThis.__amedacAdditionalAllowedRoots?.delete(accountUid);
  globalThis.__amedacAllowedRootsCache?.delete(accountUid);
  globalThis.__amedacAllowedRootsRefreshes?.delete(accountUid);
}

export function getAccountWorkspaceRoot(accountUid: string): string {
  return path.join(homedir(), "pi-web-workspaces", accountUid);
}

function resolveComparable(filePath: string): string {
  const resolved = path.resolve(filePath);
  let existingAncestor = resolved;
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return resolved;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    return path.join(realpathSync(existingAncestor), ...missingSegments);
  } catch {
    return resolved;
  }
}

function isInsideComparablePath(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isInsidePath(target: string, root: string): boolean {
  return isInsideComparablePath(resolveComparable(target), resolveComparable(root));
}

function isAccountPrivateRootAllowed(accountUid: string, target: string): boolean {
  const privateContainer = path.join(homedir(), "pi-web-workspaces");
  if (!isInsidePath(target, privateContainer)) return true;
  return isInsidePath(target, getAccountWorkspaceRoot(accountUid));
}

function normalizeSharedRoot(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/")
      ? path.join(homedir(), trimmed.slice(2))
      : path.resolve(trimmed);
  try {
    return statSync(expanded).isDirectory() ? normalizeSlashes(expanded) : null;
  } catch {
    return null;
  }
}

/**
 * Authenticated accounts share ordinary project files. Deployments can set a
 * platform-delimited PI_WEB_SHARED_ROOTS list; otherwise use the conventional
 * local project library and always include the directory pi-web was launched
 * from so an existing checkout remains reachable after account migration.
 */
export function getSharedFileRoots(): string[] {
  const configured = process.env.PI_WEB_SHARED_ROOTS;
  const candidates = configured
    ? configured.split(path.delimiter)
    : [path.join(homedir(), "projects"), process.cwd()];
  const roots = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeSharedRoot(candidate);
    if (normalized) roots.add(normalized);
  }
  return [...roots];
}

export function getPrimarySharedFileRoot(): string {
  return getSharedFileRoots()[0] ?? normalizeSlashes(process.cwd());
}

/** Internal capability check for the CLI bridge; raw session files are never
 * exposed through the generic browser/file-library allow-list. */
export function isPathInsidePiSessions(target: string): boolean {
  return isInsidePath(target, path.join(getAgentDir(), "sessions"));
}

function getBaseAllowedFileRoots(accountUid: string): Set<string> {
  const roots = new Set<string>();
  for (const root of getAdditionalAllowedRoots(accountUid)) {
    if (isAccountPrivateRootAllowed(accountUid, root)) roots.add(root);
  }

  // Every account has one deterministic private workspace root. This remains
  // stable across server restarts without letting the browser self-authorize
  // arbitrary host paths.
  roots.add(normalizeSlashes(getAccountWorkspaceRoot(accountUid)));

  // Project files are intentionally shared between authenticated accounts;
  // account identity, preferences, and session ownership remain UID-scoped.
  for (const root of getSharedFileRoots()) roots.add(root);

  // User-authored Agent and Skill sources are editable from their management
  // panels. Do not expose the whole agent directory (which also contains
  // auth.json); only these two resource directories are allowed.
  roots.add(normalizeSlashes(path.join(getAgentDir(), "agents")));
  roots.add(normalizeSlashes(path.join(getAgentDir(), "skills")));
  return roots;
}

async function rebuildAllowedFileRoots(accountUid: string): Promise<Set<string>> {
  if (!(globalThis.__amedacAllowedRootsRefreshes instanceof Map)) {
    globalThis.__amedacAllowedRootsRefreshes = new Map();
  }
  const activeRefresh = globalThis.__amedacAllowedRootsRefreshes.get(accountUid);
  if (activeRefresh) return activeRefresh;

  const refresh = (async () => {
    const roots = getBaseAllowedFileRoots(accountUid);
    const sessions = filterSessionsForAccount(await listAllSessions(), accountUid);
    for (const session of sessions) {
      if (session.cwd && isAccountPrivateRootAllowed(accountUid, session.cwd)) {
        roots.add(normalizeSlashes(session.cwd));
      }
    }
    // A project/worktree may be authorized while Session discovery is in
    // flight. Merge the latest base roots before publishing the rebuilt set.
    for (const root of getBaseAllowedFileRoots(accountUid)) roots.add(root);

    if (!(globalThis.__amedacAllowedRootsCache instanceof Map)) globalThis.__amedacAllowedRootsCache = new Map();
    globalThis.__amedacAllowedRootsCache.set(accountUid, {
      roots,
      expiresAt: Date.now() + ALLOWED_ROOTS_TTL_MS,
    });
    return roots;
  })();
  globalThis.__amedacAllowedRootsRefreshes.set(accountUid, refresh);
  try {
    return await refresh;
  } finally {
    if (globalThis.__amedacAllowedRootsRefreshes.get(accountUid) === refresh) {
      globalThis.__amedacAllowedRootsRefreshes.delete(accountUid);
    }
  }
}

/**
 * Returns the roots available to an account.
 *
 * Passing the target path enables a cheap fast path for shared projects,
 * account workspaces, and the explicit Agent/Skill authoring roots. These
 * common locations do not need a full Session scan just to expand a folder.
 * Expired Session-derived roots are refreshed in the background so a file
 * browser request never blocks on unrelated Session/Git discovery.
 */
export async function getAllowedFileRoots(
  accountUid: string = SHARED_ACCOUNT_UID,
  targetPath?: string,
): Promise<Set<string>> {
  if (!accountUid) return new Set();
  const baseRoots = getBaseAllowedFileRoots(accountUid);
  if (targetPath && isFilePathAllowed(targetPath, baseRoots)) return baseRoots;

  const now = Date.now();
  if (!(globalThis.__amedacAllowedRootsCache instanceof Map)) globalThis.__amedacAllowedRootsCache = new Map();
  const cached = globalThis.__amedacAllowedRootsCache.get(accountUid);
  if (cached) {
    // Keep roots added by the current process visible even while an older
    // Session-derived cache is being refreshed.
    for (const root of baseRoots) cached.roots.add(root);
    if (cached.expiresAt <= now) {
      void rebuildAllowedFileRoots(accountUid).catch(() => {
        // The last known safe set remains usable; a later request retries.
      });
    }
    return cached.roots;
  }

  return rebuildAllowedFileRoots(accountUid);
}

export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  // A broad shared root (for example the user's home directory) must not make
  // every account-private workspace visible. Access to a UID workspace is
  // granted only when that exact workspace root is present in this account's
  // allowed set; getAllowedFileRoots adds only the current account's root.
  const privateContainer = path.join(homedir(), "pi-web-workspaces");
  const comparableTarget = resolveComparable(target);

  // The browser must never receive Pi Web's own state. It contains the shared
  // account/preferences store, MCP headers, CLI metadata, and other secrets.
  // Check both lexical and canonical forms: the former protects not-yet-created
  // children, while the latter rejects aliases that enter through a symlink.
  const piWebConfigDir = getPiWebConfigDir();
  const targetCandidates = new Set([path.resolve(target), comparableTarget]);
  const configCandidates = new Set([path.resolve(piWebConfigDir), resolveComparable(piWebConfigDir)]);
  if ([...targetCandidates].some((candidate) => (
    [...configCandidates].some((configDir) => isInsideComparablePath(candidate, configDir))
  ))) return false;

  // Even an intentionally broad shared root must not expose pi's credential,
  // account, preference, or raw-session files. The two authoring directories
  // used by their dedicated panels remain available. Raw session files use a
  // separate internal CLI-bridge capability and never enter this allow-list.
  const agentDir = resolveComparable(getAgentDir());
  const agentRelative = path.relative(agentDir, comparableTarget);
  const isInsideAgentDir = agentRelative === ""
    || (!agentRelative.startsWith(`..${path.sep}`) && agentRelative !== ".." && !path.isAbsolute(agentRelative));
  if (isInsideAgentDir) {
    const explicitlyShareableRoots = [
      path.join(agentDir, "agents"),
      path.join(agentDir, "skills"),
    ].map(resolveComparable);
    const authorizedSensitiveRoot = explicitlyShareableRoots.find((root) => isInsidePath(comparableTarget, root));
    if (!authorizedSensitiveRoot) return false;
    const hasExactSensitiveRoot = [...allowedRoots].some((root) => resolveComparable(root) === authorizedSensitiveRoot);
    if (!hasExactSensitiveRoot) return false;
  }

  const comparablePrivateContainer = resolveComparable(privateContainer);
  const privateRelative = path.relative(comparablePrivateContainer, comparableTarget);
  const isPrivateTarget = privateRelative === ""
    || (!privateRelative.startsWith(`..${path.sep}`) && privateRelative !== ".." && !path.isAbsolute(privateRelative));
  if (isPrivateTarget) {
    const relative = privateRelative;
    const accountSegment = relative.split(path.sep).filter(Boolean)[0];
    if (!accountSegment) return false;
    const accountRoot = resolveComparable(path.join(privateContainer, accountSegment));
    const hasExactAccountRoot = [...allowedRoots].some((root) => resolveComparable(root) === accountRoot);
    if (!hasExactAccountRoot) return false;
  }

  // Canonicalize existing targets so a lexical child cannot escape through a
  // symlink. Creation routes validate an existing parent separately.
  return existsSync(target)
    ? isExistingPathWithinRoots(target, allowedRoots)
    : isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isFilePathAllowed(target, allowedRoots)
    && isExistingPathWithinRoots(target, allowedRoots);
}
