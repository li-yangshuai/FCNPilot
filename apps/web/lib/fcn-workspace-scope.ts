/** Lexical browser-side view scoping, not a filesystem authorization boundary. */
function normalizedAbsolutePath(value: string): string | null {
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
  const path = value.replace(/\\/g, "/");
  if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = (path.startsWith("/") ? "/" : "") + segments.join("/");
  return windows ? normalized.toLowerCase() : normalized;
}

export function isWithinFcnWorkspace(cwd: string | null | undefined, workspace: string): boolean {
  if (!cwd) return false;
  const root = normalizedAbsolutePath(workspace);
  const candidate = normalizedAbsolutePath(cwd);
  return root !== null && candidate !== null
    && (candidate === root || candidate.startsWith(root.endsWith("/") ? root : root + "/"));
}

export function sessionsForFcnWorkspace<T extends { cwd: string }>(sessions: T[], workspace?: string | null): T[] {
  return workspace ? sessions.filter((session) => isWithinFcnWorkspace(session.cwd, workspace)) : sessions;
}

export function cwdForFcnWorkspace(cwd: string | null | undefined, workspace?: string | null): string | null {
  return workspace ? (isWithinFcnWorkspace(cwd, workspace) ? cwd! : workspace) : cwd ?? null;
}
