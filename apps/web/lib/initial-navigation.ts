export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
}

export function getInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
  defaultCwd: string | null = null,
): InitialNavigation {
  const explicitCwd = searchParams.get("cwd")?.trim() || null;
  const explicitSession = searchParams.get("session")?.trim() || null;
  const requestedCwd = explicitCwd || (!explicitSession ? defaultCwd?.trim() || null : null);

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : explicitSession,
  };
}
