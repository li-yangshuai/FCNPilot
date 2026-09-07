"use client";

import { Fragment, forwardRef, useState, useCallback, useRef, useEffect, useLayoutEffect, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow, CodeGenerationPane, type CodeArtifactsPanelState } from "./ChatWindow";
import { IfcnWorkspaceBar, useIfcnWorkspace } from "./IfcnWorkspace";
import { FileViewer, preloadCodeEditor, preloadFileContent } from "./FileViewer";
import { FileTimeline, type TimelineEntry } from "./FileTimeline";
import { FileRevisionViewer } from "./FileRevisionViewer";
import { IntegratedTerminal, type TerminalOpenRequest } from "./IntegratedTerminal";
import { useAppDialog } from "./AppDialogProvider";
import { TabBar, type Tab } from "./TabBar";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { BranchNavigator } from "./BranchNavigator";
import { FcnPilotIcon } from "./FcnPilotIcon";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { getInitialNavigation } from "@/lib/initial-navigation";
import {
  clearLastOpen,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import type { FileViewerState } from "@/lib/file-viewer-state";
import type { AccountPinnedActivityItem } from "@/lib/account-preferences";
import { SHARED_ACCOUNT_IDENTITY } from "@/lib/shared-workspace";
import {
  DOCQA_OPEN_EVENT,
  type AttachedDocument,
  type DocumentOpenDetail,
} from "@/lib/docqa";
import {
  textForLanguage,
  type UiLanguage,
} from "@/lib/i18n";

const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig));
const SkillsConfig = dynamic(() => import("./SkillsConfig").then((module) => module.SkillsConfig));
const PluginsConfig = dynamic(() => import("./PluginsConfig").then((module) => module.PluginsConfig));
const AgentsConfig = dynamic(() => import("./AgentsConfig").then((module) => module.AgentsConfig));
const McpConfig = dynamic(() => import("./McpConfig").then((module) => module.McpConfig));

type SessionCopyField = "file" | "id";
type TopPanel = "settings" | "tools" | "manage" | "sessions" | "branches" | "system" | "language" | "session" | "cli";
type ResizePanel = "sidebar" | "right";

const SIDEBAR_WIDTH_STORAGE_KEY = "pi-web:sidebar-width-v2";
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "pi-web:right-panel-width";
const DEFAULT_SIDEBAR_WIDTH = 224;
const MIN_SIDEBAR_WIDTH = 132;
const SIDEBAR_COLLAPSE_THRESHOLD = 92;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_RIGHT_PANEL_RATIO = 0.42;
const DEFAULT_RIGHT_PANEL_WIDTH = 520;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MAX_RIGHT_PANEL_WIDTH = 10_000;
const MIN_CENTER_WIDTH = 360;
const CENTER_PANEL_SNAP_THRESHOLD = 20;
const MIN_SPLIT_GROUP_WIDTH = 160;
const ACTIVITY_BAR_WIDTH = 42;
const WORKSPACE_TERMINAL_TAB_ID = "workspace:terminal";
const GENERATED_CODE_TAB_ID = "workspace:generated-code";
const MAIN_RIGHT_GROUP_ID = "main";
const PINNED_ACTIVITY_STORAGE_KEY = "amedac:pinned-activity-items-v2";
type PinnableActivityId = AccountPinnedActivityItem;
const PINNABLE_ACTIVITY_IDS = new Set<PinnableActivityId>(["cli", "terminal", "branches", "source-control", "export", "models", "agents", "mcp", "skills", "plugins"]);
const LOWER_ACTIVITY_IDS = new Set<PinnableActivityId>(["models", "agents", "mcp", "skills", "plugins"]);

function pinnedActivityStorageKey(accountUid: string): string {
  return `${PINNED_ACTIVITY_STORAGE_KEY}:${accountUid}`;
}

function readPinnedActivityItems(accountUid?: string): PinnableActivityId[] {
  if (typeof window === "undefined") return ["terminal", "source-control"];
  try {
    if (!accountUid) return ["terminal", "source-control"];
    const stored = window.localStorage.getItem(pinnedActivityStorageKey(accountUid));
    if (stored === null) return ["terminal", "source-control"];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return ["terminal", "source-control"];
    const items = parsed.filter((item): item is PinnableActivityId => typeof item === "string" && PINNABLE_ACTIVITY_IDS.has(item as PinnableActivityId));
    return [...new Set(items)];
  } catch {
    return ["terminal", "source-control"];
  }
}

const ActivityButton = forwardRef<HTMLButtonElement, {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}>(function ActivityButton({ label, active = false, disabled = false, onClick, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className="activity-bar-button"
      style={{
        width: 42,
        height: 42,
        padding: 0,
        display: "grid",
        placeItems: "center",
        border: 0,
        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
        background: active ? "var(--bg-selected)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.38 : 1,
      }}
    >
      {children}
    </button>
  );
});

type ManageFeatureKind = "models" | "agents" | "mcp" | "skills" | "plugins";

function ManageFeatureIcon({ kind, compact = false }: { kind: ManageFeatureKind; compact?: boolean }) {
  const icon = kind === "models" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" /><circle cx="5" cy="7" r="1.6" /><circle cx="19" cy="7" r="1.6" /><circle cx="5" cy="17" r="1.6" /><circle cx="19" cy="17" r="1.6" />
      <path d="m7 8 2.5 2M17 8l-2.5 2M7 16l2.5-2M17 16l-2.5-2" />
    </svg>
  ) : kind === "agents" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 6V3M10.5 3h3" /><rect x="5" y="6" width="14" height="12" rx="4" />
      <circle cx="9.5" cy="11.5" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="11.5" r="1" fill="currentColor" stroke="none" /><path d="M9.5 15h5M5 11H3.5M20.5 11H19" />
    </svg>
  ) : kind === "mcp" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.2" /><circle cx="6" cy="17" r="2.2" /><circle cx="18" cy="17" r="2.2" />
      <path d="m10.8 6.9-3.6 7.9M13.2 6.9l3.6 7.9M8.2 17h7.6" />
    </svg>
  ) : kind === "skills" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8L12 3Z" />
      <path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4h3a2.3 2.3 0 1 1 4.6 0H20v5h-2.4a2.3 2.3 0 1 0 0 4H20v5h-5v2.4a2.3 2.3 0 1 1-4 0V18H6v-4h2.4a2.3 2.3 0 1 0 0-4H6V4h3Z" />
    </svg>
  );

  return (
    <span className={`manage-feature-icon manage-feature-icon--${kind}${compact ? " is-compact" : ""}`}>
      {icon}
    </span>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getContextDisplayMetrics(usage: ContextUsage | null | undefined): {
  contextWindow: number;
  usedTokens: number | null;
  remainingTokens: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
} | null {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;

  const contextWindow = usage.contextWindow;
  const explicitPercent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
    ? usage.percent
    : null;
  const explicitTokens = typeof usage.tokens === "number" && Number.isFinite(usage.tokens)
    ? usage.tokens
    : null;
  const usedPercent = clamp(
    explicitPercent ?? (explicitTokens !== null ? (explicitTokens / contextWindow) * 100 : 0),
    0,
    100,
  );
  const hasUsageValue = explicitPercent !== null || explicitTokens !== null;
  const usedTokens = explicitTokens !== null
    ? Math.round(clamp(explicitTokens, 0, contextWindow))
    : hasUsageValue
      ? Math.round((usedPercent / 100) * contextWindow)
      : null;

  return {
    contextWindow,
    usedTokens,
    remainingTokens: usedTokens === null ? null : Math.max(0, contextWindow - usedTokens),
    usedPercent: hasUsageValue ? usedPercent : null,
    remainingPercent: hasUsageValue ? 100 - usedPercent : null,
  };
}

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function defaultRightPanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_RIGHT_PANEL_WIDTH;
  return clamp(Math.round(window.innerWidth * DEFAULT_RIGHT_PANEL_RATIO), MIN_RIGHT_PANEL_WIDTH, MAX_RIGHT_PANEL_WIDTH);
}

type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const LANGUAGE_MENU_WIDTH = 176;

export function AppShell({ defaultCwd = null }: { defaultCwd?: string | null }) {
  const dialog = useAppDialog();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams, defaultCwd));
  const { preference, toggleTheme, isDark } = useTheme();
  const themeLabelKey =
    preference === "light" ? "theme.light" : preference === "dark" ? "theme.dark" : "theme.auto";
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
  useViewportHeight();
  // Keep audio ownership above ChatWindow so background sessions can notify
  // even when their chat view is not mounted.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const ifcnWorkspace = useIfcnWorkspace(selectedSession?.cwd);
  const [sessionTabs, setSessionTabs] = useState<SessionInfo[]>([]);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [agentsConfigOpen, setAgentsConfigOpen] = useState(false);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [pluginsConfigOpen, setPluginsConfigOpen] = useState(false);
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [workspaceTerminalOpen, setWorkspaceTerminalOpen] = useState(false);
  const [workspaceTerminalRequest, setWorkspaceTerminalRequest] = useState<TerminalOpenRequest | null>(null);
  const [generatedCodePanel, setGeneratedCodePanel] = useState<CodeArtifactsPanelState | null>(null);
  const [generatedCodeTabOpen, setGeneratedCodeTabOpen] = useState(false);
  const [workspaceSourceControlOpen, setWorkspaceSourceControlOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<"sessions" | "files" | "source-control">("sessions");
  const [pinnedActivityItems, setPinnedActivityItems] = useState<PinnableActivityId[]>([
    "terminal",
    "source-control",
  ]);
  const uiLanguage: UiLanguage = locale === "zh-CN" ? "zh" : "en";
  const setUiLanguage = useCallback((next: UiLanguage | ((current: UiLanguage) => UiLanguage)) => {
    const resolved = typeof next === "function" ? next(uiLanguage) : next;
    setLocale(resolved === "zh" ? "zh-CN" : "en");
  }, [setLocale, uiLanguage]);
  const uiText = textForLanguage(uiLanguage);
  const currentAccount = SHARED_ACCOUNT_IDENTITY;
  const [generalChatCwd, setGeneralChatCwd] = useState<string | null>(null);
  const pinnedActivityOwnerRef = useRef<string | null>(null);
  const pinnedActivityTouchedRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [resizingPanel, setResizingPanel] = useState<ResizePanel | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ panel: ResizePanel; startX: number; startWidth: number; currentWidth: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingResizeXRef = useRef<number | null>(null);
  const layoutRef = useRef({ sidebarOpen, rightPanelOpen: false, sidebarWidth, rightPanelWidth });
  const [hydrationReady, setHydrationReady] = useState(false);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setHydrationReady(true);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const activityBarRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const manageButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(preloadCodeEditor, { timeout: 500 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(preloadCodeEditor, 180);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const accountUid = currentAccount?.uid;
    if (!accountUid || pinnedActivityOwnerRef.current !== accountUid) return;
    window.localStorage.setItem(pinnedActivityStorageKey(accountUid), JSON.stringify(pinnedActivityItems));
    void fetch("/api/accounts/preferences", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinnedActivityItems }),
    }).catch(() => {
      // The account-scoped local cache still preserves the layout if the
      // preferences endpoint is temporarily unavailable.
    });
  }, [currentAccount?.uid, pinnedActivityItems]);

  useEffect(() => {
    const accountUid = currentAccount?.uid;
    if (!accountUid) {
      pinnedActivityOwnerRef.current = null;
      pinnedActivityTouchedRef.current = false;
      return;
    }
    pinnedActivityOwnerRef.current = null;
    pinnedActivityTouchedRef.current = false;
    const controller = new AbortController();
    void fetch("/api/accounts/preferences", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as {
          preferences?: { pinnedActivityItems?: AccountPinnedActivityItem[] };
        };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = body.preferences?.pinnedActivityItems ?? readPinnedActivityItems(accountUid);
        if (controller.signal.aborted) return;
        setPinnedActivityItems((current) => (
          pinnedActivityTouchedRef.current ? [...current] : next
        ));
        pinnedActivityOwnerRef.current = accountUid;
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        const fallback = readPinnedActivityItems(accountUid);
        setPinnedActivityItems((current) => (
          pinnedActivityTouchedRef.current ? [...current] : fallback
        ));
        pinnedActivityOwnerRef.current = accountUid;
      });
    return () => controller.abort();
  }, [currentAccount?.uid]);

  const pinActivityItem = useCallback((id: PinnableActivityId) => {
    pinnedActivityTouchedRef.current = true;
    setPinnedActivityItems((current) => current.includes(id) ? current : [...current, id]);
  }, []);

  const unpinActivityItem = useCallback((id: PinnableActivityId) => {
    pinnedActivityTouchedRef.current = true;
    setPinnedActivityItems((current) => current.filter((item) => item !== id));
  }, []);


  useEffect(() => {
    if (!currentAccount) {
      setGeneralChatCwd(null);
      return;
    }
    const controller = new AbortController();
    void fetch("/api/chat-cwd", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as { cwd?: string };
        if (response.ok && data.cwd) setGeneralChatCwd(data.cwd);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [currentAccount]);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemPromptLoading(false);
  }, []);

  const handleSystemPromptLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemPromptLoadIdRef.current += 1;
    systemPromptLoaderRef.current = loader;
    setSystemPromptLoading(false);
  }, []);
  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<TopPanel | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [cliCommand, setCliCommand] = useState<string | null>(null);
  const [cliLoading, setCliLoading] = useState(false);
  const [cliCopied, setCliCopied] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);
  const cliCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cliRequestIdRef = useRef(0);
  const cliAbortControllerRef = useRef<AbortController | null>(null);

  const toggleTopPanel = useCallback((panel: TopPanel, keepMobileToolbarOpen = false) => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile]);

  const handleSystemPromptToggle = useCallback((keepMobileToolbarOpen = false) => {
    const opening = activeTopPanel !== "system";
    toggleTopPanel("system", keepMobileToolbarOpen);
    if (!opening || systemPromptLoading) return;

    const load = systemPromptLoaderRef.current;
    if (!load) return;
    const loadId = ++systemPromptLoadIdRef.current;
    setSystemPromptLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system prompt:", error);
    }).finally(() => {
      if (systemPromptLoadIdRef.current === loadId) {
        setSystemPromptLoading(false);
      }
    });
  }, [activeTopPanel, systemPromptLoading, toggleTopPanel]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setMobileToolbarMoreOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const handleMobileToolbarMoreToggle = useCallback(() => {
    setSidebarOpen(false);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen((open) => !open);
  }, []);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const toolbar = mobileToolbarRef.current;
      if (toolbar && event.composedPath().includes(toolbar)) return;
      setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMobileToolbarMoreOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [mobileToolbarMoreOpen]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
  }, [isMobile, selectedSession?.id, newSessionDraftId]);

  useEffect(() => {
    const topBar = topBarRef.current;
    const activityBar = activityBarRef.current;
    if (!activeTopPanel || !topBar) return;
    const update = () => {
      const topBarRect = topBar.getBoundingClientRect();
      if (activeTopPanel === "language" && !isMobile && languageBtnRef.current) {
        const buttonRect = languageBtnRef.current.getBoundingClientRect();
        const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
        const left = Math.min(buttonRect.left - 1, Math.max(topBarRect.left, topBarRect.right - width));
        setTopPanelPos({ top: topBarRect.bottom, left, width });
        return;
      }
      const anchoredButton = activeTopPanel === "manage"
        ? manageButtonRef.current
        : activeTopPanel === "settings"
          ? settingsButtonRef.current
          : activeTopPanel === "tools" || activeTopPanel === "session" || activeTopPanel === "cli"
            ? toolsButtonRef.current
            : null;
      if (anchoredButton) {
        const rect = anchoredButton.getBoundingClientRect();
        const estimatedHeight = activeTopPanel === "session"
          ? 420
          : activeTopPanel === "cli"
            ? 210
            : activeTopPanel === "manage"
              ? 224
              : activeTopPanel === "settings"
                ? 126
                : 286;
        const opensUpward = activeTopPanel === "manage" || activeTopPanel === "settings";
        const preferredTop = opensUpward ? rect.bottom - estimatedHeight : rect.top;
        const gap = 6;
        const availableWidth = Math.max(264, window.innerWidth - rect.right - gap - 8);
        const panelWidth = activeTopPanel === "session"
          ? Math.min(860, availableWidth)
          : activeTopPanel === "cli"
            ? Math.min(680, availableWidth)
            : activeTopPanel === "manage"
              ? Math.min(278, availableWidth)
              : Math.min(264, availableWidth);
        setTopPanelPos({
          top: Math.max(8, Math.min(preferredTop, window.innerHeight - estimatedHeight - 8)),
          left: rect.right + gap,
          width: panelWidth,
        });
        return;
      }
      if ((activeTopPanel === "settings" || activeTopPanel === "tools" || activeTopPanel === "manage" || activeTopPanel === "sessions") && activityBar) {
        const rect = activityBar.getBoundingClientRect();
        setTopPanelPos({ top: rect.top, left: rect.right, width: Math.max(300, Math.min(420, window.innerWidth - rect.right)) });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    const observed = activeTopPanel === "manage"
      ? manageButtonRef.current
      : activeTopPanel === "settings"
        ? settingsButtonRef.current
        : activeTopPanel === "tools" || activeTopPanel === "session" || activeTopPanel === "cli"
          ? toolsButtonRef.current
          : activeTopPanel === "sessions" && activityBar
            ? activityBar
            : activeTopPanel === "language" && languageBtnRef.current
              ? languageBtnRef.current
              : topBar;
    if (observed) ro.observe(observed);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [activeTopPanel, isMobile]);

  useEffect(() => {
    if (activeTopPanel !== "settings" && activeTopPanel !== "tools" && activeTopPanel !== "manage" && activeTopPanel !== "sessions" && activeTopPanel !== "session" && activeTopPanel !== "cli") return;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (
        settingsButtonRef.current?.contains(target)
        || settingsMenuRef.current?.contains(target)
        || toolsButtonRef.current?.contains(target)
        || toolsMenuRef.current?.contains(target)
        || manageButtonRef.current?.contains(target)
        || activityBarRef.current?.contains(target)
        || (target instanceof Element && target.closest(".top-panel-host"))
      )) return;
      setActiveTopPanel(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveTopPanel(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeTopPanel]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false);
  const [folderLoadedToast, setFolderLoadedToast] = useState<string | null>(null);
  const folderLoadedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pdfFocusMode, setPdfFocusMode] = useState(false);
  const [rightGroupOrder, setRightGroupOrder] = useState<string[]>([MAIN_RIGHT_GROUP_ID]);
  const [rightTabGroups, setRightTabGroups] = useState<Record<string, string>>({});
  const [rightGroupActiveTabs, setRightGroupActiveTabs] = useState<Record<string, string | null>>({});
  const [rightGroupSizes, setRightGroupSizes] = useState<Record<string, number>>({ [MAIN_RIGHT_GROUP_ID]: 1 });
  const [resizingRightGroup, setResizingRightGroup] = useState<string | null>(null);
  const rightGroupCounterRef = useRef(0);
  const rightGroupElementsRef = useRef(new Map<string, HTMLElement>());
  const rightGroupResizeRef = useRef<{
    pointerId: number;
    leftId: string;
    rightId: string;
    startX: number;
    leftWidth: number;
    rightWidth: number;
    combinedWeight: number;
    currentLeftWidth: number;
    currentRightWidth: number;
  } | null>(null);
  const rightGroupResizeFrameRef = useRef<number | null>(null);
  const pendingRightGroupResizeXRef = useRef<number | null>(null);
  const generatedCodeOpenRef = useRef(false);
  const generatedCodeBundleRef = useRef<string | null>(null);

  const openGeneratedCodeTab = useCallback(() => {
    const mappedGroupId = rightTabGroups[GENERATED_CODE_TAB_ID];
    const groupId = mappedGroupId && rightGroupOrder.includes(mappedGroupId)
      ? mappedGroupId
      : `split-${++rightGroupCounterRef.current}`;
    if (groupId !== mappedGroupId) {
      setRightGroupOrder((current) => current.includes(groupId) ? current : [...current, groupId]);
      setRightTabGroups((current) => ({ ...current, [GENERATED_CODE_TAB_ID]: groupId }));
      setRightGroupSizes((current) => ({ ...current, [groupId]: 1 }));
    }
    setGeneratedCodeTabOpen(true);
    setRightGroupActiveTabs((current) => ({ ...current, [groupId]: GENERATED_CODE_TAB_ID }));
    setActiveFileTabId(GENERATED_CODE_TAB_ID);
    setRightPanelOpen(true);
    setPdfFocusMode(false);
  }, [rightGroupOrder, rightTabGroups, setPdfFocusMode, setRightPanelOpen]);

  const handleCodeArtifactsChange = useCallback((state: CodeArtifactsPanelState | null) => {
    if (!state) {
      generatedCodeOpenRef.current = false;
      generatedCodeBundleRef.current = null;
      setGeneratedCodeTabOpen(false);
      setGeneratedCodePanel(null);
      setRightTabGroups((current) => {
        if (!(GENERATED_CODE_TAB_ID in current)) return current;
        const next = { ...current };
        delete next[GENERATED_CODE_TAB_ID];
        return next;
      });
      return;
    }
    const bundle = state.artifacts.map((artifact) => artifact.id).join("|");
    const isNewBundle = generatedCodeBundleRef.current !== bundle;
    generatedCodeBundleRef.current = bundle;
    setGeneratedCodePanel(state);
    if (generatedCodeOpenRef.current && !isNewBundle) return;
    generatedCodeOpenRef.current = true;
    openGeneratedCodeTab();
  }, [openGeneratedCodeTab]);

  const showWorkspaceTerminalTab = useCallback((request?: TerminalOpenRequest) => {
    setWorkspaceTerminalRequest(request ?? null);
    setWorkspaceTerminalOpen(true);
    setActiveFileTabId(WORKSPACE_TERMINAL_TAB_ID);
    setRightPanelOpen(true);
    setPdfFocusMode(false);
  }, [setPdfFocusMode, setRightPanelOpen]);

  useEffect(() => {
    if (!rightPanelOpen) setChatPanelCollapsed(false);
  }, [rightPanelOpen]);

  const showFolderLoadedToast = useCallback((cwd: string) => {
    if (folderLoadedToastTimerRef.current) clearTimeout(folderLoadedToastTimerRef.current);
    setFolderLoadedToast(cwd);
    folderLoadedToastTimerRef.current = setTimeout(() => {
      setFolderLoadedToast(null);
      folderLoadedToastTimerRef.current = null;
    }, 3200);
  }, [setFolderLoadedToast]);

  useEffect(() => () => {
    if (folderLoadedToastTimerRef.current) clearTimeout(folderLoadedToastTimerRef.current);
  }, []);

  const handlePdfFocusModeChange = useCallback((focused: boolean) => {
    setPdfFocusMode(focused);
    if (focused) setRightPanelOpen(true);
  }, [setPdfFocusMode, setRightPanelOpen]);

  useEffect(() => {
    if (!pdfFocusMode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPdfFocusMode(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pdfFocusMode]);

  const activeResize = resizeRef.current;
  layoutRef.current = {
    sidebarOpen,
    rightPanelOpen,
    sidebarWidth: activeResize?.panel === "sidebar" ? activeResize.currentWidth : sidebarWidth,
    rightPanelWidth: activeResize?.panel === "right" ? activeResize.currentWidth : rightPanelWidth,
  };

  const applyPanelWidthToLayout = useCallback((panel: ResizePanel, width: number) => {
    const roundedWidth = Math.round(width);
    shellRef.current?.style.setProperty(
      panel === "sidebar" ? "--sidebar-width" : "--right-panel-width",
      `${roundedWidth}px`,
    );
    layoutRef.current = panel === "sidebar"
      ? { ...layoutRef.current, sidebarWidth: roundedWidth }
      : { ...layoutRef.current, rightPanelWidth: roundedWidth };
    if (resizeRef.current?.panel === panel) resizeRef.current.currentWidth = roundedWidth;
    return roundedWidth;
  }, []);

  useEffect(() => {
    setSidebarWidth(readStoredNumber(
      SIDEBAR_WIDTH_STORAGE_KEY,
      DEFAULT_SIDEBAR_WIDTH,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
    ));
    setRightPanelWidth(readStoredNumber(
      RIGHT_PANEL_WIDTH_STORAGE_KEY,
      defaultRightPanelWidth(),
      MIN_RIGHT_PANEL_WIDTH,
      MAX_RIGHT_PANEL_WIDTH,
    ));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(sidebarWidth)));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [sidebarWidth]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(Math.round(rightPanelWidth)));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [rightPanelWidth]);

  useEffect(() => {
    let animationFrame: number | null = null;
    const fitRightPanelToViewport = () => {
      if (animationFrame !== null) return;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        const layout = layoutRef.current;
        const availableWidth = Math.max(
          MIN_RIGHT_PANEL_WIDTH,
          window.innerWidth - (layout.sidebarOpen ? layout.sidebarWidth : 0),
        );
        const nextWidth = Math.min(layout.rightPanelWidth, availableWidth);
        if (nextWidth === layout.rightPanelWidth) return;
        const appliedWidth = applyPanelWidthToLayout("right", nextWidth);
        setRightPanelWidth(appliedWidth);
      });
    };
    fitRightPanelToViewport();
    window.addEventListener("resize", fitRightPanelToViewport);
    return () => {
      window.removeEventListener("resize", fitRightPanelToViewport);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, [applyPanelWidthToLayout, sidebarOpen]);

  const startResize = useCallback((panel: ResizePanel, event: PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    event.stopPropagation();
    // Open popovers observe the top bar and would otherwise re-render the
    // entire shell for every width change while a divider is moving.
    setActiveTopPanel(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeRef.current = {
      panel,
      startX: event.clientX,
      startWidth: panel === "sidebar" ? layoutRef.current.sidebarWidth : layoutRef.current.rightPanelWidth,
      currentWidth: panel === "sidebar" ? layoutRef.current.sidebarWidth : layoutRef.current.rightPanelWidth,
    };
    shellRef.current?.classList.add("is-panel-resizing");
    setResizingPanel(panel);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [isMobile]);

  useEffect(() => {
    const shell = shellRef.current;
    const applyResize = (clientX: number) => {
      const resize = resizeRef.current;
      if (!resize) return;

      const layout = layoutRef.current;
      let nextWidth: number;
      if (resize.panel === "sidebar") {
        const max = Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - (layout.rightPanelOpen ? layout.rightPanelWidth : 0) - MIN_CENTER_WIDTH),
        );
        const requestedWidth = resize.startWidth + clientX - resize.startX;
        // Below the compact usable width, keep following the pointer so the
        // user can drag all the way left to collapse the sidebar.
        nextWidth = requestedWidth < MIN_SIDEBAR_WIDTH
          ? Math.max(0, requestedWidth)
          : clamp(requestedWidth, MIN_SIDEBAR_WIDTH, max);
      } else {
        const availableWidth = Math.max(
          MIN_RIGHT_PANEL_WIDTH,
          Math.min(MAX_RIGHT_PANEL_WIDTH, window.innerWidth - (layout.sidebarOpen ? layout.sidebarWidth : 0)),
        );
        nextWidth = clamp(resize.startWidth + resize.startX - clientX, MIN_RIGHT_PANEL_WIDTH, availableWidth);
      }
      applyPanelWidthToLayout(resize.panel, nextWidth);
    };

    const stopResize = (clientX?: number) => {
      const resize = resizeRef.current;
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
      const finalClientX = clientX ?? pendingResizeXRef.current;
      pendingResizeXRef.current = null;
      if (resize && finalClientX !== null && finalClientX !== undefined) applyResize(finalClientX);

      if (resize) {
        let finalWidth = resize.currentWidth;
        if (resize.panel === "sidebar" && finalWidth <= SIDEBAR_COLLAPSE_THRESHOLD) {
          // Preserve the last usable width for the next reopen.
          applyPanelWidthToLayout("sidebar", clamp(resize.startWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
          setSidebarOpen(false);
        } else {
          if (resize.panel === "sidebar") {
            finalWidth = clamp(finalWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
          } else {
            const layout = layoutRef.current;
            const availableWidth = Math.max(
              MIN_RIGHT_PANEL_WIDTH,
              Math.min(MAX_RIGHT_PANEL_WIDTH, window.innerWidth - (layout.sidebarOpen ? layout.sidebarWidth : 0)),
            );
            if (availableWidth - finalWidth <= CENTER_PANEL_SNAP_THRESHOLD) finalWidth = availableWidth;
          }
          finalWidth = applyPanelWidthToLayout(resize.panel, finalWidth);
          if (resize.panel === "sidebar") setSidebarWidth(finalWidth);
          else setRightPanelWidth(finalWidth);
        }
      }

      resizeRef.current = null;
      setResizingPanel(null);
      shell?.classList.remove("is-panel-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const handleMove = (event: globalThis.PointerEvent) => {
      if (!resizeRef.current) return;
      if (event.buttons === 0) {
        stopResize(event.clientX);
        return;
      }
      pendingResizeXRef.current = event.clientX;
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const clientX = pendingResizeXRef.current;
        pendingResizeXRef.current = null;
        if (clientX !== null) applyResize(clientX);
      });
    };

    const stopResizeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") stopResize();
    };
    const stopResizeOnPointerEnd = (event: globalThis.PointerEvent) => stopResize(event.clientX);
    const stopResizeOnPointerCancel = () => stopResize();
    const stopResizeOnBlur = () => stopResize();

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stopResizeOnPointerEnd);
    window.addEventListener("pointercancel", stopResizeOnPointerCancel);
    window.addEventListener("blur", stopResizeOnBlur);
    window.addEventListener("keydown", stopResizeOnEscape);
    return () => {
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
      pendingResizeXRef.current = null;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stopResizeOnPointerEnd);
      window.removeEventListener("pointercancel", stopResizeOnPointerCancel);
      window.removeEventListener("blur", stopResizeOnBlur);
      window.removeEventListener("keydown", stopResizeOnEscape);
      shell?.classList.remove("is-panel-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [applyPanelWidthToLayout]);
  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  const handleDocQa = useCallback((document: AttachedDocument) => {
    chatInputRef.current?.addDocument(document);
  }, []);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile, setRightPanelOpen]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile, setRightPanelOpen]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile, setRightPanelOpen]);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const activeProjectKeyRef = useRef<string | null>(null);
  const cliWorkspaceCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
  // Child effects may restore a workspace immediately after mount. Keep every
  // SSR-rendered workspace control on the deterministic disabled snapshot until
  // hydration itself has committed.
  const renderedWorkspaceCwd = hydrationReady ? cliWorkspaceCwd : null;
  useEffect(() => {
    if (!cliWorkspaceCwd) setWorkspaceSourceControlOpen(false);
  }, [cliWorkspaceCwd]);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectKey, so use the active project identity until hydration.
  useEffect(() => {
    if (!selectedSession) return;
    const projectKey = selectedSession.projectKey
      ?? activeProjectKeyRef.current
      ?? workspaceKeyOf(selectedSession);
    setLastOpenSession(projectKey, selectedSession.id);
  }, [selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        const draftId = `initial:${requestedCwd}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = `new:${draftId}:${data.cwd}`;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string) => {
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if (workspaceKeyOf(s) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
        }
      })
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router]);

  const handleCwdChange = useCallback((
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => {
    invalidateWorkspaceRestore();
    const currentFreshCwd = newSessionCwd ?? activeCwd;
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectKey ?? projectRoot ?? cwd;
    const currentProject = activeProjectKeyRef.current
      ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
    activeProjectKeyRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // The server may hydrate a normalized key after a custom cwd is already
    // active. Updating identity for the exact same cwd is not a user switch.
    if (currentFreshCwd === cwd && currentProject !== newProject) return;
    // Existing sessions stay open when the worktree selector moves within the
    // same project. A fresh composer must remount when its effective cwd moves,
    // otherwise its already-created runtime would keep sending to the old cwd.
    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setNewSessionDraftId(draftId);
    activeNewSessionDraftKeyRef.current = `new:${draftId}:${cwd}`;
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    if (currentProject !== newProject) {
      // File tabs are keyed by absolute path, so tabs opened in the previous
      // project must not linger. Same-project worktree switches keep them.
      setFileTabs([]);
      setActiveFileTabId(null);
      setRightPanelOpen(false);
      // Restore the workspace we switched to: its last open session, or keep
      // the default welcome page when none is remembered.
      restoreWorkspaceContext(newProject);
    }
    router.replace("/", { scroll: false });
  }, [activeCwd, invalidateWorkspaceRestore, newSessionCwd, router, selectedSession, restoreWorkspaceContext, setRightPanelOpen]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (!isRestore && selectedSession) {
      const sameProject =
        workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
      if (selectedSession.id === session.id && sameProject) {
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionTabs((tabs) => tabs.some((tab) => tab.id === session.id) ? tabs : [...tabs, session]);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [invalidateWorkspaceRestore, router, isMobile, selectedSession]);

  const handleNewSession = useCallback((sessionId: string, cwd: string) => {
    invalidateWorkspaceRestore();
    const draftKey = `new:${sessionId}:${cwd}`;
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(sessionId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [invalidateWorkspaceRestore, router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
        setSessionTabs((tabs) => tabs.map((tab) => (
          tab.id === sessionId ? { ...tab, ...full, transient: full.transient ?? false } : tab
        )));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionTabs((tabs) => tabs.some((tab) => tab.id === session.id) ? tabs : [...tabs, session]);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => { if (p === "granted") fire(); });
    }
  }, [handleSelectSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (selectedSession) hydrateSelectedSession(selectedSession.id);

    if (!shouldShowBrowserNotification()) return;
    const targetSession = selectedSession;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
    });
  }, [deliverSessionNotification, hydrateSelectedSession, selectedSession, translate]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: selectedSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleCodeFileSaved = useCallback(() => {
    setExplorerRefreshKey((key) => key + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => {
      const forked = {
        ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
        id: newSessionId,
        transient: false,
      };
      setSessionTabs((tabs) => tabs.some((tab) => tab.id === newSessionId) ? tabs : [...tabs, forked]);
      return forked;
    });
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    setSessionTabs((tabs) => tabs.filter((tab) => tab.id !== sessionId));
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      const draftId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setNewSessionDraftId(draftId);
      activeNewSessionDraftKeyRef.current = cwd ? `new:${draftId}:${cwd}` : null;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setSystemPromptLoading(false);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [invalidateWorkspaceRestore, selectedSession, router]);

  const activateSessionTab = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((key) => key + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  const closeSessionTab = useCallback((sessionId: string) => {
    const remaining = sessionTabs.filter((tab) => tab.id !== sessionId);
    setSessionTabs(remaining);
    if (selectedSession?.id !== sessionId) return;
    const next = remaining.at(-1) ?? null;
    setSelectedSession(next);
    setNewSessionCwd(next ? null : selectedSession.cwd ?? null);
    setSessionKey((key) => key + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    router.replace(next ? `?session=${encodeURIComponent(next.id)}` : "/", { scroll: false });
  }, [router, selectedSession, sessionTabs]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      modeHint,
      sourceSessionId,
      tabId,
    }));
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    setPdfFocusMode(false);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, setPdfFocusMode, setRightPanelOpen]);

  const handleOpenTimeline = useCallback((filePath: string, fileName: string) => {
    const tabId = `timeline:${filePath}`;
    setFileTabs((previous) => {
      if (previous.some((tab) => tab.id === tabId)) return previous;
      return [...previous, {
        id: tabId,
        label: uiLanguage === "zh" ? `${fileName} · 时间线` : `${fileName} · Timeline`,
        filePath,
        view: "timeline",
      }];
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    setPdfFocusMode(false);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, setPdfFocusMode, setRightPanelOpen, uiLanguage]);

  const handleOpenRevision = useCallback((filePath: string, fileName: string, entry: TimelineEntry) => {
    const tabId = `revision:${entry.hash}:${filePath}`;
    setFileTabs((previous) => {
      if (previous.some((tab) => tab.id === tabId)) return previous;
      return [...previous, {
        id: tabId,
        label: `${fileName} @ ${entry.shortHash}`,
        filePath,
        view: "revision",
        revision: {
          hash: entry.hash,
          shortHash: entry.shortHash,
          message: entry.message,
        },
      }];
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    setPdfFocusMode(false);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, setPdfFocusMode, setRightPanelOpen]);

  const handleFileDeleted = useCallback((deletedPath: string, isDir: boolean) => {
    const normalizedDeleted = deletedPath.replace(/\\/g, "/").replace(/\/+$/, "");
    setExplorerRefreshKey((key) => key + 1);
    setPdfFocusMode(false);
    setFileTabs((prev) => {
      const next = prev.filter((tab) => {
        const normalizedFile = tab.filePath.replace(/\\/g, "/");
        return !(normalizedFile === normalizedDeleted || (isDir && normalizedFile.startsWith(`${normalizedDeleted}/`)));
      });
      setActiveFileTabId((current) => {
        if (current === WORKSPACE_TERMINAL_TAB_ID && workspaceTerminalOpen) return current;
        if (current === GENERATED_CODE_TAB_ID && generatedCodeTabOpen) return current;
        if (current && next.some((tab) => tab.id === current)) return current;
        return next[next.length - 1]?.id
          ?? (workspaceTerminalOpen ? WORKSPACE_TERMINAL_TAB_ID : null)
          ?? (generatedCodeTabOpen ? GENERATED_CODE_TAB_ID : null);
      });
      if (next.length === 0 && !workspaceTerminalOpen && !generatedCodeTabOpen) setRightPanelOpen(false);
      return next;
    });
  }, [generatedCodeTabOpen, setPdfFocusMode, setRightPanelOpen, workspaceTerminalOpen]);

  const handleFileMoved = useCallback((previousPath: string, nextPath: string, isDir: boolean) => {
    const previous = previousPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const next = nextPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const remap = (filePath: string) => {
      const normalized = filePath.replace(/\\/g, "/");
      if (normalized === previous) return next;
      if (isDir && normalized.startsWith(`${previous}/`)) return `${next}${normalized.slice(previous.length)}`;
      return filePath;
    };
    setExplorerRefreshKey((key) => key + 1);
    setFileTabs((tabs) => tabs.map((tab) => {
      const filePath = remap(tab.filePath);
      if (filePath === tab.filePath) return tab;
      const renamedItem = tab.filePath.replace(/\\/g, "/") === previous;
      const renamedFileName = filePath.split("/").pop();
      const label = renamedItem && !isDir && renamedFileName
        ? tab.view === "timeline"
          ? `${renamedFileName} · ${uiLanguage === "zh" ? "时间线" : "Timeline"}`
          : tab.view === "revision"
            ? `${renamedFileName} @ ${tab.revision?.shortHash ?? ""}`.trim()
          : renamedFileName
        : tab.label;
      const prefix = tab.view === "timeline"
        ? "timeline:"
        : tab.view === "revision" && tab.revision
          ? `revision:${tab.revision.hash}:`
          : "file:";
      return { ...tab, id: `${prefix}${filePath}`, filePath, label };
    }));
    setActiveFileTabId((activeId) => {
      const prefix = activeId?.startsWith("timeline:")
        ? "timeline:"
        : activeId?.startsWith("file:")
          ? "file:"
          : /^revision:[0-9a-f]{40}:/i.exec(activeId ?? "")?.[0] ?? null;
      if (!activeId || !prefix) return activeId;
      const previousActivePath = activeId.slice(prefix.length);
      const nextActivePath = remap(previousActivePath);
      return nextActivePath === previousActivePath ? activeId : `${prefix}${nextActivePath}`;
    });
  }, [uiLanguage]);

  const handleOpenDocument = useCallback((detail: DocumentOpenDetail) => {
    const fileName = detail.path.replace(/\\/g, "/").split("/").pop() || detail.path;
    const tabId = `file:${detail.path}`;
    setFileTabs((previous) => {
      const existing = previous.find((tab) => tab.id === tabId);
      if (!existing) {
        return [...previous, {
          id: tabId,
          label: fileName,
          filePath: detail.path,
          location: detail.location,
          focusToken: Date.now(),
        }];
      }
      return previous.map((tab) => tab.id === tabId
        ? { ...tab, location: detail.location, focusToken: Date.now() }
        : tab);
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    setPdfFocusMode(false);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, setPdfFocusMode, setRightPanelOpen]);

  useEffect(() => {
    const listener = (event: Event) => {
      handleOpenDocument((event as CustomEvent<DocumentOpenDetail>).detail);
    };
    window.addEventListener(DOCQA_OPEN_EVENT, listener);
    return () => window.removeEventListener(DOCQA_OPEN_EVENT, listener);
  }, [handleOpenDocument]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  const handleCloseFileTab = useCallback(async (tabId: string) => {
    const closingTab = fileTabs.find((tab) => tab.id === tabId);
    if (closingTab?.dirty && !await dialog.confirm({ title: "Discard unsaved changes?", message: closingTab.label, confirmLabel: "Discard", cancelLabel: "Cancel", danger: true })) {
      return;
    }
    setPdfFocusMode(false);
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0 && !workspaceTerminalOpen && !generatedCodeTabOpen) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0
        ? remaining[remaining.length - 1].id
        : workspaceTerminalOpen
          ? WORKSPACE_TERMINAL_TAB_ID
          : generatedCodeTabOpen
            ? GENERATED_CODE_TAB_ID
            : null;
    });
  }, [dialog, fileTabs, generatedCodeTabOpen, setPdfFocusMode, setRightPanelOpen, workspaceTerminalOpen]);

  const handleCloseRightTab = useCallback((tabId: string) => {
    if (tabId === GENERATED_CODE_TAB_ID) {
      setGeneratedCodeTabOpen(false);
      setRightTabGroups((current) => {
        if (!(GENERATED_CODE_TAB_ID in current)) return current;
        const next = { ...current };
        delete next[GENERATED_CODE_TAB_ID];
        return next;
      });
      setActiveFileTabId((current) => {
        if (current !== tabId) return current;
        const fallback = workspaceTerminalOpen
          ? WORKSPACE_TERMINAL_TAB_ID
          : fileTabs.at(-1)?.id ?? null;
        if (!fallback) setRightPanelOpen(false);
        return fallback;
      });
      return;
    }
    if (tabId === WORKSPACE_TERMINAL_TAB_ID) {
      setWorkspaceTerminalOpen(false);
      setWorkspaceTerminalRequest(null);
      setRightTabGroups((current) => {
        if (!(WORKSPACE_TERMINAL_TAB_ID in current)) return current;
        const next = { ...current };
        delete next[WORKSPACE_TERMINAL_TAB_ID];
        return next;
      });
      if (activeFileTabId === tabId) {
        const fallback = fileTabs.at(-1)?.id ?? null;
        const resolvedFallback = fallback ?? (generatedCodeTabOpen ? GENERATED_CODE_TAB_ID : null);
        setActiveFileTabId(resolvedFallback);
        if (!resolvedFallback) setRightPanelOpen(false);
      }
      return;
    }
    void handleCloseFileTab(tabId);
  }, [activeFileTabId, fileTabs, generatedCodeTabOpen, handleCloseFileTab, setRightPanelOpen, workspaceTerminalOpen]);

  const workspaceTerminalActive = workspaceTerminalOpen
    && rightPanelOpen
    && activeFileTabId === WORKSPACE_TERMINAL_TAB_ID;
  const toggleWorkspaceTerminalTab = useCallback(() => {
    if (workspaceTerminalActive) {
      handleCloseRightTab(WORKSPACE_TERMINAL_TAB_ID);
      return;
    }
    showWorkspaceTerminalTab();
  }, [handleCloseRightTab, showWorkspaceTerminalTab, workspaceTerminalActive]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  const handleExportSession = useCallback(() => {
    if (!selectedSession) return;
    const link = document.createElement("a");
    link.href = `/api/sessions/${encodeURIComponent(selectedSession.id)}/export`;
    link.download = "";
    link.click();
  }, [selectedSession]);

  const markCliCopied = useCallback(() => {
    if (cliCopyTimerRef.current) clearTimeout(cliCopyTimerRef.current);
    setCliCopied(true);
    cliCopyTimerRef.current = setTimeout(() => setCliCopied(false), 1800);
  }, []);

  const handleCopyCliCommand = useCallback((command = cliCommand) => {
    if (!command) return;
    void copyText(command).then(markCliCopied).catch(() => {});
  }, [cliCommand, markCliCopied]);

  const handleCliSync = useCallback(async () => {
    if (!cliWorkspaceCwd) return;
    const requestId = ++cliRequestIdRef.current;
    cliAbortControllerRef.current?.abort();
    const controller = new AbortController();
    cliAbortControllerRef.current = controller;
    setActiveTopPanel("cli");
    setCliLoading(true);
    setCliError(null);
    setCliCommand(null);
    try {
      const response = await fetch("/api/cli-bridge/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: selectedSession?.cwd ?? cliWorkspaceCwd,
          sessionId: selectedSession?.id,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as { command?: string; error?: string };
      if (controller.signal.aborted || cliRequestIdRef.current !== requestId) return;
      if (!response.ok || !data.command) throw new Error(data.error ?? `HTTP ${response.status}`);
      setCliCommand(data.command);
      try {
        await copyText(data.command);
        if (!controller.signal.aborted && cliRequestIdRef.current === requestId) markCliCopied();
      } catch {
        // The command remains visible with a manual copy button when browser
        // clipboard permission is unavailable.
      }
    } catch (error) {
      if (controller.signal.aborted || cliRequestIdRef.current !== requestId) return;
      setCliError(error instanceof Error ? error.message : String(error));
    } finally {
      if (cliRequestIdRef.current === requestId) {
        cliAbortControllerRef.current = null;
        setCliLoading(false);
      }
    }
  }, [cliWorkspaceCwd, markCliCopied, selectedSession]);

  useEffect(() => {
    cliRequestIdRef.current += 1;
    cliAbortControllerRef.current?.abort();
    cliAbortControllerRef.current = null;
    setCliCommand(null);
    setCliError(null);
    setCliCopied(false);
    setCliLoading(false);
    setActiveTopPanel((current) => current === "cli" ? null : current);
  }, [cliWorkspaceCwd, selectedSession?.id]);

  useEffect(() => () => {
    cliRequestIdRef.current += 1;
    cliAbortControllerRef.current?.abort();
    if (cliCopyTimerRef.current) clearTimeout(cliCopyTimerRef.current);
  }, []);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd
    ?? (selectedSession === null ? activeCwd ?? generalChatCwd : null);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  const hasSessionInfoButton = showChat && Boolean(sessionStats || contextUsage);
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const handleFileDirtyChange = useCallback((filePath: string, dirty: boolean) => {
    const tabId = `file:${filePath}`;
    setFileTabs((previous) => previous.map((tab) => (
      tab.id === tabId && tab.dirty !== dirty ? { ...tab, dirty } : tab
    )));
  }, []);

  const rightPanelTabs: Tab[] = [
    ...fileTabs,
    ...(workspaceTerminalOpen ? [{
      id: WORKSPACE_TERMINAL_TAB_ID,
      label: uiText.app.terminal,
      filePath: cliWorkspaceCwd ?? "",
      view: "terminal" as const,
    }] : []),
    ...(generatedCodePanel && generatedCodeTabOpen ? [{
      id: GENERATED_CODE_TAB_ID,
      label: `${uiLanguage === "zh" ? "生成代码" : "Generated code"} · ${generatedCodePanel.artifacts.length}`,
      filePath: generatedCodePanel.artifact.suggestedFileName,
      view: "generated-code" as const,
    }] : []),
  ];
  const rightPanelLayoutSignature = rightPanelTabs
    .map((tab) => `${tab.id}:${rightTabGroups[tab.id] ?? MAIN_RIGHT_GROUP_ID}`)
    .join("|");
  useEffect(() => {
    const occupiedGroups = new Set(
      rightPanelLayoutSignature
        .split("|")
        .filter(Boolean)
        .map((entry) => entry.slice(entry.lastIndexOf(":") + 1)),
    );
    setRightGroupOrder((current) => {
      const next = current.filter((groupId) => groupId === MAIN_RIGHT_GROUP_ID || occupiedGroups.has(groupId));
      return next.length === current.length && next.every((groupId, index) => groupId === current[index])
        ? current
        : next;
    });
    setRightGroupSizes((current) => {
      let changed = false;
      const next = { ...current };
      for (const groupId of Object.keys(next)) {
        if (groupId !== MAIN_RIGHT_GROUP_ID && !occupiedGroups.has(groupId)) {
          delete next[groupId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setRightGroupActiveTabs((current) => {
      let changed = false;
      const next = { ...current };
      for (const groupId of Object.keys(next)) {
        if (groupId !== MAIN_RIGHT_GROUP_ID && !occupiedGroups.has(groupId)) {
          delete next[groupId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [rightPanelLayoutSignature]);
  useEffect(() => {
    if (!activeFileTabId) return;
    const groupId = rightTabGroups[activeFileTabId] ?? MAIN_RIGHT_GROUP_ID;
    setRightGroupActiveTabs((current) => (
      current[groupId] === activeFileTabId
        ? current
        : { ...current, [groupId]: activeFileTabId }
    ));
  }, [activeFileTabId, rightTabGroups]);

  const visibleRightGroups = rightGroupOrder
    .map((groupId) => ({
      id: groupId,
      tabs: rightPanelTabs.filter((tab) => (rightTabGroups[tab.id] ?? MAIN_RIGHT_GROUP_ID) === groupId),
    }))
    // An automatic code split can be the first item in the right panel. In
    // that case the main group has no tabs and must not consume a blank column.
    .filter((group) => group.tabs.length > 0);
  const visibleRightGroupWeightTotal = Math.max(0.1, visibleRightGroups.reduce(
    (total, group) => total + Math.max(0.1, rightGroupSizes[group.id] ?? 1),
    0,
  ));

  const selectRightTab = (groupId: string, tabId: string) => {
    setRightGroupActiveTabs((current) => ({ ...current, [groupId]: tabId }));
    setActiveFileTabId(tabId);
    setPdfFocusMode(false);
  };

  const splitRightTab = (tabId: string) => {
    const sourceGroupId = rightTabGroups[tabId] ?? MAIN_RIGHT_GROUP_ID;
    const nextGroupId = `split-${++rightGroupCounterRef.current}`;
    const sourceTabs = rightPanelTabs.filter((tab) => (
      tab.id !== tabId
      && (rightTabGroups[tab.id] ?? MAIN_RIGHT_GROUP_ID) === sourceGroupId
    ));
    setRightGroupOrder((current) => [...current, nextGroupId]);
    setRightTabGroups((current) => ({ ...current, [tabId]: nextGroupId }));
    setRightGroupSizes((current) => {
      const sourceWeight = Math.max(0.1, current[sourceGroupId] ?? 1);
      return {
        ...current,
        [sourceGroupId]: sourceWeight / 2,
        [nextGroupId]: sourceWeight / 2,
      };
    });
    setRightGroupActiveTabs((current) => ({
      ...current,
      [sourceGroupId]: sourceTabs.at(-1)?.id ?? null,
      [nextGroupId]: tabId,
    }));
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    setPdfFocusMode(false);
  };

  const moveRightTabToMain = (tabId: string) => {
    const sourceGroupId = rightTabGroups[tabId] ?? MAIN_RIGHT_GROUP_ID;
    const sourceTabs = rightPanelTabs.filter((tab) => (
      tab.id !== tabId
      && (rightTabGroups[tab.id] ?? MAIN_RIGHT_GROUP_ID) === sourceGroupId
    ));
    setRightTabGroups((current) => ({ ...current, [tabId]: MAIN_RIGHT_GROUP_ID }));
    setRightGroupActiveTabs((current) => {
      const next: Record<string, string | null> = { ...current, [MAIN_RIGHT_GROUP_ID]: tabId };
      if (sourceGroupId !== MAIN_RIGHT_GROUP_ID) {
        const sourceActiveId = sourceTabs.at(-1)?.id;
        if (sourceActiveId) next[sourceGroupId] = sourceActiveId;
        else delete next[sourceGroupId];
      }
      return next;
    });
    if (sourceGroupId !== MAIN_RIGHT_GROUP_ID && sourceTabs.length === 0) {
      setRightGroupOrder((current) => current.filter((groupId) => groupId !== sourceGroupId));
      setRightGroupSizes((current) => {
        const next = { ...current };
        delete next[sourceGroupId];
        return next;
      });
      rightGroupElementsRef.current.delete(sourceGroupId);
    }
    setActiveFileTabId(tabId);
    setPdfFocusMode(false);
  };

  const applyRightGroupResize = useCallback((clientX: number) => {
    const resize = rightGroupResizeRef.current;
    if (!resize) return;
    const leftElement = rightGroupElementsRef.current.get(resize.leftId);
    const rightElement = rightGroupElementsRef.current.get(resize.rightId);
    if (!leftElement || !rightElement) return;
    const totalWidth = resize.leftWidth + resize.rightWidth;
    const minWidth = Math.min(MIN_SPLIT_GROUP_WIDTH, Math.max(60, totalWidth / 2 - 4));
    const nextLeftWidth = clamp(resize.leftWidth + clientX - resize.startX, minWidth, totalWidth - minWidth);
    const nextRightWidth = totalWidth - nextLeftWidth;
    resize.currentLeftWidth = nextLeftWidth;
    resize.currentRightWidth = nextRightWidth;
    leftElement.style.flexGrow = "0";
    leftElement.style.flexShrink = "0";
    leftElement.style.flexBasis = `${nextLeftWidth}px`;
    rightElement.style.flexGrow = "0";
    rightElement.style.flexShrink = "0";
    rightElement.style.flexBasis = `${nextRightWidth}px`;
  }, []);

  const startRightGroupResize = useCallback((
    leftId: string,
    rightId: string,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (isMobile) return;
    const leftElement = rightGroupElementsRef.current.get(leftId);
    const rightElement = rightGroupElementsRef.current.get(rightId);
    if (!leftElement || !rightElement) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const leftWidth = leftElement.getBoundingClientRect().width;
    const rightWidth = rightElement.getBoundingClientRect().width;
    rightGroupResizeRef.current = {
      pointerId: event.pointerId,
      leftId,
      rightId,
      startX: event.clientX,
      leftWidth,
      rightWidth,
      combinedWeight: Math.max(0.2, (rightGroupSizes[leftId] ?? 1) + (rightGroupSizes[rightId] ?? 1)),
      currentLeftWidth: leftWidth,
      currentRightWidth: rightWidth,
    };
    pendingRightGroupResizeXRef.current = event.clientX;
    shellRef.current?.classList.add("is-panel-resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingRightGroup(rightId);
  }, [isMobile, rightGroupSizes]);

  const moveRightGroupResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (rightGroupResizeRef.current?.pointerId !== event.pointerId) return;
    pendingRightGroupResizeXRef.current = event.clientX;
    if (rightGroupResizeFrameRef.current !== null) return;
    rightGroupResizeFrameRef.current = window.requestAnimationFrame(() => {
      rightGroupResizeFrameRef.current = null;
      const clientX = pendingRightGroupResizeXRef.current;
      if (clientX !== null) applyRightGroupResize(clientX);
    });
  }, [applyRightGroupResize]);

  const stopRightGroupResize = useCallback((event?: PointerEvent<HTMLDivElement>) => {
    const resize = rightGroupResizeRef.current;
    if (!resize || (event && resize.pointerId !== event.pointerId)) return;
    if (rightGroupResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(rightGroupResizeFrameRef.current);
      rightGroupResizeFrameRef.current = null;
    }
    const finalX = event?.clientX ?? pendingRightGroupResizeXRef.current;
    if (finalX !== null && finalX !== undefined) applyRightGroupResize(finalX);
    const totalWidth = Math.max(1, resize.currentLeftWidth + resize.currentRightWidth);
    const leftRatio = resize.currentLeftWidth / totalWidth;
    const leftWeight = resize.combinedWeight * leftRatio;
    const rightWeight = resize.combinedWeight * (1 - leftRatio);
    const leftElement = rightGroupElementsRef.current.get(resize.leftId);
    const rightElement = rightGroupElementsRef.current.get(resize.rightId);
    // Restore ratio-based flex sizing immediately. This also covers the case
    // where the final ratio equals the previous React value and React correctly
    // skips writing an otherwise unchanged style prop.
    if (leftElement) {
      leftElement.style.flexGrow = String(leftWeight);
      leftElement.style.flexShrink = "1";
      leftElement.style.flexBasis = "0px";
    }
    if (rightElement) {
      rightElement.style.flexGrow = String(rightWeight);
      rightElement.style.flexShrink = "1";
      rightElement.style.flexBasis = "0px";
    }
    setRightGroupSizes((current) => ({
      ...current,
      [resize.leftId]: leftWeight,
      [resize.rightId]: rightWeight,
    }));
    rightGroupResizeRef.current = null;
    pendingRightGroupResizeXRef.current = null;
    shellRef.current?.classList.remove("is-panel-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setResizingRightGroup(null);
  }, [applyRightGroupResize]);

  useEffect(() => () => {
    if (rightGroupResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(rightGroupResizeFrameRef.current);
    }
    shellRef.current?.classList.remove("is-panel-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);
  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - FCNPilot` : "FCNPilot 电路设计";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        key={currentAccount.uid}
        viewMode={sidebarView}
        accountUid={currentAccount.uid}
        accountUsername={currentAccount.username}
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        fallbackChatCwd={generalChatCwd}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onProjectDirectoryAdded={showFolderLoadedToast}
        onOpenFile={handleOpenFile}
        onPrefetchFile={preloadFileContent}
        onOpenTimeline={handleOpenTimeline}
        onFileDeleted={handleFileDeleted}
        onFileMoved={handleFileMoved}
        explorerRefreshKey={explorerRefreshKey}
        sourceControlOpen={workspaceSourceControlOpen}
        onCloseSourceControl={() => {
          setWorkspaceSourceControlOpen(false);
          setSidebarView("files");
        }}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onDocQa={handleDocQa}
        uiLanguage={uiLanguage}
        onExplorerRefresh={handleExplorerRefresh}
        onBackgroundTaskDone={handleBackgroundTaskDone}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
      />
      <div style={{
        display: isMobile ? "grid" : "none",
        padding: "6px 8px 8px",
        flexShrink: 0,
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 2,
        borderTop: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
      }}>
        {([
          {
            label: translate("common.models"),
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
            label: uiText.app.agents,
            onClick: () => setAgentsConfigOpen(true),
            disabled: !renderedWorkspaceCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
                <path d="M19 3v4M17 5h4" />
              </svg>
            ),
          },
          {
            label: "MCP",
            onClick: () => setMcpConfigOpen(true),
            disabled: !renderedWorkspaceCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 7V2" /><path d="M15 7V2" />
                <path d="M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Z" />
                <path d="M12 19v3" />
              </svg>
            ),
          },
          {
            label: translate("common.skills"),
            onClick: () => setSkillsConfigOpen(true),
            disabled: !renderedWorkspaceCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
          {
            label: translate("common.plugins"),
            onClick: () => setPluginsConfigOpen(true),
            disabled: !renderedWorkspaceCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 7V2" />
                <path d="M15 7V2" />
                <path d="M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Z" />
                <path d="M12 19v3" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: React.ReactNode }[]).map(({ label, onClick, disabled, icon }) => (
          <button
            key={label}
            onClick={onClick}
            disabled={disabled}
            title={label}
            style={{
              minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
              height: 29, padding: "0 4px", background: "none", border: "none",
              borderRadius: 7, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 11, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
          </button>
        ))}
      </div>
    </>
  );

  const renderThemeButton = (mobile: boolean) => (
    <button
      type="button"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        if (mobile) setMobileToolbarMoreOpen(true);
      }}
      title={translate(themeLabelKey)}
      aria-label={translate(themeLabelKey)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      data-mobile-toolbar-action={mobile ? "theme" : undefined}
    >
      {preference === "light" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : preference === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )}
    </button>
  );

  const renderLanguageButton = (mobile: boolean) => (
    <button
      ref={languageBtnRef}
      type="button"
      onClick={() => toggleTopPanel("language", mobile)}
      title={translate("common.language")}
      aria-label={translate("common.language")}
      aria-haspopup="menu"
      aria-expanded={activeTopPanel === "language"}
      aria-pressed={activeTopPanel === "language"}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: activeTopPanel === "language" ? "var(--bg-selected)" : "none",
        border: "none", borderRight: "1px solid var(--border)",
        color: activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)";
      }}
      data-mobile-toolbar-action={mobile ? "language" : undefined}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m5 8 6 6" />
        <path d="m4 14 6-6 2-3" />
        <path d="M2 5h12" />
        <path d="M7 2h1" />
        <path d="m22 22-5-10-5 10" />
        <path d="M14 18h6" />
      </svg>
    </button>
  );

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (!showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
    return (
      <button
        type="button"
        onClick={() => {
          setProjectTrustError(null);
          setProjectTrustDialogOpen(true);
        }}
        title={translate("trust.resourcesNotLoaded")}
        aria-label={translate("trust.resourcesNotLoaded")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: mobileBanner ? "flex-start" : "center",
          gap: 6,
          width: mobileBanner ? "100%" : undefined,
          minHeight: mobileBanner ? 32 : undefined,
          height: mobileBanner ? undefined : "100%",
          padding: mobileBanner ? "6px 12px" : "0 12px",
          background: mobileBanner ? "color-mix(in srgb, #d97706 8%, var(--bg-panel))" : "none",
          border: "none",
          borderRight: mobileBanner ? "none" : "1px solid var(--border)",
          borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
          color: "#d97706",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 1.35,
          textAlign: "left",
        }}
        data-mobile-trust-banner={mobileBanner ? "true" : undefined}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>{translate("trust.resourcesNotLoaded")}</span>
      </button>
    );
  };

  const renderChatToolbarActions = (mobile: boolean) => {
    if (!mobile && !showChat) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <button
          type="button"
          onClick={() => {
            handleViewFullHistory();
            if (mobile) setMobileToolbarMoreOpen(true);
          }}
          disabled={!selectedSession}
          title={selectedSession ? translate("history.full") : translate("history.unsaved")}
          aria-label={translate("history.full")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%",
            padding: mobile ? 0 : "0 12px",
            background: "none",
            border: "none",
            borderTop: "2px solid transparent",
            borderRight: "1px solid var(--border)",
            color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
            cursor: selectedSession ? "pointer" : "not-allowed",
            opacity: selectedSession ? 1 : 0.45,
            flexShrink: 0,
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(event) => {
            if (!selectedSession) return;
            event.currentTarget.style.color = "var(--text)";
            event.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
            event.currentTarget.style.background = "none";
          }}
          data-mobile-toolbar-action={mobile ? "history" : undefined}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
          {!mobile && <span>{translate("history.label")}</span>}
        </button>
        {(() => {
          // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
          const hasMessages = Boolean(
            selectedSession
            && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
          );
          const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
          const isSuccess = autoNameStatus.kind === "success";
          const isError = autoNameStatus.kind === "error";
          const label = autoNameStatus.kind === "naming"
            ? translate("title.generating")
            : isSuccess
              ? translate("title.updated")
              : isError
                ? translate("title.failed")
                : translate("title.generate");
          const title = !selectedSession || selectedSession.transient
            ? translate("title.unsaved")
            : !hasMessages
              ? translate("title.noMessages")
              : isError
                ? autoNameStatus.message
                : translate("title.generateSession");

          return (
            <button
              type="button"
              onClick={() => {
                void handleAutoName();
                if (mobile) setMobileToolbarMoreOpen(true);
              }}
              disabled={disabled}
              title={title}
              aria-label={label}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
                height: "100%", padding: mobile ? 0 : "0 12px",
                background: "none", border: "none",
                borderTop: "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(event) => {
                if (disabled) return;
                event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                event.currentTarget.style.background = "none";
              }}
              data-mobile-toolbar-action={mobile ? "name" : undefined}
            >
              {autoNameStatus.kind === "naming" ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : isSuccess ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 4 5 5L7 22l-5-5Z" />
                  <path d="m14 5 5 5" />
                  <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                </svg>
              )}
              {!mobile && <span>{label}</span>}
            </button>
          );
        })()}
        {mobile ? (
          <button
            type="button"
            onClick={() => toggleTopPanel("branches", true)}
            title={translate("i18n.branches")}
            aria-label={translate("i18n.branches")}
            aria-pressed={activeTopPanel === "branches"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: activeTopPanel === "branches" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "branches" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "branches" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
            }}
            data-mobile-toolbar-action="branches"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: branchTree.length > 0 ? "var(--accent)" : "var(--text-dim)" }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
        ) : (
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            inline
            containerRef={topBarRef}
            open={activeTopPanel === "branches"}
            onToggle={() => toggleTopPanel("branches")}
            hasSession
          />
        )}
        <button
          ref={systemBtnRef}
          type="button"
          onClick={() => handleSystemPromptToggle(mobile)}
          disabled={mobile && !showChat}
          title={translate("system.prompt")}
          aria-label={translate("system.prompt")}
          aria-pressed={activeTopPanel === "system"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "system" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
          {!mobile && <span>{translate("system.label")}</span>}
        </button>
        {mobile && renderThemeButton(true)}
        {mobile && renderLanguageButton(true)}
      </div>
    );
  };

  const renderSessionStatsButton = (mobile: boolean) => {
    if (!mobile && (!showChat || (!sessionStats && !contextUsage))) return null;

    const tokens = sessionStats?.tokens;
    const cost = sessionStats?.cost ?? 0;
    const formatCompact = (value: number) => value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(0)}k`
        : String(value);
    const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`) : null;

    let contextColor = "var(--text-muted)";
    let desktopContextText: string | null = null;
    let mobileContextText: string | null = null;
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      if (percent !== null && percent > 90) contextColor = "#ef4444";
      else if (percent !== null && percent > 70) contextColor = "rgba(234,179,8,0.95)";
      desktopContextText = percent !== null
        ? `${percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
        : `? / ${formatCompact(contextUsage.contextWindow)}`;
      mobileContextText = percent !== null ? `${percent.toFixed(0)}%` : null;
    }

    const tooltipParts: string[] = [];
    if (tokens) {
      tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
      tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
      tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
      tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
      if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
    }
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      tooltipParts.push(`context: ${percent !== null ? percent.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
    }
    const tooltip = tooltipParts.join("  |  ");
    const covered = mobile && mobileToolbarMoreOpen;
    const hasMobileValues = Boolean(
      (tokens && (tokens.input > 0 || tokens.output > 0))
      || costText
      || mobileContextText,
    );

    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
        disabled={!showChat || covered}
        tabIndex={covered ? -1 : undefined}
        title={tooltip || translate("session.title")}
        aria-label={translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
        aria-hidden={covered ? true : undefined}
        className={mobile ? "mobile-session-stats" : undefined}
        data-mobile-toolbar-stats={mobile ? "true" : undefined}
        style={{
          marginLeft: mobile ? 0 : "auto",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          flex: mobile ? 1 : undefined,
          minWidth: 0,
          gap: mobile ? 7 : 10,
          paddingLeft: mobile ? 6 : 12,
          paddingRight: mobile ? 6 : 12,
          height: "100%",
          overflow: "hidden",
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: showChat ? "pointer" : "default",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(event) => {
          if (showChat && !covered) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {mobile ? (
          <>
            {tokens && tokens.input > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {costText && (
              <span className="mobile-session-stat-cost" style={{ color: "var(--text)", fontWeight: 500, flexShrink: 0 }}>
                {costText}
              </span>
            )}
            {mobileContextText && (
              <span style={{ color: contextColor, flexShrink: 0 }}>
                {mobileContextText}
              </span>
            )}
            {!hasMobileValues && showChat && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>
                {translate("session.title")}
              </span>
            )}
          </>
        ) : (
          <>
            {tokens && tokens.input > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {tokens && tokens.cacheRead > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                </svg>
                {formatCompact(tokens.cacheRead)}
              </span>
            )}
            {costText && (
              <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                {costText}
              </span>
            )}
            {desktopContextText && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, color: contextColor }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                </svg>
                {desktopContextText}
              </span>
            )}
          </>
        )}
      </button>
    );
  };

  const renderMainFileToggle = (mobile: boolean) => {
    const covered = mobile && mobileToolbarMoreOpen;
    return (
      <button
        type="button"
        onClick={handleRightPanelToggle}
        disabled={covered}
        tabIndex={covered ? -1 : undefined}
        aria-controls="file-panel"
        aria-expanded={rightPanelOpen}
        aria-hidden={covered ? true : undefined}
        title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          marginLeft: !mobile && !sessionStats && !contextUsage ? "auto" : 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: rightPanelOpen ? "var(--bg-selected)" : "none",
          border: "none", borderLeft: "1px solid var(--border)",
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(event) => { if (!covered) event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    );
  };

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      .mobile-session-stats {
        container-type: inline-size;
      }
      @container (max-width: 158px) {
        .mobile-session-stat-io {
          display: none !important;
        }
      }
      @container (max-width: 88px) {
        .mobile-session-stat-cost {
          display: none !important;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
      .sidebar-container.is-resizing,
      .right-panel-container.is-resizing,
      .is-panel-resizing .sidebar-container,
      .is-panel-resizing .right-panel-container {
        transition: none !important;
        will-change: width, min-width;
      }
      .is-panel-resizing .integrated-terminal-shell {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      .panel-resize-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 5px;
        z-index: 260;
        cursor: col-resize;
        touch-action: none;
      }
      .panel-resize-handle::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 3px;
        width: 1px;
        background: transparent;
        transition: background 0.12s, box-shadow 0.12s;
      }
      .panel-resize-handle:hover::after,
      .panel-resize-handle.is-resizing::after {
        background: var(--accent);
      }
      .panel-resize-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999;
        cursor: col-resize;
        user-select: none;
        background: transparent;
      }
      .split-group-resize-handle {
        position: relative;
        flex: 0 0 5px;
        width: 5px;
        min-width: 5px;
        cursor: col-resize;
        touch-action: none;
        background: transparent;
        z-index: 40;
      }
      .split-group-resize-handle::after {
        content: "";
        position: absolute;
        inset: 0 2px;
        background: var(--border);
        transition: background 0.12s, box-shadow 0.12s;
      }
      .split-group-resize-handle:hover::after,
      .split-group-resize-handle.is-resizing::after {
        background: var(--accent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent);
      }
    `}</style>
    <div
      ref={shellRef}
      className="app-shell-root"
      style={{
        "--sidebar-width": `${activeResize?.panel === "sidebar" ? activeResize.currentWidth : sidebarWidth}px`,
        "--right-panel-width": `${activeResize?.panel === "right" ? activeResize.currentWidth : rightPanelWidth}px`,
        display: "flex",
        height: "var(--app-viewport-height, 100dvh)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        overflow: "hidden",
        position: "relative",
        background: "var(--bg)",
      } as CSSProperties}
    >
      {/* VS Code-style activity rail. Global actions live here; the chat has no tool header. */}
      {!isMobile && (
        <div
          ref={activityBarRef}
          className="activity-bar"
          style={{
            width: 42,
            minWidth: 42,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            borderRight: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--bg-panel) 96%, var(--bg))",
            zIndex: 320,
          }}
        >
          <ActivityButton
            label={uiLanguage === "zh" ? "会话" : "Sessions"}
            active={sidebarOpen && sidebarView === "sessions"}
            onClick={() => {
              setActiveTopPanel(null);
              setSidebarView("sessions");
              setSidebarOpen((open) => sidebarView === "sessions" ? !open : true);
            }}
          >
            {!sidebarOpen ? (
              <FcnPilotIcon size={21} />
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></svg>
            )}
          </ActivityButton>
          <ActivityButton
            label={uiLanguage === "zh" ? "文件" : "Files"}
            active={sidebarOpen && sidebarView === "files"}
            onClick={() => {
              setActiveTopPanel(null);
              setSidebarView("files");
              setSidebarOpen((open) => sidebarView === "files" ? !open : true);
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10h-17Z" /><path d="M3.5 9h17" /></svg>
          </ActivityButton>
          <ActivityButton ref={toolsButtonRef} label={uiText.app.tools} active={activeTopPanel === "tools"} onClick={() => { setChatPanelCollapsed(false); toggleTopPanel("tools"); }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5-5L7.4 3.6l3 3-3.8 3.8-3-3L1.3 10.7a4 4 0 0 0 5 5l8.4-8.4Z" /><path d="m13 11 8 8-2 2-8-8" /></svg>
          </ActivityButton>
          {generatedCodePanel && (
            <ActivityButton
              label={uiLanguage === "zh" ? "打开生成代码" : "Open generated code"}
              active={generatedCodeTabOpen && rightPanelOpen}
              onClick={openGeneratedCodeTab}
            >
              <span style={{ position: "relative", display: "grid", placeItems: "center", width: 24, height: 24 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
                </svg>
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -5,
                    minWidth: 13,
                    height: 13,
                    padding: "0 3px",
                    display: "grid",
                    placeItems: "center",
                    border: "1px solid var(--bg-panel)",
                    borderRadius: 999,
                    background: "var(--accent)",
                    color: "white",
                    fontSize: 8,
                    fontWeight: 800,
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {generatedCodePanel.artifacts.length}
                </span>
              </span>
            </ActivityButton>
          )}
          {(() => {
            const upperItems = pinnedActivityItems.filter((id) => !LOWER_ACTIVITY_IDS.has(id));
            const lowerItems = pinnedActivityItems.filter((id) => LOWER_ACTIVITY_IDS.has(id));
            return (
              <>
              {[...upperItems, ...lowerItems].map((id, index) => {
                const startsLowerSection = index === upperItems.length;
            if (id === "branches") {
              if (!showChat) return null;
              return (
                <Fragment key={id}>
                  {startsLowerSection && <div style={{ flex: 1 }} />}
                  <div>
                  <BranchNavigator
                    tree={branchTree}
                    activeLeafId={branchActiveLeafId}
                    onLeafChange={handleBranchLeafChange}
                    inline
                    compact
                    activityBar
                    containerRef={activityBarRef}
                    open={activeTopPanel === "branches"}
                    onToggle={() => { setChatPanelCollapsed(false); toggleTopPanel("branches"); }}
                    hasSession
                    uiLanguage={uiLanguage}
                  />
                  </div>
                </Fragment>
              );
            }
            const definition = id === "cli" ? {
              label: uiText.app.cliSync,
              disabled: !renderedWorkspaceCwd || cliLoading,
              active: activeTopPanel === "cli",
              onClick: () => void handleCliSync(),
              icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h16v16H4zM8 9l3 3-3 3M13 15h3" /></svg>,
            } : id === "terminal" ? {
              label: uiText.app.terminal,
              disabled: !renderedWorkspaceCwd,
              active: workspaceTerminalActive,
              onClick: toggleWorkspaceTerminalTab,
              icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>,
            } : id === "source-control" ? {
              label: uiText.app.sourceControl,
              disabled: !renderedWorkspaceCwd,
              active: sidebarOpen && sidebarView === "source-control",
              onClick: () => {
                setActiveTopPanel(null);
                setWorkspaceSourceControlOpen(true);
                setSidebarView("source-control");
                setSidebarOpen((open) => sidebarView === "source-control" ? !open : true);
              },
              icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12M8 8h5a5 5 0 0 1 5 5" /></svg>,
            } : id === "export" ? {
              label: uiText.app.export,
              disabled: !selectedSession,
              active: false,
              onClick: handleExportSession,
              icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 19h16" /></svg>,
            } : id === "models" ? {
              label: uiText.app.models,
              disabled: false,
              active: modelsConfigOpen,
              onClick: () => setModelsConfigOpen(true),
              icon: <ManageFeatureIcon kind="models" compact />,
            } : id === "agents" ? {
              label: uiText.app.agents,
              disabled: !renderedWorkspaceCwd,
              active: agentsConfigOpen,
              onClick: () => setAgentsConfigOpen(true),
              icon: <ManageFeatureIcon kind="agents" compact />,
            } : id === "mcp" ? {
              label: "MCP",
              disabled: !renderedWorkspaceCwd,
              active: mcpConfigOpen,
              onClick: () => setMcpConfigOpen(true),
              icon: <ManageFeatureIcon kind="mcp" compact />,
            } : id === "skills" ? {
              label: uiText.app.skills,
              disabled: !renderedWorkspaceCwd,
              active: skillsConfigOpen,
              onClick: () => setSkillsConfigOpen(true),
              icon: <ManageFeatureIcon kind="skills" compact />,
            } : {
              label: uiText.app.plugins,
              disabled: !renderedWorkspaceCwd,
              active: pluginsConfigOpen,
              onClick: () => setPluginsConfigOpen(true),
              icon: <ManageFeatureIcon kind="plugins" compact />,
            };
            return (
              <Fragment key={id}>
                {startsLowerSection && (
                  <>
                    <div style={{ flex: 1 }} />
                    <div
                      aria-hidden="true"
                      style={{
                        width: 22,
                        margin: "2px auto 3px",
                        borderTop: "1px solid var(--border)",
                      }}
                    />
                  </>
                )}
                <ActivityButton
                  label={definition.label}
                  active={definition.active}
                  disabled={definition.disabled}
                  onClick={definition.onClick}
                >
                  {definition.icon}
                </ActivityButton>
              </Fragment>
            );
              })}
              {lowerItems.length === 0 && <div style={{ flex: 1 }} />}
              </>
            );
          })()}
          <ActivityButton ref={manageButtonRef} label={uiLanguage === "zh" ? "模型与扩展" : "Models and extensions"} active={activeTopPanel === "manage"} onClick={() => { setChatPanelCollapsed(false); toggleTopPanel("manage"); }}>
            <span className="activity-manage-robot" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
                <path d="M14 6V3.8" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
                <circle cx="14" cy="2.8" r="1.3" fill="currentColor" />
                <path d="M5.2 13H3.5v4.2h1.7M22.8 13h1.7v4.2h-1.7" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="5.2" y="6" width="17.6" height="16.2" rx="5.3" stroke="currentColor" strokeWidth="1.65" />
                <circle cx="10.5" cy="13.4" r="1.65" fill="currentColor" />
                <circle cx="17.5" cy="13.4" r="1.65" fill="currentColor" />
                <path d="M10.4 18.1c1 .75 2.2 1.1 3.6 1.1s2.6-.35 3.6-1.1" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
              </svg>
              {pinnedActivityItems.some((id) => LOWER_ACTIVITY_IDS.has(id)) && (
                <span className="activity-manage-count">
                  {pinnedActivityItems.filter((id) => LOWER_ACTIVITY_IDS.has(id)).length}
                </span>
              )}
            </span>
          </ActivityButton>
          <ActivityButton ref={settingsButtonRef} label={uiText.app.settings} active={activeTopPanel === "settings"} onClick={() => { setChatPanelCollapsed(false); toggleTopPanel("settings"); }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.14.36.35.69.6 1 .3.28.7.42 1.1.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></svg>
          </ActivityButton>
        </div>
      )}
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${hydrationReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${hydrationReady ? "" : " sidebar-mobile-pending"}${resizingPanel === "sidebar" ? " is-resizing" : ""}`}
        id="session-sidebar"
        style={{
          "--sidebar-width": `${activeResize?.panel === "sidebar" ? activeResize.currentWidth : sidebarWidth}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          position: "relative",
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {/* Center: chat */}
      <div style={{ flex: 1, display: chatPanelCollapsed ? "none" : "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div className="legacy-chat-topbar" ref={topBarRef} style={{ flexShrink: 0, background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", position: "relative", borderBottom: "1px solid var(--border)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)" }}>
          <button
            onClick={handleSidebarToggle}
            title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {isMobile && (
            <div
              ref={mobileToolbarRef}
              data-mobile-toolbar="true"
              style={{
                position: "relative",
                display: "flex",
                alignItems: "stretch",
                flex: 1,
                minWidth: 0,
                height: "100%",
              }}
            >
              <button
                type="button"
                onClick={handleMobileToolbarMoreToggle}
                title={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                aria-label={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                aria-controls="mobile-toolbar-actions"
                aria-expanded={mobileToolbarMoreOpen}
                data-mobile-toolbar-more="true"
                style={{
                  position: "relative",
                  zIndex: mobileToolbarMoreOpen ? 21 : undefined,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                  background: mobileToolbarMoreOpen ? "var(--bg-selected)" : "none",
                  border: "none", borderRight: "1px solid var(--border)",
                  color: mobileToolbarMoreOpen ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
                }}
              >
                {mobileToolbarMoreOpen ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                  </svg>
                ) : (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                  </svg>
                )}
              </button>
              {renderSessionStatsButton(true)}
              {renderMainFileToggle(true)}
              {mobileToolbarMoreOpen && (
                <div
                  id="mobile-toolbar-actions"
                  role="toolbar"
                  aria-label={translate("chat.moreControls")}
                  data-mobile-toolbar-actions="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: TOP_BAR_ICON_BUTTON_SIZE,
                    zIndex: 20,
                    display: "flex",
                    alignItems: "stretch",
                    background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
                    boxShadow: "4px 0 18px rgba(0,0,0,0.12)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {renderChatToolbarActions(true)}
                </div>
              )}
            </div>
          )}
          {!isMobile && (
            <>
              {renderThemeButton(false)}
              {renderLanguageButton(false)}
              {renderProjectTrustWarning(false)}
              {renderChatToolbarActions(false)}
              {renderSessionStatsButton(false)}
            </>
          )}
          {!isMobile && renderMainFileToggle(false)}
          {isMobile && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              inline
              compact
              containerRef={topBarRef}
              open={activeTopPanel === "branches"}
              onToggle={() => toggleTopPanel("branches")}
              hasSession={showChat}
              hideInlineButton
            />
          )}
        </div>
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div className="top-panel-host" style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
              visibility: "visible",
              pointerEvents: "auto",
            }}>
              {activeTopPanel === "sessions" && (
                <div
                  role="tablist"
                  aria-label={uiLanguage === "zh" ? "会话标签" : "Session tabs"}
                  style={{
                    width: 300,
                    maxHeight: "calc(100dvh - 12px)",
                    margin: 6,
                    padding: 6,
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    background: "color-mix(in srgb, var(--bg-panel) 97%, transparent)",
                    boxShadow: "0 16px 42px rgba(0,0,0,0.18), 0 3px 10px rgba(0,0,0,0.08)",
                    backdropFilter: "blur(16px)",
                  }}
                >
                  <div style={{ padding: "5px 9px 7px", color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    {uiLanguage === "zh" ? "打开的会话" : "Open sessions"}
                  </div>
                  {sessionTabs.length === 0 ? (
                    <div style={{ padding: "12px 9px", color: "var(--text-dim)", fontSize: 11 }}>
                      {uiLanguage === "zh" ? "暂无打开的会话" : "No open sessions"}
                    </div>
                  ) : sessionTabs.map((session) => {
                    const active = selectedSession?.id === session.id;
                    const label = session.name?.trim() || session.firstMessage?.trim() || (uiLanguage === "zh" ? "新会话" : "New session");
                    return (
                      <div
                        key={session.id}
                        role="tab"
                        aria-selected={active}
                        onClick={() => {
                          activateSessionTab(session);
                          setActiveTopPanel(null);
                        }}
                        style={{
                          height: 34,
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "0 5px 0 9px",
                          borderRadius: 6,
                          borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                          background: active ? "var(--bg-selected)" : "transparent",
                          color: active ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer",
                          fontSize: 11,
                        }}
                      >
                        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: active ? 650 : 450 }}>{label}</span>
                        <button
                          type="button"
                          title={uiText.common.close}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeSessionTab(session.id);
                          }}
                          style={{ width: 20, height: 20, padding: 0, display: "grid", placeItems: "center", border: 0, borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m2 2 6 6M8 2 2 8" /></svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {activeTopPanel === "manage" && (
                <div
                  role="menu"
                  aria-label={uiLanguage === "zh" ? "模型与扩展" : "Models and extensions"}
                  style={{
                    width: 278,
                    margin: 0,
                    padding: 6,
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    background: "color-mix(in srgb, var(--bg-panel) 97%, transparent)",
                    boxShadow: "0 16px 42px rgba(0,0,0,0.18), 0 3px 10px rgba(0,0,0,0.08)",
                    backdropFilter: "blur(16px)",
                  }}
                >
                  <div style={{ padding: "5px 9px 7px", color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    {uiLanguage === "zh" ? "模型与扩展" : "Models and extensions"}
                  </div>
                  {([
                    ["models", uiText.app.models, () => setModelsConfigOpen(true), false],
                    ["agents", uiText.app.agents, () => setAgentsConfigOpen(true), !renderedWorkspaceCwd],
                    ["mcp", "MCP", () => setMcpConfigOpen(true), !renderedWorkspaceCwd],
                    ["skills", uiText.app.skills, () => setSkillsConfigOpen(true), !renderedWorkspaceCwd],
                    ["plugins", uiText.app.plugins, () => setPluginsConfigOpen(true), !renderedWorkspaceCwd],
                  ] as Array<[PinnableActivityId, string, () => void, boolean]>).map(([id, label, open, disabled]) => {
                    const pinned = pinnedActivityItems.includes(id);
                    return (
                    <div
                      key={id}
                      className="top-tools-menu-item"
                      style={{
                        width: "100%",
                        minHeight: 36,
                        padding: "0 9px",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        borderRadius: 6,
                        background: "transparent",
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        aria-disabled={disabled}
                        onClick={() => {
                          if (disabled) return;
                          setActiveTopPanel(null);
                          open();
                        }}
                        style={{
                          minWidth: 0,
                          minHeight: 34,
                          flex: 1,
                          padding: 0,
                          display: "flex",
                          alignItems: "center",
                          gap: 9,
                          border: 0,
                          background: "transparent",
                          color: disabled ? "var(--text-dim)" : "var(--text-muted)",
                          cursor: disabled ? "not-allowed" : "pointer",
                          opacity: disabled ? 0.45 : 1,
                          fontFamily: "inherit",
                          fontSize: 12,
                          fontWeight: 600,
                          textAlign: "left",
                        }}
                      >
                        <ManageFeatureIcon kind={id as ManageFeatureKind} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                        {pinned && (
                          <span className="manage-pinned-label">
                            {uiLanguage === "zh" ? "已在左栏" : "Pinned"}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={pinned
                          ? (uiLanguage === "zh" ? `从侧栏移除 ${label}` : `Remove ${label} from sidebar`)
                          : (uiLanguage === "zh" ? `将 ${label} 添加到侧栏` : `Add ${label} to sidebar`)}
                        title={pinned
                          ? (uiLanguage === "zh" ? "从侧栏移除" : "Remove from sidebar")
                          : (uiLanguage === "zh" ? "添加到侧栏" : "Add to sidebar")}
                        onClick={() => pinned ? unpinActivityItem(id) : pinActivityItem(id)}
                        style={{
                          width: 24,
                          height: 24,
                          padding: 0,
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: pinned ? "var(--bg-selected)" : "transparent",
                          color: pinned ? "var(--accent)" : "var(--text-muted)",
                          cursor: "pointer",
                          fontSize: 16,
                          lineHeight: 1,
                        }}
                      >
                        {pinned ? "−" : "+"}
                      </button>
                    </div>
                    );
                  })}
                </div>
              )}
              {activeTopPanel === "settings" && (
                <div
                  ref={settingsMenuRef}
                  role="menu"
                  aria-label={uiText.app.settings}
                  style={{
                    width: 264,
                    margin: 0,
                    padding: 6,
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    background: "color-mix(in srgb, var(--bg-panel) 97%, transparent)",
                    boxShadow: "0 16px 42px rgba(0,0,0,0.18), 0 3px 10px rgba(0,0,0,0.08)",
                    backdropFilter: "blur(16px)",
                  }}
                >
                  <div style={{ padding: "5px 9px 7px", color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    {uiText.app.settings}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="top-tools-menu-item"
                    onClick={() => {
                      const rect = settingsButtonRef.current?.getBoundingClientRect();
                      setActiveTopPanel(null);
                      toggleTheme(rect ? { x: rect.left + rect.width / 2, y: rect.bottom } : undefined);
                    }}
                    style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr)", alignItems: "center", gap: 8, width: "100%", minHeight: 38, padding: "5px 8px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                  >
                    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      {isDark ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></svg>
                      )}
                    </span>
                    <span>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>{isDark ? uiText.app.switchLight : uiText.app.switchDark}</span>
                      <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontSize: 9 }}>{uiLanguage === "zh" ? `当前：${isDark ? "深色" : "浅色"}` : `Current: ${isDark ? "Dark" : "Light"}`}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="top-tools-menu-item"
                    onClick={() => {
                      setUiLanguage((current) => current === "zh" ? "en" : "zh");
                      setActiveTopPanel(null);
                    }}
                    style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr)", alignItems: "center", gap: 8, width: "100%", minHeight: 38, padding: "5px 8px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                  >
                    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21M12 3C9.5 5.7 8.2 8.7 8.2 12S9.5 18.3 12 21" /></svg>
                    </span>
                    <span>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>{uiText.app.language}</span>
                      <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontSize: 9 }}>{uiLanguage === "zh" ? "中文 → English" : "English → 中文"}</span>
                    </span>
                  </button>
                </div>
              )}
              {activeTopPanel === "tools" && (() => {
                const groups: Array<Array<{
                  id: string;
                  label: string;
                  detail?: string;
                  icon: React.ReactNode;
                  active?: boolean;
                  disabled?: boolean;
                  pinId?: PinnableActivityId;
                  onClick: () => void;
                }>> = [
                  [
                    {
                      id: "cli",
                      pinId: "cli",
                      label: uiText.app.cliSync,
                      detail: renderedWorkspaceCwd ? (cliCopied ? uiText.common.copied : uiText.app.cliSyncTitle) : uiText.cliSync.selectProject,
                      disabled: !renderedWorkspaceCwd || cliLoading,
                      icon: (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="4" width="18" height="16" rx="2" /><polyline points="7 9 10 12 7 15" /><line x1="13" y1="15" x2="17" y2="15" />
                        </svg>
                      ),
                      onClick: () => void handleCliSync(),
                    },
                    {
                      id: "terminal",
                      pinId: "terminal",
                      label: uiText.app.terminal,
                      detail: !renderedWorkspaceCwd ? uiText.app.selectWorkspaceFirst : workspaceTerminalActive ? uiText.app.hideTerminal : uiText.app.openTerminal,
                      active: workspaceTerminalActive,
                      disabled: !renderedWorkspaceCwd,
                      icon: (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="4" width="18" height="16" rx="2" /><polyline points="7 9 10 12 7 15" /><line x1="13" y1="15" x2="17" y2="15" />
                        </svg>
                      ),
                      onClick: () => {
                        toggleWorkspaceTerminalTab();
                        setActiveTopPanel(null);
                      },
                    },
                    {
                      id: "branches",
                      pinId: "branches",
                      label: uiLanguage === "zh" ? "分支" : "Branches",
                      detail: showChat
                        ? (uiLanguage === "zh" ? "查看和切换会话分支" : "View and switch conversation branches")
                        : (uiLanguage === "zh" ? "请先打开会话" : "Open a conversation first"),
                      disabled: !showChat,
                      active: false,
                      icon: (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="6" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12M8 8h5a5 5 0 0 1 5 5" />
                        </svg>
                      ),
                      onClick: () => toggleTopPanel("branches"),
                    },
                    {
                      id: "source-control",
                      pinId: "source-control",
                      label: uiText.app.sourceControl,
                      detail: !renderedWorkspaceCwd
                        ? uiText.app.selectWorkspaceFirst
                        : workspaceSourceControlOpen
                          ? uiText.app.closeSourceControl
                          : uiText.app.openSourceControl,
                      active: workspaceSourceControlOpen,
                      disabled: !renderedWorkspaceCwd,
                      icon: (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="6" cy="4" r="2" />
                          <circle cx="18" cy="8" r="2" />
                          <circle cx="6" cy="20" r="2" />
                          <path d="M6 6v12M8 8h5a5 5 0 0 1 5 5" />
                        </svg>
                      ),
                      onClick: () => {
                        setWorkspaceSourceControlOpen(true);
                        setSidebarView("source-control");
                        setSidebarOpen(true);
                        setActiveTopPanel(null);
                      },
                    },
                    {
                      id: "token-usage",
                      label: uiLanguage === "zh" ? "Token 使用情况" : "Token usage",
                      detail: hasSessionInfoButton
                        ? (uiLanguage === "zh" ? "查看上下文窗口与会话统计" : "View context window and session statistics")
                        : (uiLanguage === "zh" ? "当前没有可用的会话统计" : "No session statistics available"),
                      disabled: !hasSessionInfoButton,
                      icon: (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19V9M10 19V5M16 19v-7M22 19V3" /><path d="M2 19h21" /></svg>
                      ),
                      onClick: openSessionStatsPanel,
                    },
                  ],
                  ...(showChat ? [[
                    {
                      id: "export",
                      pinId: "export" as PinnableActivityId,
                      label: uiText.app.exportHtml,
                      detail: selectedSession ? uiText.app.export : uiText.app.exportUnavailable,
                      disabled: !selectedSession,
                      icon: (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      ),
                      onClick: () => {
                        handleExportSession();
                        setActiveTopPanel(null);
                      },
                    },
                  ]] : []),
                ];

                return (
                  <div
                    ref={toolsMenuRef}
                    role="menu"
                    aria-label={uiText.app.tools}
                    style={{
                      width: 264,
                      margin: 0,
                      padding: 6,
                      border: "1px solid var(--border)",
                      borderRadius: 9,
                      background: "color-mix(in srgb, var(--bg-panel) 97%, transparent)",
                      boxShadow: "0 16px 42px rgba(0,0,0,0.18), 0 3px 10px rgba(0,0,0,0.08)",
                      backdropFilter: "blur(16px)",
                    }}
                  >
                    <div style={{ padding: "5px 9px 7px", color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      {uiText.app.tools}
                    </div>
                    {groups.map((group, groupIndex) => (
                      <div key={groupIndex} style={groupIndex > 0 ? { marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--border)" } : undefined}>
                        {group.map((item) => {
                          const pinned = item.pinId ? pinnedActivityItems.includes(item.pinId) : false;
                          return (
                          <div
                            key={item.id}
                            className="top-tools-menu-item"
                            style={{
                              display: "grid",
                              gridTemplateColumns: "20px minmax(0, 1fr) 26px",
                              alignItems: "center",
                              gap: 8,
                              width: "100%",
                              minHeight: 38,
                              padding: "5px 8px",
                              border: 0,
                              borderRadius: 6,
                              background: item.active ? "var(--bg-selected)" : "transparent",
                              color: item.active ? "var(--text)" : "var(--text-muted)",
                              fontFamily: "inherit",
                              textAlign: "left",
                            }}
                          >
                            <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", color: item.active ? "var(--accent)" : "currentColor" }}>{item.icon}</span>
                            <button
                              type="button"
                              role="menuitem"
                              aria-disabled={item.disabled}
                              onClick={() => {
                                if (!item.disabled) item.onClick();
                              }}
                              style={{
                                minWidth: 0,
                                padding: 0,
                                border: 0,
                                background: "transparent",
                                color: item.disabled ? "var(--text-dim)" : "inherit",
                                cursor: item.disabled ? "not-allowed" : "pointer",
                                opacity: item.disabled ? 0.48 : 1,
                                fontFamily: "inherit",
                                textAlign: "left",
                              }}
                            >
                              <span style={{ display: "block", color: item.active ? "var(--text)" : "currentColor", fontSize: 12, fontWeight: 600 }}>{item.label}</span>
                              {item.detail && <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 9 }}>{item.detail}</span>}
                            </button>
                            {item.pinId ? (
                              <button
                                type="button"
                                aria-label={pinned
                                  ? (uiLanguage === "zh" ? `从侧栏移除 ${item.label}` : `Remove ${item.label} from sidebar`)
                                  : (uiLanguage === "zh" ? `将 ${item.label} 添加到侧栏` : `Add ${item.label} to sidebar`)}
                                title={pinned
                                  ? (uiLanguage === "zh" ? "从侧栏移除" : "Remove from sidebar")
                                  : (uiLanguage === "zh" ? "添加到侧栏" : "Add to sidebar")}
                                onClick={() => pinned ? unpinActivityItem(item.pinId!) : pinActivityItem(item.pinId!)}
                                style={{
                                  width: 24,
                                  height: 24,
                                  padding: 0,
                                  display: "grid",
                                  placeItems: "center",
                                  border: "1px solid var(--border)",
                                  borderRadius: 6,
                                  background: pinned ? "var(--bg-selected)" : "transparent",
                                  color: pinned ? "var(--accent)" : "var(--text-muted)",
                                  cursor: "pointer",
                                  fontSize: 16,
                                  lineHeight: 1,
                                }}
                              >
                                {pinned ? "−" : "+"}
                              </button>
                            ) : (
                              <span aria-hidden="true" style={{ color: "var(--accent)", fontSize: 9 }}>{item.active ? "●" : ""}</span>
                            )}
                          </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                );
              })()}
              {activeTopPanel === "language" && (
                <div
                  role="menu"
                  aria-label={translate("common.language")}
                  style={{
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        setActiveTopPanel(null);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        width: "100%",
                        height: 34,
                        padding: "0 10px",
                        border: 0,
                        borderRadius: 4,
                        background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                      }}
                    >
                      {plugin.label}
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {translate("system.empty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {systemPromptLoading ? translate("system.loading") : translate("system.load")}
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "cli" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 12px 32px rgba(0,0,0,0.12)",
                  padding: isMobile ? "12px" : "14px 16px",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text)", fontSize: 12, fontWeight: 800 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="3" y="4" width="18" height="16" rx="2" />
                          <polyline points="7 9 10 12 7 15" />
                          <line x1="13" y1="15" x2="17" y2="15" />
                        </svg>
                        {cliCopied ? uiText.cliSync.copied : uiText.app.cliSyncTitle}
                      </div>
                      {cliWorkspaceCwd && (
                        <div style={{ marginTop: 5, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {uiText.cliSync.workspace}: {cliWorkspaceCwd}
                        </div>
                      )}
                    </div>
                    {cliCommand && (
                      <button
                        type="button"
                        onClick={() => handleCopyCliCommand()}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6,
                          height: 30, padding: "0 10px", flexShrink: 0,
                          border: "1px solid var(--border)", borderRadius: 7,
                          background: cliCopied ? "rgba(34,197,94,0.10)" : "var(--bg)",
                          color: cliCopied ? "#16a34a" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 11, fontWeight: 700,
                        }}
                      >
                        {cliCopied ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                        )}
                        {cliCopied ? uiText.common.copied : uiText.common.copy}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveTopPanel(null)}
                      title={uiText.common.close}
                      aria-label={uiText.common.close}
                      style={{
                        width: 30, height: 30, padding: 0, flexShrink: 0,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        border: "1px solid var(--border)", borderRadius: 7,
                        background: "var(--bg)", color: "var(--text-muted)",
                        cursor: "pointer", fontSize: 16, lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </div>

                  {cliLoading && (
                    <div style={{ height: 58, display: "flex", alignItems: "center", padding: "0 12px", borderRadius: 9, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12 }}>
                      {uiText.cliSync.loading}
                    </div>
                  )}
                  {cliError && (
                    <div style={{ padding: "10px 12px", borderRadius: 9, border: "1px solid rgba(248,113,113,0.35)", background: "rgba(248,113,113,0.06)", color: "#dc2626", fontSize: 12 }}>
                      <strong>{uiText.cliSync.failed}:</strong> {cliError}
                    </div>
                  )}
                  {cliCommand && (
                    <div style={{ overflow: "hidden", borderRadius: 10, border: "1px solid rgba(255,255,255,0.08)", background: "#111214" }}>
                      <pre style={{ margin: 0, padding: "11px 13px", overflowX: "auto", color: "#e5e7eb", fontSize: 11, lineHeight: 1.6, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        <span style={{ color: "#22c55e" }}>$</span> {cliCommand}
                      </pre>
                    </div>
                  )}
                  {!cliLoading && !cliError && cliCommand && (
                    <div style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 11 }}>{uiText.cliSync.hint}</div>
                  )}
                </div>
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const formatDuration = (ms: number) => {
                      if (ms <= 0) return "0s";
                      const totalSec = Math.floor(ms / 1000);
                      const h = Math.floor(totalSec / 3600);
                      const m = Math.floor((totalSec % 3600) / 60);
                      const s = totalSec % 60;
                      if (h > 0) return `${h}h ${m}m`;
                      if (m > 0) return `${m}m ${s}s`;
                      return `${s}s`;
                    };
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;
                    const sessionRows = [
                      ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                      { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                      { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                      ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatDuration(totalActiveMs), copyField: null }] : []),
                    ];
                    const messageRows = [
                      [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                      [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                      [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                      [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                      [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                      [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                      [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                      ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                      ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                      [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const ctxDetails = getContextDisplayMetrics(ctx);
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows: string[][] = [
                      ...(sessionStats.cost > 0 ? [[uiText.app.cost, `$${sessionStats.cost.toFixed(4)}`]] : []),
                      ...(ctxDetails ? [
                        [
                          uiText.app.contextRemaining,
                          `${ctxDetails.remainingPercent !== null ? `${ctxDetails.remainingPercent.toFixed(1)}%` : "?"}${ctxDetails.remainingTokens !== null ? ` · ${ctxDetails.remainingTokens.toLocaleString()}` : ""}`,
                        ],
                        [
                          uiText.app.contextUsed,
                          `${ctxDetails.usedPercent !== null ? `${ctxDetails.usedPercent.toFixed(1)}%` : "?"}${ctxDetails.usedTokens !== null ? ` · ${ctxDetails.usedTokens.toLocaleString()}` : ""}`,
                        ],
                        [uiText.app.contextWindow, formatCompact(ctxDetails.contextWindow)],
                      ] : []),
                      // Cache hit rate = cache reads / all input-class tokens.
                      ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0
                        && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                        ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                        : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                        {section(translate("session.messages"), messageRows)}
                        {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        {isMobile && renderProjectTrustWarning(true)}
        </div>

        {sessionTabs.length > 0 && (
          <div
            role="tablist"
            aria-label={uiLanguage === "zh" ? "会话标签" : "Session tabs"}
            style={{
              height: 30,
              minHeight: 30,
              display: "none",
              alignItems: "stretch",
              overflowX: "auto",
              overflowY: "hidden",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              scrollbarWidth: "thin",
            }}
          >
            {sessionTabs.map((session) => {
              const active = selectedSession?.id === session.id;
              const label = session.name?.trim() || session.firstMessage?.trim() || (uiLanguage === "zh" ? "新会话" : "New session");
              return (
                <div
                  key={session.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => activateSessionTab(session)}
                  style={{
                    minWidth: 112,
                    maxWidth: 210,
                    height: 30,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 5px 0 10px",
                    flexShrink: 0,
                    borderRight: "1px solid var(--border)",
                    borderTop: active ? "2px solid var(--accent)" : "2px solid transparent",
                    background: active ? "var(--bg)" : "var(--bg-panel)",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    userSelect: "none",
                    fontSize: 11,
                  }}
                  title={label}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></svg>
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: active ? 600 : 400 }}>{label}</span>
                  <button
                    type="button"
                    title={uiText.common.close}
                    aria-label={`${uiText.common.close}: ${label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeSessionTab(session.id);
                    }}
                    style={{
                      width: 18,
                      height: 18,
                      padding: 0,
                      flexShrink: 0,
                      display: "grid",
                      placeItems: "center",
                      border: 0,
                      borderRadius: 4,
                      background: "transparent",
                      color: "var(--text-dim)",
                      cursor: "pointer",
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m2 2 6 6M8 2 2 8" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Chat content */}
        <IfcnWorkspaceBar workspace={ifcnWorkspace} />
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              sessionRunning={Boolean(selectedSession && runningSessionIds.has(selectedSession.id))}
              newSessionCwd={effectiveNewSessionCwd}
              ifcnWorkspace={ifcnWorkspace}
              newSessionDraftKey={newSessionDraftKey}
              currentUser={currentAccount.username}
              accountUid={currentAccount.uid}
              uiLanguage={uiLanguage}
              onAgentEnd={handleAgentEnd}
              onAttentionNeeded={handleAttentionNeeded}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onContextUsageChange={handleContextUsageChange}
              onCodeFileSaved={handleCodeFileSaved}
              onCodeArtifactsChange={handleCodeArtifactsChange}
              onTerminalRequest={showWorkspaceTerminalTab}
              onOpenFile={handleOpenLinkedFile}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playDoneSound={playDoneSound}
              unlockAudio={unlockAudio}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${chatPanelCollapsed ? " chat-panel-collapsed" : ""}${resizingPanel === "right" ? " is-resizing" : ""}`}
        id="file-panel"
        style={{
          "--right-panel-width": `${activeResize?.panel === "right" ? activeResize.currentWidth : rightPanelWidth}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          paddingBottom: "env(safe-area-inset-bottom)",
        } as CSSProperties}
      >
        {chatPanelCollapsed && pdfFocusMode && (
          <button
            type="button"
            onClick={() => setChatPanelCollapsed(false)}
            title={uiLanguage === "zh" ? "展开 AI 对话栏" : "Show AI chat"}
            aria-label={uiLanguage === "zh" ? "展开 AI 对话栏" : "Show AI chat"}
            style={{
              position: "absolute",
              top: 7,
              left: 7,
              zIndex: 80,
              width: 28,
              height: 28,
              padding: 0,
              display: "grid",
              placeItems: "center",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
              color: "var(--accent)",
              boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
              backdropFilter: "blur(10px)",
              cursor: "pointer",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M14 9l3 3-3 3" />
            </svg>
          </button>
        )}
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflowX: "auto", overflowY: "hidden" }}>
          {visibleRightGroups.map((group, groupIndex) => {
            const storedActiveId = rightGroupActiveTabs[group.id];
            const groupActiveId = group.tabs.some((tab) => tab.id === storedActiveId)
              ? storedActiveId!
              : group.tabs.some((tab) => tab.id === activeFileTabId)
                ? activeFileTabId!
                : group.tabs.at(-1)?.id ?? "";
            const groupActiveTab = group.tabs.find((tab) => tab.id === groupActiveId) ?? null;
            return (
              <Fragment key={group.id}>
                {groupIndex > 0 && (
                  <div
                    className={`split-group-resize-handle${resizingRightGroup === group.id ? " is-resizing" : ""}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={uiLanguage === "zh" ? "调整分栏宽度" : "Resize split columns"}
                    title={uiLanguage === "zh" ? "拖动调整分栏宽度，双击恢复等宽" : "Drag to resize columns; double-click to equalize"}
                    onPointerDown={(event) => startRightGroupResize(visibleRightGroups[groupIndex - 1].id, group.id, event)}
                    onPointerMove={moveRightGroupResize}
                    onPointerUp={stopRightGroupResize}
                    onPointerCancel={stopRightGroupResize}
                    onDoubleClick={() => {
                      const leftId = visibleRightGroups[groupIndex - 1].id;
                      setRightGroupSizes((current) => {
                        const combined = Math.max(0.2, (current[leftId] ?? 1) + (current[group.id] ?? 1));
                        return { ...current, [leftId]: combined / 2, [group.id]: combined / 2 };
                      });
                    }}
                  />
                )}
                <section
                  ref={(element) => {
                    if (element) rightGroupElementsRef.current.set(group.id, element);
                    else rightGroupElementsRef.current.delete(group.id);
                  }}
                  style={{
                    flexGrow: Math.max(0.1, rightGroupSizes[group.id] ?? 1) / visibleRightGroupWeightTotal,
                    flexShrink: 1,
                    flexBasis: 0,
                    minWidth: visibleRightGroups.length > 1 ? MIN_SPLIT_GROUP_WIDTH : 0,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                    background: "var(--bg)",
                  }}
                >
                {!pdfFocusMode && (
                  /* Right panel tab bar */
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    flexShrink: 0,
                    overflow: "hidden",
                    background: "var(--bg-panel)",
                    borderBottom: "1px solid var(--border)",
                    height: "calc(36px + env(safe-area-inset-top))",
                    paddingTop: "env(safe-area-inset-top)",
                  }}>
                    {groupIndex === 0 && showChat && (
                      <button
                        type="button"
                        onClick={() => setChatPanelCollapsed((collapsed) => !collapsed)}
                        title={chatPanelCollapsed
                          ? (uiLanguage === "zh" ? "展开 AI 对话栏" : "Show AI chat")
                          : (uiLanguage === "zh" ? "收起 AI 对话栏" : "Collapse AI chat")}
                        aria-label={chatPanelCollapsed
                          ? (uiLanguage === "zh" ? "展开 AI 对话栏" : "Show AI chat")
                          : (uiLanguage === "zh" ? "收起 AI 对话栏" : "Collapse AI chat")}
                        aria-pressed={chatPanelCollapsed}
                        style={{
                          width: 30,
                          height: 30,
                          padding: 0,
                          flexShrink: 0,
                          display: "grid",
                          placeItems: "center",
                          border: 0,
                          borderRight: "1px solid var(--border)",
                          background: chatPanelCollapsed ? "var(--bg-selected)" : "transparent",
                          color: chatPanelCollapsed ? "var(--accent)" : "var(--text-muted)",
                          cursor: "pointer",
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="3" y="4" width="18" height="16" rx="2" />
                          <path d="M9 4v16" />
                          {chatPanelCollapsed ? <path d="m14 9 3 3-3 3" /> : <path d="m17 9-3 3 3 3" />}
                        </svg>
                      </button>
                    )}
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <TabBar
                        tabs={group.tabs}
                        activeTabId={groupActiveId}
                        onSelectTab={(tabId: string) => selectRightTab(group.id, tabId)}
                        onCloseTab={handleCloseRightTab}
                        onSplitTab={splitRightTab}
                        onMoveTabToMain={moveRightTabToMain}
                        isMainGroup={group.id === MAIN_RIGHT_GROUP_ID}
                        uiLanguage={uiLanguage}
                      />
                    </div>
                  </div>
                )}
                {/* Only the active viewer in each split group is mounted. The
                    terminal remains mounted so switching tabs cannot kill its PTY. */}
                <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden" }}>
                  {!groupActiveTab && (
                    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                      {uiText.app.noFileOpen}
                    </div>
                  )}
                  {group.tabs.filter((tab) => tab.view === "terminal").map((tab) => (
                    <div
                      key={tab.id}
                      aria-hidden={tab.id !== groupActiveId}
                      style={{
                        position: "absolute",
                        inset: 0,
                        visibility: tab.id === groupActiveId ? "visible" : "hidden",
                        pointerEvents: tab.id === groupActiveId ? "auto" : "none",
                        zIndex: tab.id === groupActiveId ? 1 : 0,
                        width: "100%",
                        height: "100%",
                        overflow: "hidden",
                      }}
                    >
                      {cliWorkspaceCwd && (
                        <IntegratedTerminal
                          cwd={cliWorkspaceCwd}
                          open
                          isDark={isDark}
                          uiLanguage={uiLanguage}
                          onClose={() => handleCloseRightTab(WORKSPACE_TERMINAL_TAB_ID)}
                          initialCommand={workspaceTerminalRequest?.command}
                          initialCommandKey={workspaceTerminalRequest?.key}
                          contextLabel={workspaceTerminalRequest?.contextLabel}
                        />
                      )}
                    </div>
                  ))}
                  {groupActiveTab && groupActiveTab.view !== "terminal" && (
                    <div
                      key={groupActiveTab.id}
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        overflow: "hidden",
                      }}
                    >
                      {groupActiveTab.view === "generated-code" && generatedCodePanel ? (
                        <CodeGenerationPane
                          artifact={generatedCodePanel.artifact}
                          artifacts={generatedCodePanel.artifacts}
                          onSelectArtifact={generatedCodePanel.onSelectArtifact}
                          terminal={generatedCodePanel.terminal}
                          cwd={generatedCodePanel.cwd}
                          onClose={() => handleCloseRightTab(GENERATED_CODE_TAB_ID)}
                          onAsk={(prompt) => chatInputRef.current?.insertText(prompt)}
                          resizing={false}
                          fullWidth={false}
                          onFileSaved={handleCodeFileSaved}
                          onTerminalRequest={showWorkspaceTerminalTab}
                          uiLanguage={uiLanguage}
                          tabMode
                        />
                      ) : groupActiveTab.view === "timeline" ? (
                        <FileTimeline
                          filePath={groupActiveTab.filePath}
                          fileName={groupActiveTab.filePath.replace(/\\/g, "/").split("/").pop() || groupActiveTab.label}
                          uiLanguage={uiLanguage}
                          onOpenRevision={(entry: TimelineEntry) => handleOpenRevision(
                            groupActiveTab.filePath,
                            groupActiveTab.filePath.replace(/\\/g, "/").split("/").pop() || groupActiveTab.label,
                            entry,
                          )}
                        />
                      ) : groupActiveTab.view === "revision" && groupActiveTab.revision ? (
                        <FileRevisionViewer
                          filePath={groupActiveTab.filePath}
                          fileName={groupActiveTab.filePath.replace(/\\/g, "/").split("/").pop() || groupActiveTab.label}
                          revision={groupActiveTab.revision}
                          uiLanguage={uiLanguage}
                          onOpenCurrent={() => handleOpenFile(
                            groupActiveTab.filePath,
                            groupActiveTab.filePath.replace(/\\/g, "/").split("/").pop() || groupActiveTab.label,
                          )}
                        />
                      ) : (
                        <FileViewer
                          key={`${groupActiveTab.id}:${groupActiveTab.viewerRevision ?? 0}`}
                          filePath={groupActiveTab.filePath}
                          accountUid={currentAccount.uid}
                          cwd={activeCwd ?? undefined}
                          sourceSessionId={groupActiveTab.sourceSessionId}
                          location={groupActiveTab.location}
                          focusToken={groupActiveTab.focusToken}
                          gitRefreshKey={explorerRefreshKey}
                          initialDisplayMode={groupActiveTab.initialDisplayMode}
                          initialState={groupActiveTab.viewerState}
                          watchEnabled={rightPanelOpen}
                          onStateChange={(viewerState) => handleFileViewerStateChange(
                            groupActiveTab.id,
                            groupActiveTab.viewerRevision ?? 0,
                            viewerState,
                          )}
                          onMentionLines={handleFileLineMention}
                          onAtMention={handleAtMention}
                          onOpenFile={(filePath) => handleOpenFile(
                            filePath,
                            getFileName(filePath),
                            { sourceSessionId: groupActiveTab.sourceSessionId },
                          )}
                          onDirtyChange={handleFileDirtyChange}
                          onDocQa={handleDocQa}
                          pdfFocusMode={groupActiveTab.id === activeFileTabId && pdfFocusMode}
                          onPdfFocusModeChange={groupActiveTab.id === activeFileTabId ? handlePdfFocusModeChange : undefined}
                          uiLanguage={uiLanguage}
                          active
                          terminalOpen={workspaceTerminalActive}
                          onTerminalRequest={toggleWorkspaceTerminalTab}
                        />
                      )}
                    </div>
                  )}
                </div>
                </section>
              </Fragment>
            );
          })}
        </div>
        {pdfFocusMode && (
          <div className="pdf-focus-exit-zone" aria-label={uiLanguage === "zh" ? "PDF 专注模式控制" : "PDF focus controls"}>
            <button
              type="button"
              aria-label={uiLanguage === "zh" ? "退出 PDF 专注模式" : "Exit PDF focus mode"}
              title={uiLanguage === "zh" ? "恢复右侧栏标题（Esc）" : "Restore right panel headers (Esc)"}
              onClick={() => setPdfFocusMode(false)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {sidebarOpen && !isMobile && (
        <div
          className={`panel-resize-handle${resizingPanel === "sidebar" ? " is-resizing" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={uiText.app.resizeLeftSidebar}
          title={uiText.app.resizeLeftSidebar}
          onPointerDown={(event) => startResize("sidebar", event)}
          onDoubleClick={() => setSidebarOpen(false)}
          style={{ left: `calc(var(--sidebar-width) + ${ACTIVITY_BAR_WIDTH - 3}px)`, zIndex: 450 }}
        />
      )}
      {rightPanelOpen && !chatPanelCollapsed && !isMobile && (
        <div
          className={`panel-resize-handle${resizingPanel === "right" ? " is-resizing" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={uiText.app.resizeRightPanel}
          title={uiText.app.resizeRightPanel}
          onPointerDown={(event) => startResize("right", event)}
          style={{ right: "calc(var(--right-panel-width) - 3px)", zIndex: 450 }}
        />
      )}
    </div>
    {folderLoadedToast && (
      <button
        type="button"
        onClick={() => {
          if (folderLoadedToastTimerRef.current) clearTimeout(folderLoadedToastTimerRef.current);
          folderLoadedToastTimerRef.current = null;
          setFolderLoadedToast(null);
          setSidebarOpen(true);
          setSidebarView("files");
        }}
        title={folderLoadedToast}
        style={{
          position: "fixed",
          left: isMobile ? 12 : ACTIVITY_BAR_WIDTH + 12,
          bottom: 14,
          zIndex: 1200,
          maxWidth: "min(360px, calc(100vw - 72px))",
          minHeight: 48,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          border: "1px solid color-mix(in srgb, #22c55e 42%, var(--border))",
          borderRadius: 9,
          background: "color-mix(in srgb, var(--bg-panel) 94%, #22c55e 6%)",
          color: "var(--text)",
          boxShadow: "0 10px 32px rgba(0,0,0,0.2)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M3.5 7h6l2 2h9v9.5h-17Z" /><path d="m8 14 2.2 2.2L16 11" />
        </svg>
        <span style={{ minWidth: 0 }}>
          <strong style={{ display: "block", fontSize: 12, fontWeight: 700 }}>{uiLanguage === "zh" ? "文件夹加载成功" : "Folder loaded"}</strong>
          <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 10 }}>{uiLanguage === "zh" ? "点击打开文件栏" : "Click to open Files"} · {folderLoadedToast}</span>
        </span>
      </button>
    )}
    {resizingPanel && !isMobile && <div className="panel-resize-overlay" aria-hidden="true" />}
    {/* The panel toggle gives the top-right hover exit affordance room in focus mode. */}
    {!pdfFocusMode && isMobile && <button
      onClick={() => {
        setRightPanelOpen((v) => {
          if (v) setChatPanelCollapsed(false);
          return !v;
        });
      }}
      title={rightPanelOpen ? uiText.app.hideFilePanel : uiText.app.showFilePanel}
      aria-label={rightPanelOpen ? uiText.app.hideFilePanel : uiText.app.showFilePanel}
      style={{
        position: "fixed", top: 0, right: 0, zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>}
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {agentsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <AgentsConfig
        cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!}
        onOpenFile={handleOpenFile}
        onClose={() => {
          setAgentsConfigOpen(false);
          setModelsRefreshKey((key) => key + 1);
        }}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    {skillsConfigOpen && projectTrustCwd && (
      <SkillsConfig cwd={projectTrustCwd} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {pluginsConfigOpen && projectTrustCwd && (
      <PluginsConfig
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        onClose={() => setPluginsConfigOpen(false)}
        onReloaded={() => setSessionKey((k) => k + 1)}
      />
    )}
    {mcpConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <McpConfig
        cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!}
        uiLanguage={uiLanguage}
        onClose={() => {
          setMcpConfigOpen(false);
          setModelsRefreshKey((key) => key + 1);
        }}
      />
    )}
    </>
  );
}
