"use client";

import { memo, useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { useI18n } from "@/hooks/useI18n";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { GitSourceControl } from "./GitSourceControl";
import { FcnPilotIcon } from "./FcnPilotIcon";
import { FolderIcon } from "./FileIcons";
import type { AttachedDocument } from "@/lib/docqa";
import { textForLanguage, type UiLanguage, type UiText } from "@/lib/i18n";
import { useAppDialog } from "./AppDialogProvider";

interface Props {
  viewMode?: "sessions" | "files" | "source-control";
  accountUid: string;
  accountUsername: string;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  fallbackChatCwd?: string | null;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => void;
  onProjectDirectoryAdded?: (cwd: string) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onPrefetchFile?: (filePath: string) => void;
  onOpenTimeline?: (filePath: string, fileName: string) => void;
  onFileDeleted?: (filePath: string, isDir: boolean) => void;
  onFileMoved?: (previousPath: string, nextPath: string, isDir: boolean) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  sourceControlOpen?: boolean;
  onCloseSourceControl?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onDocQa?: (document: AttachedDocument) => void;
  uiLanguage?: UiLanguage;
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface ProjectDirectoryEntry {
  name: string;
  path: string;
  hidden?: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity used across path spelling variants. */
  projectKey: string;
  checkoutRoot: string | null;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_PREFIX = "pi-web:unread-session-ids:";
const LEGACY_UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const SELECTED_CWD_STORAGE_PREFIX = "pi-web:selected-cwd:";
const SESSION_FOLDERS_STORAGE_PREFIX = "pi-web:session-folders:";
const RUNNING_SESSIONS_POLL_MS = 2500;

interface SessionFolder {
  id: string;
  name: string;
}

interface StoredSessionFolders {
  folders: SessionFolder[];
  assignments: Record<string, string>;
}

function sessionFoldersStorageKey(accountUid: string): string {
  return `${SESSION_FOLDERS_STORAGE_PREFIX}${encodeURIComponent(accountUid)}`;
}

function loadSessionFolders(accountUid: string): StoredSessionFolders {
  if (typeof window === "undefined") return { folders: [], assignments: {} };
  try {
    const raw = window.localStorage.getItem(sessionFoldersStorageKey(accountUid));
    if (!raw) return { folders: [], assignments: {} };
    const parsed = JSON.parse(raw) as Partial<StoredSessionFolders>;
    const folders = Array.isArray(parsed.folders)
      ? parsed.folders.filter((folder): folder is SessionFolder => (
          typeof folder?.id === "string" && typeof folder?.name === "string" && Boolean(folder.name.trim())
        ))
      : [];
    const assignments = parsed.assignments && typeof parsed.assignments === "object"
      ? Object.fromEntries(Object.entries(parsed.assignments).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return { folders, assignments };
  } catch {
    return { folders: [], assignments: {} };
  }
}

function saveSessionFolders(accountUid: string, value: StoredSessionFolders): void {
  if (typeof window === "undefined") return;
  try {
    if (value.folders.length === 0 && Object.keys(value.assignments).length === 0) {
      window.localStorage.removeItem(sessionFoldersStorageKey(accountUid));
    } else {
      window.localStorage.setItem(sessionFoldersStorageKey(accountUid), JSON.stringify(value));
    }
  } catch {
    // Ignore storage quota / privacy-mode errors.
  }
}

function selectedCwdStorageKey(accountUid: string): string {
  return `${SELECTED_CWD_STORAGE_PREFIX}${encodeURIComponent(accountUid)}`;
}

function loadSelectedCwd(accountUid: string, accountUsername: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const uidKey = selectedCwdStorageKey(accountUid);
    const value = window.localStorage.getItem(uidKey);
    if (value?.trim()) return value.trim();

    const legacyKey = `${SELECTED_CWD_STORAGE_PREFIX}${encodeURIComponent(accountUsername)}`;
    const legacyValue = window.localStorage.getItem(legacyKey)?.trim();
    if (!legacyValue) return null;
    window.localStorage.setItem(uidKey, legacyValue);
    window.localStorage.removeItem(legacyKey);
    return legacyValue;
  } catch {
    return null;
  }
}

function unreadSessionsStorageKey(accountUid: string): string {
  return `${UNREAD_SESSIONS_STORAGE_PREFIX}${encodeURIComponent(accountUid)}`;
}

function loadUnreadSessionIds(accountUid: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(unreadSessionsStorageKey(accountUid));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(accountUid: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    const key = unreadSessionsStorageKey(accountUid);
    if (ids.size === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

function migrateLegacyUnreadSessionIds(ownedSessionIds: Set<string>): Set<string> {
  const migrated = new Set<string>();
  if (typeof window === "undefined") return migrated;
  try {
    const raw = window.localStorage.getItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return migrated;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return migrated;
    const remaining: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      if (ownedSessionIds.has(value)) migrated.add(value);
      else remaining.push(value);
    }
    if (remaining.length > 0) {
      window.localStorage.setItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify(remaining));
    } else {
      window.localStorage.removeItem(LEGACY_UNREAD_SESSIONS_STORAGE_KEY);
    }
  } catch {
    // Leave malformed or unavailable legacy storage untouched.
  }
  return migrated;
}

function formatRelativeTime(dateStr: string, text: UiText["sidebar"]): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return text.justNow;
  if (mins < 60) return `${mins}${text.minutesAgo}`;
  if (hours < 24) return `${hours}${text.hoursAgo}`;
  if (days < 7) return `${days}${text.daysAgo}`;
  return date.toLocaleDateString();
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

function SidebarToolbarButton({
  title,
  onClick,
  success = false,
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  success?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`sidebar-toolbar-button${success ? " is-success" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={disabled ? { opacity: 0.38, cursor: "not-allowed" } : undefined}
    >
      {children}
    </button>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}



interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

function AmedacTitle() {
  return (
    <div
      title="FCNPilot"
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        padding: "1px 0", fontWeight: 820, fontSize: 16, letterSpacing: "-0.025em",
        color: "var(--text)",
        minWidth: 0,
        flex: "1 1 auto",
        overflow: "hidden",
      }}
    >
      <FcnPilotIcon size={25} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>FCNPilot</span>
    </div>
  );
}

export const SessionSidebar = memo(function SessionSidebar({
  viewMode = "sessions",
  accountUid,
  accountUsername,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  fallbackChatCwd = null,
  initialSessionId,
  skipInitialProjectSelection,
  onInitialRestoreDone,
  refreshKey,
  onSessionDeleted,
  selectedCwd: selectedCwdProp,
  onCwdChange,
  onProjectDirectoryAdded,
  onOpenFile,
  onPrefetchFile,
  onOpenTimeline,
  onFileDeleted,
  onFileMoved,
  explorerRefreshKey,
  onExplorerRefresh,
  sourceControlOpen = false,
  onCloseSourceControl,
  onAtMention,
  onAtMentions,
  onDocQa,
  uiLanguage = "en",
  onBackgroundTaskDone,
  onRunningSessionIdsChange,
}: Props) {
  const dialog = useAppDialog();
  const { t } = useI18n();
  const uiText = textForLanguage(uiLanguage);
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [storedCwdRestoreDone, setStoredCwdRestoreDone] = useState(Boolean(initialSessionId));
  const [homeDir, setHomeDir] = useState<string>("");
  const [libraryRoot, setLibraryRoot] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const [pathBrowserOpen, setPathBrowserOpen] = useState(false);
  const [pathBrowserPath, setPathBrowserPath] = useState("");
  const [pathBrowserParent, setPathBrowserParent] = useState<string | null>(null);
  const [pathBrowserEntries, setPathBrowserEntries] = useState<ProjectDirectoryEntry[]>([]);
  const [pathBrowserLoading, setPathBrowserLoading] = useState(false);
  const [pathBrowserError, setPathBrowserError] = useState<string | null>(null);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const pathBrowserInputRef = useRef<HTMLInputElement>(null);
  const pathBrowserRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  // Browser-backed state must start from the same snapshot as SSR. Restore it
  // after hydration instead of reading localStorage in a useState initializer.
  const [browserStorageOwner, setBrowserStorageOwner] = useState<string | null>(null);
  const [sessionFolderState, setSessionFolderState] = useState<StoredSessionFolders & { ownerUid: string }>({
    ownerUid: accountUid,
    folders: [],
    assignments: {},
  });
  const [collapsedSessionFolderIds, setCollapsedSessionFolderIds] = useState<Set<string>>(() => new Set());
  const [sessionCollapseKey, setSessionCollapseKey] = useState(0);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  useEffect(() => {
    setSessionFolderState({ ownerUid: accountUid, ...loadSessionFolders(accountUid) });
    setUnreadSessionIds(loadUnreadSessionIds(accountUid));
    setCollapsedSessionFolderIds(new Set());
    setBrowserStorageOwner(accountUid);
  }, [accountUid]);

  useEffect(() => {
    if (browserStorageOwner !== accountUid || sessionFolderState.ownerUid !== accountUid) return;
    saveSessionFolders(accountUid, {
      folders: sessionFolderState.folders,
      assignments: sessionFolderState.assignments,
    });
  }, [accountUid, browserStorageOwner, sessionFolderState]);

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      const legacyUnreadIds = migrateLegacyUnreadSessionIds(existingIds);
      setUnreadSessionIds((prev) => {
        const next = new Set([...prev, ...legacyUnreadIds].filter((id) => existingIds.has(id)));
        if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    if (browserStorageOwner !== accountUid) return;
    saveUnreadSessionIds(accountUid, unreadSessionIds);
  }, [accountUid, browserStorageOwner, unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[] };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }

    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedInBackground.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string; libraryRoot?: string }) => {
      if (d.home) setHomeDir(d.home);
      if (d.libraryRoot) setLibraryRoot(d.libraryRoot);
    }).catch(() => {});
  }, []);

  // Keep the last explicitly selected workspace stable across refreshes. This
  // is account-scoped so switching users never leaks one user's cwd into
  // another user's New page.
  useEffect(() => {
    if (!selectedCwd) return;
    try {
      window.localStorage.setItem(selectedCwdStorageKey(accountUid), selectedCwd);
    } catch {
      // Ignore storage quota / privacy-mode errors.
    }
  }, [accountUid, selectedCwd]);

  // A stored directory may have been renamed or deleted since the last visit.
  // Clear it so the normal recent-project fallback can take over.
  useEffect(() => {
    if (skipInitialProjectSelection) {
      setStoredCwdRestoreDone(true);
      return;
    }
    if (initialSessionId) {
      setStoredCwdRestoreDone(true);
      return;
    }
    const storedCwd = loadSelectedCwd(accountUid, accountUsername);
    if (!storedCwd) {
      setStoredCwdRestoreDone(true);
      return;
    }

    // Restore immediately so a newly-created CLI session cannot become the
    // selected project while validation is in flight.
    setSelectedCwd((current) => current ?? storedCwd);

    let cancelled = false;
    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: storedCwd }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as {
          cwd?: string;
          projectRoot?: string;
          projectKey?: string;
        };
        if (cancelled) return;
        if (response.ok && data.cwd) {
          if (data.projectRoot && data.projectKey) {
            setValidatedProject({ cwd: data.cwd, root: data.projectRoot, key: data.projectKey });
          }
          setSelectedCwd((current) => current === storedCwd ? data.cwd! : current);
          return;
        }
        try {
          window.localStorage.removeItem(selectedCwdStorageKey(accountUid));
        } catch {
          // Ignore storage errors.
        }
        setSelectedCwd((current) => current === storedCwd ? null : current);
      })
      .catch(() => {
        // Keep the stored selection through temporary server/network errors.
      })
      .finally(() => {
        if (!cancelled) setStoredCwdRestoreDone(true);
      });

    return () => { cancelled = true; };
  }, [accountUid, accountUsername, initialSessionId, skipInitialProjectSelection]);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((worktree) => worktree.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [allSessions, projectSelection, validatedProject, worktreeState]);

  // A refresh can hydrate the stable key without changing cwd, so notify when
  // either changes. The shell treats same-cwd key changes as identity hydration.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(selectedCwd, project?.root ?? null, project?.key ?? null);
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; checkoutRoot?: string | null; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          checkoutRoot: d.checkoutRoot ?? null,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (!storedCwdRestoreDone || skipInitialProjectSelection) return;
    if (allSessions.length === 0) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, storedCwdRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const loadPathBrowserDirectory = useCallback(async (directory?: string) => {
    const target = (directory ?? pathBrowserPath ?? selectedCwd ?? libraryRoot ?? homeDir ?? "").trim();
    pathBrowserRequestRef.current?.controller.abort();
    const request = {
      id: (pathBrowserRequestRef.current?.id ?? 0) + 1,
      controller: new AbortController(),
    };
    pathBrowserRequestRef.current = request;
    setPathBrowserLoading(true);
    setPathBrowserError(null);
    try {
      const query = target ? `?path=${encodeURIComponent(target)}` : "";
      const res = await fetch(`/api/directories${query}`, { signal: request.controller.signal });
      const data = await res.json().catch(() => ({})) as {
        path?: string;
        parent?: string | null;
        entries?: ProjectDirectoryEntry[];
        error?: string;
      };

      if (pathBrowserRequestRef.current?.id !== request.id) return;

      if (!res.ok || data.error || !data.path) {
        setPathBrowserError(data.error ?? `HTTP ${res.status}`);
        return;
      }

      setPathBrowserPath(data.path);
      setPathBrowserParent(data.parent ?? null);
      setPathBrowserEntries(data.entries ?? []);
    } catch (e) {
      if (request.controller.signal.aborted) return;
      setPathBrowserError(e instanceof Error ? e.message : String(e));
    } finally {
      if (pathBrowserRequestRef.current?.id === request.id) {
        setPathBrowserLoading(false);
      }
    }
  }, [homeDir, libraryRoot, pathBrowserPath, selectedCwd]);

  const authorizeAndLoadPathBrowserDirectory = useCallback(async (directory: string) => {
    const candidate = directory.trim();
    if (!candidate) return;

    // A path entered explicitly by the user may be a brand-new project root.
    // Authorize it before trying to enumerate its children; otherwise the
    // browser would reject the path even though the Select action accepts it.
    pathBrowserRequestRef.current?.controller.abort();
    const request = {
      id: (pathBrowserRequestRef.current?.id ?? 0) + 1,
      controller: new AbortController(),
    };
    pathBrowserRequestRef.current = request;
    setPathBrowserLoading(true);
    setPathBrowserError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: candidate }),
        signal: request.controller.signal,
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (pathBrowserRequestRef.current?.id !== request.id) return;
      if (!res.ok || data.error) {
        setPathBrowserError(data.error ?? `HTTP ${res.status}`);
        setPathBrowserLoading(false);
        return;
      }
      await loadPathBrowserDirectory(data.cwd ?? candidate);
    } catch (e) {
      if (request.controller.signal.aborted) return;
      setPathBrowserError(e instanceof Error ? e.message : String(e));
      setPathBrowserLoading(false);
    }
  }, [loadPathBrowserDirectory]);

  const openPathBrowser = useCallback((startPath?: string) => {
    const candidate = (startPath?.trim() || customPathValue.trim() || selectedCwd || libraryRoot || homeDir || "~");
    setPathBrowserOpen(true);
    setPathBrowserPath(candidate);
    setDropdownOpen(false);
    setProjectFilter("");
    setCustomPathOpen(false);
    setCustomPathError(null);
    if (startPath?.trim()) {
      void authorizeAndLoadPathBrowserDirectory(candidate);
    } else {
      void loadPathBrowserDirectory(candidate);
    }
    setTimeout(() => pathBrowserInputRef.current?.focus(), 0);
  }, [authorizeAndLoadPathBrowserDirectory, customPathValue, homeDir, libraryRoot, loadPathBrowserDirectory, selectedCwd]);

  useEffect(() => {
    if (!pathBrowserOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPathBrowserOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [pathBrowserOpen]);

  useEffect(() => {
    if (!pathBrowserOpen) pathBrowserRequestRef.current?.controller.abort();
  }, [pathBrowserOpen]);

  useEffect(() => () => pathBrowserRequestRef.current?.controller.abort(), []);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return false;

    setCustomPathValidating(true);
    setCustomPathError(null);
    setPathBrowserError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        const message = data.error ?? `HTTP ${res.status}`;
        setCustomPathError(message);
        if (pathBrowserOpen) setPathBrowserError(message);
        return false;
      }
      const committedPath = data.cwd ?? path;
      setValidatedProject({
        cwd: committedPath,
        root: data.projectRoot ?? committedPath,
        key: data.projectKey ?? data.projectRoot ?? committedPath,
      });
      setSelectedCwd(committedPath);
      onProjectDirectoryAdded?.(committedPath);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
      setPathBrowserOpen(false);
      setPathBrowserError(null);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCustomPathError(message);
      if (pathBrowserOpen) setPathBrowserError(message);
      return false;
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValidating, customPathValue, onProjectDirectoryAdded, pathBrowserOpen]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setTimeout(() => customPathInputRef.current?.focus(), 0);
  }, []);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s);
  }, [onSelectSession]);

  const handleNewSession = useCallback(() => {
    const cwd = selectedCwd ?? fallbackChatCwd;
    if (!cwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd);
  }, [fallbackChatCwd, selectedCwd, onNewSession]);

  const handleCreateSessionFolder = useCallback(async () => {
    const name = (await dialog.prompt({ title: uiText.sidebar.createSessionFolder, defaultValue: uiText.sidebar.sessionFolderName, confirmLabel: uiText.sidebar.createSessionFolder }))?.trim();
    if (!name) return;
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setSessionFolderState((prev) => ({ ...prev, folders: [...prev.folders, { id, name }] }));
  }, [dialog, uiText.sidebar.createSessionFolder, uiText.sidebar.sessionFolderName]);

  const handleAssignSessionFolder = useCallback((sessionId: string, folderId: string | null) => {
    setSessionFolderState((prev) => {
      const assignments = { ...prev.assignments };
      if (folderId) assignments[sessionId] = folderId;
      else delete assignments[sessionId];
      return { ...prev, assignments };
    });
  }, []);

  const handleDeleteSessionFolder = useCallback(async (folderId: string) => {
    if (!await dialog.confirm({ title: uiText.sidebar.deleteSessionFolderConfirm, confirmLabel: uiText.common.delete, danger: true })) return;
    setSessionFolderState((prev) => ({
      ...prev,
      folders: prev.folders.filter((folder) => folder.id !== folderId),
      assignments: Object.fromEntries(Object.entries(prev.assignments).filter(([, assignedFolderId]) => assignedFolderId !== folderId)),
    }));
    setCollapsedSessionFolderIds((prev) => {
      const next = new Set(prev);
      next.delete(folderId);
      return next;
    });
  }, [dialog, uiText.common.delete, uiText.sidebar.deleteSessionFolderConfirm]);

  const recentProjects = getRecentProjects(allSessions);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((project) => project.root.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // The session library is global. The selected project only controls the
  // active workspace; it never filters the list below.
  const selectedProject = projectFor(selectedCwd);
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );
  const filteredSessions = allSessions;
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
            label: uiText.sidebar.openRepoRoot,
            title: uiText.sidebar.openRepoRootTitle,
            targetPath: worktreeState.checkoutRoot && worktreeState.checkoutRoot !== selectedCwd
              ? worktreeState.checkoutRoot
              : null,
          }
        : {
            label: uiText.sidebar.gitRepoRootOnly,
            title: uiText.sidebar.gitRepoRootOnlyTitle,
            targetPath: null,
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
          label: uiText.sidebar.worktrees,
          title: uiText.sidebar.checkingWorktrees,
          targetPath: null,
        }
      : null);

  // Custom folders are a visual organization layer. Parent/fork relations are
  // rebuilt within each group and the underlying session files stay untouched.
  const sessionFolders = sessionFolderState.ownerUid === accountUid ? sessionFolderState.folders : [];
  const sessionFolderAssignments = sessionFolderState.ownerUid === accountUid ? sessionFolderState.assignments : {};
  const validSessionFolderIds = new Set(sessionFolders.map((folder) => folder.id));
  const unfiledSessions = filteredSessions.filter((session) => {
    const folderId = sessionFolderAssignments[session.id];
    return !folderId || !validSessionFolderIds.has(folderId);
  });
  const unfiledSessionTree = buildSessionTree(unfiledSessions);
  const sessionTreesByFolder = new Map(sessionFolders.map((folder) => [
    folder.id,
    buildSessionTree(filteredSessions.filter((session) => sessionFolderAssignments[session.id] === folder.id)),
  ]));
  const workspacePaneOpen = viewMode === "files" && (sourceControlOpen || explorerOpen);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: viewMode === "sessions" ? 10 : 0 }}>
          <AmedacTitle />
        </div>

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative", display: viewMode === "sessions" ? "block" : "none" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject?.root ?? selectedCwd ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedCwd ? (
              <PathLabel
                text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                {initialSessionId && !restoredRef.current ? "" : uiText.sidebar.projectPlaceholder}
              </span>
            )}
            {hasOtherWorkspaceActivity && (
              <span
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
                style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginLeft: 6, background: "var(--accent)" }}
              />
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setProjectFilter("");
                        setDropdownOpen(false);
                      }
                    }}
                    placeholder={uiText.sidebar.filterProjects}
                    autoFocus
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => {
                  const isSelectedProject = project.key === selectedProject?.key;
                  return (
                    <button
                      key={project.key}
                      onClick={() => {
                        setSelectedCwd(project.root);
                        setProjectFilter("");
                        setCustomPathOpen(false);
                        setCustomPathValue("");
                        setCustomPathError(null);
                        setDropdownOpen(false);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "var(--bg)",
                        border: "none",
                        borderBottom: "1px solid var(--border)",
                        color: isSelectedProject ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={project.root}
                    >
                      {isSelectedProject && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <polyline points="1.5 5 4 7.5 8.5 2.5" />
                        </svg>
                      )}
                      {!isSelectedProject && <span style={{ width: 10, flexShrink: 0 }} />}
                      <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                      {showProjectActivity(projectActivity.get(project.key), t)}
                    </button>
                  );
                })}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                  <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{uiText.sidebar.noMatchingProjects}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                  <span>{uiText.sidebar.defaultDirectory}</span>
                </button>
              )}

              {!customPathOpen && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openPathBrowser();
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                    <path d="M3 6.5H7" />
                  </svg>
                  <span>{uiText.sidebar.browseDirectory}</span>
                </button>
              )}

              {/* Custom path entry */}
              {!customPathOpen ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCustomPathClick();
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <line x1="5" y1="1" x2="5" y2="9" />
                    <line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  <span>{uiText.sidebar.customPath}</span>
                </button>
              ) : (
                <div style={{ padding: "6px 8px", borderTop: visibleProjects.length > 0 ? "none" : undefined }}>
                  <input
                    ref={customPathInputRef}
                    value={customPathValue}
                    onChange={(e) => {
                      setCustomPathValue(e.target.value);
                      setCustomPathError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitCustomPath();
                      }
                      if (e.key === "Escape") {
                        setCustomPathOpen(false);
                        setCustomPathValue("");
                        setCustomPathError(null);
                      }
                    }}
                    placeholder="/path/to/project"
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--accent)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                  {customPathError && (
                    <div style={{
                      marginTop: 5,
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {customPathError}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                    <button
                      onClick={() => openPathBrowser(customPathValue.trim())}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        color: "var(--text-muted)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {uiText.sidebar.browse}
                    </button>
                    <button
                      onClick={() => void commitCustomPath()}
                      disabled={customPathValidating || !customPathValue.trim()}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--accent)",
                        border: "none",
                        borderRadius: 5,
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: customPathValidating || !customPathValue.trim() ? "not-allowed" : "pointer",
                        opacity: customPathValidating || !customPathValue.trim() ? 0.65 : 1,
                      }}
                    >
                      {customPathValidating ? uiText.sidebar.checking : uiText.sidebar.open}
                    </button>
                    <button
                      onClick={() => { setCustomPathOpen(false); setCustomPathValue(""); setCustomPathError(null); }}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        color: "var(--text-muted)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {uiText.common.cancel}
                    </button>
                  </div>
                </div>
              )}
          </AnimatedDropdown>
        </div>

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {viewMode === "sessions" && showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((worktree) => (
                worktree.branch ?? displayCwd(worktree.path, homeDir)
              ).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                title={currentWorktree ? `Switch worktree: ${currentWorktree.path}` : "Switch worktree"}
                style={{
                  width: "100%",
                  height: 29,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {currentWorktree?.isMain && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>main</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(event) => setWtFilter(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{ width: "100%", fontSize: 11, fontFamily: "var(--font-mono)", padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" }}
                      />
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              Uncommitted changes. Force remove checkout?
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              Force
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              Cancel
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>main</span>}
                          </button>
                          {!wt.isMain && (
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                              title={`Remove worktree checkout ${wt.path}; the branch is kept`}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 34, height: 28, padding: 0, marginRight: 4,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                                transition: "color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={uiText.sidebar.newWorktree}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                      <span>{uiText.sidebar.newWorktree}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
                          }
                        }}
                        placeholder={uiText.sidebar.branchName}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                          {wtBusy ? uiText.common.creating : uiText.common.create}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                          {uiText.common.cancel}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {viewMode === "sessions" && inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled={!inactiveWorktreeSelector.targetPath}
            tabIndex={inactiveWorktreeSelector.targetPath ? 0 : -1}
            title={inactiveWorktreeSelector.title}
            onClick={() => {
              if (!inactiveWorktreeSelector.targetPath) return;
              setSelectedCwd(inactiveWorktreeSelector.targetPath);
            }}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: inactiveWorktreeSelector.targetPath ? "pointer" : "default",
              opacity: inactiveWorktreeSelector.targetPath ? 1 : 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}

        {viewMode === "sessions" && (
          <button
            type="button"
            className="sidebar-new-session-button"
            title={selectedCwd
              ? `${uiText.sidebar.newSessionTitle} ${selectedCwd}`
              : fallbackChatCwd
                ? (uiLanguage === "zh" ? "新建普通对话" : "New general chat")
                : uiText.sidebar.selectProjectFirst}
            onClick={handleNewSession}
            disabled={browserStorageOwner === null || (!selectedCwd && !fallbackChatCwd)}
          >
            <span className="sidebar-new-session-icon" aria-hidden="true">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 5h14v12H9l-4 3Z" />
                <path d="M12 8v6M9 11h6" />
              </svg>
            </span>
            <span>{uiText.sidebar.newSession}</span>
          </button>
        )}
      </div>

      {/* Session tree toolbar */}
      <div className="sidebar-section-toolbar" style={{
        height: 32,
        padding: "0 6px 0 10px",
        display: viewMode === "sessions" ? "flex" : "none",
        alignItems: "center",
        flexShrink: 0,
        color: "var(--text-muted)",
      }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          {uiText.sidebar.sessions}
        </span>
        <div className="sidebar-toolbar-actions">
          <SidebarToolbarButton title={uiText.common.refresh} success={sessionRefreshDone} onClick={() => loadSessions(false, true)}>
            {sessionRefreshDone ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 12 4 4 8-9" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.2 9A7 7 0 0 0 6 6.5L4 9M5.8 15A7 7 0 0 0 18 17.5l2-2.5" /></svg>
            )}
          </SidebarToolbarButton>
          <SidebarToolbarButton title={uiText.sidebar.createSessionFolder} onClick={handleCreateSessionFolder}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 7h6l2 2h9v9.5h-17Z" />
              <path d="M15.5 11.5v5M13 14h5" />
            </svg>
          </SidebarToolbarButton>
          <SidebarToolbarButton
            title={uiText.sidebar.collapseAllSessions}
            onClick={() => {
              setCollapsedSessionFolderIds(new Set(sessionFolders.map((folder) => folder.id)));
              setSessionCollapseKey((key) => key + 1);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 10 5-5 5 5M7 16l5-5 5 5" />
            </svg>
          </SidebarToolbarButton>
        </div>
      </div>

      {/* Session list */}
      <div style={{
        flex: workspacePaneOpen && (selectedCwdProp || selectedCwd) ? "0 1 auto" : "1 1 auto",
        maxHeight: workspacePaneOpen && (selectedCwdProp || selectedCwd) ? "38%" : undefined,
        overflowY: "auto",
        padding: "0",
        minHeight: workspacePaneOpen && (selectedCwdProp || selectedCwd) ? 54 : 80,
        display: viewMode === "sessions" ? "block" : "none",
      }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("application/x-pi-session-id")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          const sessionId = event.dataTransfer.getData("application/x-pi-session-id");
          if (sessionId) handleAssignSessionFolder(sessionId, null);
        }}
      >
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {uiText.common.loading}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && filteredSessions.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {uiText.sidebar.noSessionsFound}
          </div>
        )}
        {sessionFolders.map((folder) => (
          <SessionFolderGroup
            key={folder.id}
            folder={folder}
            nodes={sessionTreesByFolder.get(folder.id) ?? []}
            collapsed={collapsedSessionFolderIds.has(folder.id)}
            onToggle={() => setCollapsedSessionFolderIds((prev) => {
              const next = new Set(prev);
              if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id);
              return next;
            })}
            onDropSession={(sessionId) => handleAssignSessionFolder(sessionId, folder.id)}
            onDelete={() => handleDeleteSessionFolder(folder.id)}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            onSelectSession={handleSelectSessionFromList}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id);
              loadSessions();
            }}
            collapseKey={sessionCollapseKey}
            uiText={uiText}
          />
        ))}
        {unfiledSessionTree.map((node) => (
          <SessionTreeItem
            key={node.session.id}
            node={node}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            onSelectSession={handleSelectSessionFromList}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id);
              loadSessions();
            }}
            depth={0}
            collapseKey={sessionCollapseKey}
            uiText={uiText}
          />
        ))}
      </div>

      {/* File Explorer section */}
      {viewMode === "files" && (selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: workspacePaneOpen ? "1 1 auto" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div className="sidebar-section-toolbar" style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((open) => {
                const next = !open;
                saveExplorerOpen(next);
                return next;
              })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {uiText.sidebar.explorer}
            </button>
            <div className="sidebar-toolbar-actions" style={{ marginRight: 6 }}>
              {explorerOpen && changesCount > 0 && (
                <SidebarToolbarButton
                  title={t("sidebar.changedFiles", { count: changesCount })}
                  onClick={() => setChangesCollapsed((collapsed) => !collapsed)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" />
                  </svg>
                </SidebarToolbarButton>
              )}
              {explorerOpen && (
                <SidebarToolbarButton
                  title={t("sidebar.uploadFilesTitle")}
                  disabled={explorerUploadBusy}
                  onClick={() => fileExplorerRef.current?.openUploadPicker()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5M12 3v12" />
                  </svg>
                </SidebarToolbarButton>
              )}
              <SidebarToolbarButton
                title={uiText.files.searchFiles}
                onClick={() => {
                  setExplorerOpen(true);
                  fileExplorerRef.current?.toggleSearch();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <circle cx="10.8" cy="10.8" r="6.3" /><path d="m20 20-4.7-4.7" />
                </svg>
              </SidebarToolbarButton>
              <SidebarToolbarButton
                title={uiText.files.newFileInRoot}
                onClick={() => {
                  setExplorerOpen(true);
                  fileExplorerRef.current?.createFile();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3.5h8l4 4V20H6Z" /><path d="M14 3.5V8h4M12 11v6M9 14h6" />
                </svg>
              </SidebarToolbarButton>
              <SidebarToolbarButton
                title={uiText.files.newFolderInRoot}
                onClick={() => {
                  setExplorerOpen(true);
                  fileExplorerRef.current?.createDirectory();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3.5 7h6l2 2h9v9.5h-17Z" /><path d="M15.5 11.5v5M13 14h5" />
                </svg>
              </SidebarToolbarButton>
              <SidebarToolbarButton title={uiText.sidebar.collapseAllFiles} onClick={() => fileExplorerRef.current?.collapseAll()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m7 10 5-5 5 5M7 16l5-5 5 5" />
                </svg>
              </SidebarToolbarButton>
              <SidebarToolbarButton
                title={uiText.sidebar.refreshExplorer}
                success={explorerRefreshDone}
                onClick={() => {
                  if (onExplorerRefresh) onExplorerRefresh();
                  else setExplorerKey((key) => key + 1);
                  setExplorerRefreshDone(true);
                  if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                  explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
                }}
              >
                {explorerRefreshDone ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 12 4 4 8-9" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.2 9A7 7 0 0 0 6 6.5L4 9M5.8 15A7 7 0 0 0 18 17.5l2-2.5" />
                  </svg>
                )}
              </SidebarToolbarButton>
            </div>
          </div>
          <div style={{ flex: explorerOpen ? "1 1 55%" : "0 0 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", display: explorerOpen ? "block" : "none" }}>
              <FileExplorer
                ref={fileExplorerRef}
                accountUid={accountUid}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                onPrefetchFile={onPrefetchFile}
                onOpenTimeline={onOpenTimeline}
                onFileDeleted={onFileDeleted}
                onFileMoved={onFileMoved}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                onDocQa={onDocQa}
                uiLanguage={uiLanguage}
              />
          </div>
        </div>
      )}

      {viewMode === "source-control" && (selectedCwdProp || selectedCwd) && (
        <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
          <GitSourceControl
            cwd={selectedCwd ?? selectedCwdProp!}
            onOpenFile={onOpenFile ?? (() => {})}
            onClose={onCloseSourceControl}
            refreshKey={explorerKey + (explorerRefreshKey ?? 0)}
            uiLanguage={uiLanguage}
          />
        </div>
      )}

      {pathBrowserOpen && (
        <div
          onMouseDown={() => setPathBrowserOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
            background: "rgba(15,23,42,0.34)",
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 92vw)",
              maxHeight: "min(720px, 86vh)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              boxShadow: "0 24px 80px rgba(0,0,0,0.28)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "14px 16px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{uiText.sidebar.chooseProjectDirectory}</div>
                <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>
                  {uiText.sidebar.directoryPickerHint}
                </div>
              </div>
              <button
                onClick={() => setPathBrowserOpen(false)}
                title={uiText.sidebar.close}
                style={{
                  width: 30,
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <line x1="3" y1="3" x2="11" y2="11" />
                  <line x1="11" y1="3" x2="3" y2="11" />
                </svg>
              </button>
            </div>

            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => pathBrowserParent && void loadPathBrowserDirectory(pathBrowserParent)}
                  disabled={!pathBrowserParent || pathBrowserLoading}
                  title={pathBrowserParent ? `${uiText.sidebar.goTo} ${pathBrowserParent}` : uiText.sidebar.alreadyAtRoot}
                  style={{
                    height: 32,
                    padding: "0 10px",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    color: !pathBrowserParent || pathBrowserLoading ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: !pathBrowserParent || pathBrowserLoading ? "not-allowed" : "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  {uiText.sidebar.up}
                </button>
                <button
                  onClick={() => void loadPathBrowserDirectory(libraryRoot || homeDir || "~")}
                  disabled={pathBrowserLoading}
                  style={{
                    height: 32,
                    padding: "0 10px",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    color: pathBrowserLoading ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: pathBrowserLoading ? "not-allowed" : "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  {uiText.sidebar.sharedFiles}
                </button>
                <input
                  ref={pathBrowserInputRef}
                  value={pathBrowserPath}
                  onChange={(e) => {
                    setPathBrowserPath(e.target.value);
                    setPathBrowserError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void authorizeAndLoadPathBrowserDirectory(pathBrowserPath);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setPathBrowserOpen(false);
                    }
                  }}
                  placeholder="/path/to/project"
                  style={{
                    minWidth: 0,
                    flex: 1,
                    height: 32,
                    boxSizing: "border-box",
                    padding: "0 10px",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                  }}
                />
                <button
                  onClick={() => void authorizeAndLoadPathBrowserDirectory(pathBrowserPath)}
                  disabled={pathBrowserLoading || !pathBrowserPath.trim()}
                  style={{
                    height: 32,
                    padding: "0 12px",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    color: pathBrowserLoading || !pathBrowserPath.trim() ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: pathBrowserLoading || !pathBrowserPath.trim() ? "not-allowed" : "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  {uiText.sidebar.go}
                </button>
              </div>
              {pathBrowserError && (
                <div style={{ marginTop: 8, color: "#dc2626", fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere" }}>
                  {pathBrowserError}
                </div>
              )}
            </div>

            <div style={{ flex: 1, minHeight: 220, overflowY: "auto", background: "var(--bg-panel)" }}>
              {pathBrowserLoading ? (
                <div style={{ padding: 18, color: "var(--text-muted)", fontSize: 12 }}>{uiText.sidebar.loadingDirectories}</div>
              ) : pathBrowserEntries.length === 0 ? (
                <div style={{ padding: 18, color: "var(--text-muted)", fontSize: 12 }}>
                  {uiText.sidebar.noSubdirectories}
                </div>
              ) : (
                pathBrowserEntries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => void loadPathBrowserDirectory(entry.path)}
                    title={entry.path}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "9px 16px",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: entry.hidden ? "var(--text-dim)" : "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 12,
                      contentVisibility: "auto",
                      containIntrinsicSize: "33px",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--accent)" }}>
                      <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h2.25L6.5 4H11a1.5 1.5 0 0 1 1.5 1.5V10A1.5 1.5 0 0 1 11 11.5H3A1.5 1.5 0 0 1 1.5 10V4Z" />
                    </svg>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>
                      {entry.name}
                    </span>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                      <polyline points="4 2.5 7.5 6 4 9.5" />
                    </svg>
                  </button>
                ))
              )}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "12px 16px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg)",
              }}
            >
              <PathLabel
                text={pathBrowserPath ? displayCwd(pathBrowserPath, homeDir) : uiText.sidebar.noDirectorySelected}
                style={{ flex: 1, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}
              />
              <button
                onClick={() => setPathBrowserOpen(false)}
                style={{
                  height: 32,
                  padding: "0 12px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {uiText.common.cancel}
              </button>
              <button
                onClick={() => void commitCustomPath(pathBrowserPath)}
                disabled={pathBrowserLoading || customPathValidating || !pathBrowserPath.trim()}
                style={{
                  height: 32,
                  padding: "0 14px",
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 7,
                  color: "#fff",
                  cursor: pathBrowserLoading || customPathValidating || !pathBrowserPath.trim() ? "not-allowed" : "pointer",
                  opacity: pathBrowserLoading || customPathValidating || !pathBrowserPath.trim() ? 0.65 : 1,
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {customPathValidating ? uiText.sidebar.checking : uiText.sidebar.selectDirectory}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function countSessionTree(nodes: SessionTreeNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countSessionTree(node.children), 0);
}

function SessionFolderGroup({
  folder,
  nodes,
  collapsed,
  onToggle,
  onDropSession,
  onDelete,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  collapseKey,
  uiText,
}: {
  folder: SessionFolder;
  nodes: SessionTreeNode[];
  collapsed: boolean;
  onToggle: () => void;
  onDropSession?: (sessionId: string) => void;
  onDelete?: () => void;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  collapseKey: number;
  uiText: UiText;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const count = countSessionTree(nodes);

  return (
    <div
      onDragEnter={(event) => {
        if (!onDropSession || !event.dataTransfer.types.includes("application/x-pi-session-id")) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!onDropSession || !event.dataTransfer.types.includes("application/x-pi-session-id")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        const sessionId = event.dataTransfer.getData("application/x-pi-session-id");
        if (sessionId) onDropSession?.(sessionId);
      }}
      style={{
        margin: "0 4px",
        borderRadius: 4,
        background: dragOver ? "color-mix(in srgb, var(--accent) 7%, transparent)" : "transparent",
        boxShadow: dragOver ? "inset 0 0 0 1px var(--accent)" : "none",
        transition: "background 0.12s, box-shadow 0.12s",
      }}
    >
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ display: "flex", alignItems: "center", height: 26, background: hovered && !dragOver ? "var(--bg-hover)" : "transparent", borderRadius: 4 }}
      >
        <button
          type="button"
          onClick={onToggle}
          title={folder.name}
          style={{
            minWidth: 0, flex: 1, height: 26, padding: "0 5px",
            display: "flex", alignItems: "center", gap: 4,
            background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left",
          }}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}>
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <FolderIcon size={14} open={!collapsed} />
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
            {folder.name}
          </span>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{count}</span>
        </button>
        {hovered && onDelete && <button
          type="button"
          onClick={onDelete}
          title={uiText.sidebar.deleteSessionFolder}
          aria-label={uiText.sidebar.deleteSessionFolder}
          style={{
            width: 22, height: 20, marginRight: 2, padding: 0,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "none", border: "none", borderRadius: 4,
            color: "var(--text-dim)", cursor: "pointer", fontSize: 15,
          }}
        >
          ×
        </button>}
      </div>
      {!collapsed && (
        <div style={{ paddingBottom: nodes.length === 0 ? 5 : 2 }}>
          {nodes.map((node) => (
            <SessionTreeItem
              key={node.session.id}
              node={node}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={1}
              collapseKey={collapseKey}
              uiText={uiText}
            />
          ))}
          {nodes.length === 0 && (
            <div style={{ padding: "5px 26px", color: "var(--text-dim)", fontSize: 10 }}>
              {uiText.sidebar.noSessionsFound}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  collapseKey,
  uiText,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  collapseKey: number;
  uiText: UiText;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  useEffect(() => {
    if (collapseKey > 0) setCollapsed(true);
  }, [collapseKey]);

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-pi-session-id", node.session.id);
        event.dataTransfer.setData("text/plain", node.session.id);
      }}
    >
      <div className="session-tree-row" style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          uiText={uiText}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              collapseKey={collapseKey}
              uiText={uiText}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator({ label }: { label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator({ label }: { label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/** Compact per-project activity badges for the workspace selector. */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  uiText,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  uiText: UiText;
}) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Select only after the rename input has mounted. The click handler's state
  // update is asynchronous, so an immediate select() can race the render.
  useEffect(() => {
    if (!renaming) return;
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
  }, [renaming]);

  // The SDK stores expanded skill invocations as XML. Show the compact slash
  // command the user entered instead of leaking the expansion into the title.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [displayFirstMessage, session.id, session.name, session.transient]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (session.transient) return;
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path, session.transient]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 50;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid #ef4444"
          : isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {uiText.common.delete} <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {uiText.common.delete}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {uiText.common.cancel}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 13,
                fontWeight: isSelected ? 600 : 500,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={isRunning ? `${title} · ${uiText.sidebar.agentRunning}` : isUnread ? `${title} · ${uiText.sidebar.newActivity}` : title}
            >
              {isRunning ? <RunningSessionIndicator label={uiText.sidebar.agentRunning} /> : isUnread ? <UnreadSessionIndicator label={uiText.sidebar.newActivity} /> : null}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
            </div>
            <div style={{ marginTop: 2, display: "flex", gap: 8, color: "var(--text-dim)", fontSize: 10.5, minWidth: 0 }}>
              <span title={session.modified}>{formatRelativeTime(session.modified, uiText.sidebar)}</span>
              <span>{session.messageCount} {uiText.sidebar.messageCount}</span>
              {session.worktreeBranch && (
                <span
                  title={`Worktree: ${session.cwd}`}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span>
                </span>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? uiText.sidebar.expandForks : uiText.sidebar.collapseForks}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover */}
          {hovered && !session.transient && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title={uiText.sidebar.rename}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title={`${uiText.common.delete} (Shift+click: ${uiText.common.delete})`}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
