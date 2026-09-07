"use client";

import { IfcnWelcome, type IfcnWorkspaceInfo } from "./IfcnWorkspace";

import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, TextContent, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { SyntaxHighlighter, vs, vscDarkPlus } from "./CodeSyntaxHighlighter";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { CHAT_MINIMAP_WIDTH, ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { parseDocQaPrompt, type AttachedDocument } from "@/lib/docqa";
import { FcnPilotIcon } from "./FcnPilotIcon";
import { extractLatestCodeArtifacts, extractLatestTerminalArtifact, type CodeArtifact, type CodeTerminalArtifact } from "@/lib/code-artifacts";
import { textForLanguage, type UiLanguage } from "@/lib/i18n";
import type { MessageFeedback, MessageFeedbackInput } from "@/lib/message-feedback-types";
import type { TerminalOpenRequest } from "./IntegratedTerminal";
import { useAppDialog } from "./AppDialogProvider";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";
import type { AppUpdateResponse } from "@/lib/api-types";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getPromptAnchorSpacerHeight,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props extends SoundControls {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  ifcnWorkspace?: IfcnWorkspaceInfo | null;
  currentUser?: string | null;
  accountUid?: string | null;
  uiLanguage?: UiLanguage;
  newSessionDraftKey?: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onCodeFileSaved?: () => void;
  onCodeArtifactsChange?: (state: CodeArtifactsPanelState | null) => void;
  onTerminalRequest?: (request?: TerminalOpenRequest) => void;
}

export interface CodeArtifactsPanelState {
  artifact: CodeArtifact;
  artifacts: CodeArtifact[];
  terminal: CodeTerminalArtifact | null;
  cwd: string;
  onSelectArtifact: (artifactId: string) => void;
}

interface SoundControls {
  onOpenFile?: (filePath: string) => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const latest = phase.tools[phase.tools.length - 1];
    if (latest?.progress) {
      return `${t("chat.runningNamedTool", { name: latest.name })} ${latest.progress}`;
    }
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;
const DEFAULT_CODE_PANE_WIDTH = 620;
const MIN_CODE_PANE_WIDTH = 360;
const CODE_PANE_FULL_SNAP_PX = 28;
const CODE_PANE_WIDTH_STORAGE_KEY = "amedac.codePaneWidth";
const NEW_SESSION_SUGGESTIONS: Record<UiLanguage, string[]> = {
  en: [
    "Analyze this project and explain its architecture",
    "Find a likely bug in the current code and propose a fix",
    "Implement a feature from my description",
    "Review my uncommitted changes for quality and risks",
  ],
  zh: [
    "分析当前工程并讲解整体架构",
    "查找当前代码中可能存在的问题并给出修复方案",
    "根据我的描述实现一个新功能",
    "审查尚未提交的修改并指出质量与风险问题",
  ],
};
const docQaDocumentsCache = new WeakMap<AgentMessage, AttachedDocument[] | undefined>();

function codeArtifactSignal(artifact: CodeArtifact | null): string | null {
  if (!artifact) return null;
  let hash = 0;
  for (let i = 0; i < artifact.code.length; i++) {
    hash = ((hash << 5) - hash + artifact.code.charCodeAt(i)) | 0;
  }
  return [
    artifact.id,
    artifact.complete ? "1" : "0",
    artifact.code.length,
    hash,
  ].join("|");
}

function copyCode(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  return Promise.resolve();
}

function docQaDocumentsFromUserMessage(message: AgentMessage): AttachedDocument[] | undefined {
  if (message.role !== "user") return undefined;
  if (docQaDocumentsCache.has(message)) return docQaDocumentsCache.get(message);
  const userMessage = message as UserMessage;
  const rawContent =
    typeof userMessage.content === "string"
      ? userMessage.content
      : userMessage.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  const docQa = parseDocQaPrompt(rawContent);
  const documents = docQa?.documents.length ? docQa.documents : undefined;
  docQaDocumentsCache.set(message, documents);
  return documents;
}

function NewSessionUpdateLink({
  label,
}: {
  label: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/app-update", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AppUpdateResponse>;
      })
      .then((result) => {
        if (result?.updateAvailable && result.latestVersion && result.releaseUrl) {
          setUpdate(result);
        }
      })
      .catch(() => {
        // Update checks are best-effort and must not interrupt a new session.
      });
    return () => controller.abort();
  }, []);

  if (!update) return null;
  const accessibleLabel = label(update.latestVersion);

  return (
    <a
      href={update.releaseUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={accessibleLabel}
      aria-label={accessibleLabel}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        alignSelf: "center",
        gap: 3,
        minHeight: 32,
        minWidth: 0,
        padding: "0 4px",
        background: "transparent",
        borderRadius: 5,
        color: "var(--accent)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.2,
        textDecoration: "none",
        transition: "background 0.12s",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>v{update.latestVersion}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M7 17 17 7" />
        <path d="M7 7h10v10" />
      </svg>
    </a>
  );
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, defaultExpanded = false, children, t }: { messageCount: number; toolCallCount: number; defaultExpanded?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export const ChatWindow = memo(function ChatWindow({ session, sessionRunning, newSessionCwd, ifcnWorkspace = null, newSessionDraftKey = null, currentUser, accountUid, uiLanguage = "en", onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onCodeFileSaved, onCodeArtifactsChange, onTerminalRequest, onOpenFile, soundEnabled: soundEnabledProp, onSoundToggle: onSoundToggleProp, playDoneSound: playDoneSoundProp, unlockAudio: unlockAudioProp }: Props) {
  const { t } = useI18n();
  const localAudio = useAudio();
  const soundEnabled = soundEnabledProp ?? localAudio.soundEnabled;
  const onSoundToggle = onSoundToggleProp ?? localAudio.onSoundToggle;
  const playDoneSound = playDoneSoundProp ?? localAudio.playDoneSound;
  const unlockAudio = unlockAudioProp ?? localAudio.unlockAudio;
  const isMobile = useIsMobile();
  const uiText = textForLanguage(uiLanguage);

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    mcpServers, mcpServersLoading, mcpServersUpdating, mcpServersError, mcpSelectionLocked,
    customAgents, selectedAgentId, subagents, selectedSubagentIds, subagentExtensionAvailable, agentVersions, selectedAgentVersionId,
    agentPhase,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    cliConnected, liveToolResults, liveToolExecutions,
    isAutoModelSelection,
    agentSelectionLocked, agentVersionSelectionLocked,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleAgentChange, handleAgentVersionChange, handleSubagentToggle,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, handleMcpServerToggle, loadSlashCommands, scrollUserMsgToTop,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsPanelOpen,
  });
  const sessionBusy = agentRunning || bashRunning;

  useEffect(() => {
    if (!extensionDialog || soundedExtensionDialogIdRef.current === extensionDialog.id) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((prev) => getNextVisibleCount(prev));
        }
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.contextUsage?.percent ?? "",
      sessionStats.contextUsage?.tokens ?? "",
      sessionStats.contextUsage?.contextWindow ?? "",
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = useMemo(() => messages.filter((m) => m.role === "user" || m.role === "assistant"), [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);
  const artifactGenerationSeenRef = useRef(false);
  const [codePanelArtifacts, setCodePanelArtifacts] = useState<CodeArtifact[]>([]);
  const [selectedCodeArtifactId, setSelectedCodeArtifactId] = useState<string | null>(null);
  const codeArtifactSelectionTouchedRef = useRef(false);
  const codeArtifactsTurnRef = useRef<number | null>(null);
  const codePanelArtifact = useMemo(
    () => codePanelArtifacts.find((artifact) => artifact.id === selectedCodeArtifactId)
      ?? codePanelArtifacts.at(-1)
      ?? null,
    [codePanelArtifacts, selectedCodeArtifactId],
  );
  const [codePanelOpen, setCodePanelOpen] = useState(true);
  const [codePaneWidth, setCodePaneWidth] = useState(DEFAULT_CODE_PANE_WIDTH);
  const [codePaneFullWidth, setCodePaneFullWidth] = useState(false);
  const [codePaneResizing, setCodePaneResizing] = useState(false);
  const chatWindowRef = useRef<HTMLDivElement | null>(null);
  const codePaneLayoutRef = useRef<HTMLDivElement | null>(null);
  const codePaneWidthRef = useRef(codePaneWidth);
  const lastCodePaneWidthRef = useRef(codePaneWidth);
  const codePaneResizeRef = useRef<{
    startX: number;
    startWidth: number;
    currentWidth: number;
  } | null>(null);
  const codePaneResizeFrameRef = useRef<number | null>(null);
  const pendingCodePaneResizeXRef = useRef<number | null>(null);
  if (!codePaneResizeRef.current && !codePaneFullWidth) codePaneWidthRef.current = codePaneWidth;
  const [feedbackByEntryId, setFeedbackByEntryId] = useState<Record<string, MessageFeedback>>({});
  const conversationKey = session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : "new");

  useEffect(() => {
    setFeedbackByEntryId({});
    if (!session?.id) return;
    const controller = new AbortController();
    fetch(`/api/feedback?sessionId=${encodeURIComponent(session.id)}`, {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Feedback load failed (${response.status})`);
        return response.json() as Promise<{ feedback?: MessageFeedback[] }>;
      })
      .then(({ feedback = [] }) => {
        setFeedbackByEntryId(Object.fromEntries(feedback.map((item) => [item.entryId, item])));
      })
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError") console.warn(loadError);
      });
    return () => controller.abort();
  }, [session?.id]);

  const updateMessageFeedback = useCallback(async (
    entryId: string,
    feedback: MessageFeedbackInput | null,
  ): Promise<MessageFeedback | null> => {
    if (!session?.id) throw new Error("Feedback requires a saved session");
    const response = await fetch("/api/feedback", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, entryId, feedback }),
    });
    const result = await response.json() as { feedback?: MessageFeedback | null; error?: string };
    if (!response.ok) throw new Error(result.error || `Feedback save failed (${response.status})`);
    const saved = result.feedback ?? null;
    setFeedbackByEntryId((current) => {
      const next = { ...current };
      if (saved) next[entryId] = saved;
      else delete next[entryId];
      return next;
    });
    return saved;
  }, [session]);
  const liveToolResultList = useMemo(() => [...liveToolResults.values()], [liveToolResults]);
  const liveToolExecutionList = useMemo(() => [...liveToolExecutions.values()], [liveToolExecutions]);
  const toolResultsMap = useMemo(() => {
    const results = new Map<string, import("@/lib/types").ToolResultMessage>(liveToolResults);
    for (const message of messages) {
      if (message.role === "toolResult") {
        const result = message as import("@/lib/types").ToolResultMessage;
        results.set(result.toolCallId, result);
      }
    }
    return results;
  }, [liveToolResults, messages]);
  const latestCodeArtifacts = useMemo(() => extractLatestCodeArtifacts(
    messages,
    streamState.streamingMessage,
    conversationKey,
    {
      allowSmall: codePanelArtifacts.length > 0,
      baseArtifact: codePanelArtifact,
      toolResults: liveToolResultList,
      includeAll: true,
    },
  ), [codePanelArtifact, codePanelArtifacts.length, conversationKey, liveToolResultList, messages, streamState.streamingMessage]);
  const latestTerminalArtifact = useMemo(() => codePanelArtifact
    ? extractLatestTerminalArtifact(messages, streamState.streamingMessage, conversationKey, {
        baseArtifact: codePanelArtifact,
        toolResults: liveToolResultList,
        toolExecutions: liveToolExecutionList,
      })
    : null, [codePanelArtifact, conversationKey, liveToolExecutionList, liveToolResultList, messages, streamState.streamingMessage]);
  const latestCodeArtifactsRef = useRef<CodeArtifact[]>(latestCodeArtifacts);
  latestCodeArtifactsRef.current = latestCodeArtifacts;
  const latestCodeArtifactsSignal = useMemo(
    () => latestCodeArtifacts.map((artifact) => codeArtifactSignal(artifact)).join("||"),
    [latestCodeArtifacts],
  );
  const pendingCodeArtifactsRef = useRef<CodeArtifact[] | null>(null);
  const codeArtifactFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (codeArtifactFrameRef.current !== null) cancelAnimationFrame(codeArtifactFrameRef.current);
    codeArtifactFrameRef.current = null;
    pendingCodeArtifactsRef.current = null;
    artifactGenerationSeenRef.current = false;
    codeArtifactSelectionTouchedRef.current = false;
    codeArtifactsTurnRef.current = null;
    setCodePanelArtifacts([]);
    setSelectedCodeArtifactId(null);
    setCodePanelOpen(true);
  }, [conversationKey]);
  useEffect(() => () => {
    if (codeArtifactFrameRef.current !== null) cancelAnimationFrame(codeArtifactFrameRef.current);
  }, []);
  useEffect(() => {
    if (streamState.isStreaming || agentRunning) {
      artifactGenerationSeenRef.current = true;
    }
  }, [agentRunning, streamState.isStreaming]);
  useEffect(() => {
    const artifacts = latestCodeArtifactsRef.current;
    if (artifacts.length === 0) return;
    const belongsToCurrentGeneration = streamState.isStreaming || agentRunning || artifactGenerationSeenRef.current;
    if (!belongsToCurrentGeneration) return;
    const applyArtifacts = (next: CodeArtifact[]) => {
      const nextTurn = next.at(-1)?.sourceTurn ?? null;
      if (codeArtifactsTurnRef.current !== nextTurn) {
        codeArtifactsTurnRef.current = nextTurn;
        codeArtifactSelectionTouchedRef.current = false;
      }
      setCodePanelArtifacts(next);
      setSelectedCodeArtifactId((current) => {
        const currentStillExists = current && next.some((artifact) => artifact.id === current);
        if (codeArtifactSelectionTouchedRef.current && currentStillExists) return current;
        return next.at(-1)?.id ?? null;
      });
      setCodePanelOpen(true);
    };
    const allComplete = artifacts.every((artifact) => artifact.complete);
    if (allComplete) {
      if (codeArtifactFrameRef.current !== null) cancelAnimationFrame(codeArtifactFrameRef.current);
      codeArtifactFrameRef.current = null;
      pendingCodeArtifactsRef.current = null;
      applyArtifacts(artifacts);
    } else {
      pendingCodeArtifactsRef.current = artifacts;
      if (codeArtifactFrameRef.current === null) {
        codeArtifactFrameRef.current = requestAnimationFrame(() => {
          codeArtifactFrameRef.current = null;
          const pending = pendingCodeArtifactsRef.current;
          pendingCodeArtifactsRef.current = null;
          if (pending) applyArtifacts(pending);
        });
      }
    }
    if (allComplete && !streamState.isStreaming && !agentRunning) {
      artifactGenerationSeenRef.current = false;
    }
  }, [agentRunning, latestCodeArtifactsSignal, streamState.isStreaming]);
  const selectCodeArtifact = useCallback((artifactId: string) => {
    codeArtifactSelectionTouchedRef.current = true;
    setSelectedCodeArtifactId(artifactId);
  }, []);
  const showCodePanel = !onCodeArtifactsChange && !isMobile && codePanelOpen && codePanelArtifact !== null;

  useEffect(() => {
    if (!onCodeArtifactsChange) return;
    if (!codePanelOpen || !codePanelArtifact) {
      onCodeArtifactsChange(null);
      return;
    }
    onCodeArtifactsChange({
      artifact: codePanelArtifact,
      artifacts: codePanelArtifacts,
      terminal: latestTerminalArtifact,
      cwd: session?.cwd ?? newSessionCwd ?? ".",
      onSelectArtifact: selectCodeArtifact,
    });
  }, [
    codePanelArtifact,
    codePanelArtifacts,
    codePanelOpen,
    latestTerminalArtifact,
    newSessionCwd,
    onCodeArtifactsChange,
    selectCodeArtifact,
    session?.cwd,
  ]);

  const syncCodePaneFullWidthClass = useCallback((fullWidth: boolean) => {
    chatWindowRef.current?.classList.toggle("is-code-pane-full", fullWidth);
    codePaneLayoutRef.current?.classList.toggle("is-code-pane-full", fullWidth);
  }, []);

  const applyCodePaneWidth = useCallback((requestedWidth: number) => {
    const availableWidth = Math.max(1, codePaneLayoutRef.current?.clientWidth ?? window.innerWidth);
    const minimumWidth = Math.min(MIN_CODE_PANE_WIDTH, availableWidth);
    const nextWidth = Math.round(Math.max(minimumWidth, Math.min(availableWidth, requestedWidth)));
    codePaneWidthRef.current = nextWidth;
    if (codePaneResizeRef.current) codePaneResizeRef.current.currentWidth = nextWidth;
    chatWindowRef.current?.style.setProperty("--code-pane-width", `${nextWidth}px`);
    return { width: nextWidth, availableWidth };
  }, []);

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem(CODE_PANE_WIDTH_STORAGE_KEY));
    if (!Number.isFinite(storedWidth) || storedWidth < MIN_CODE_PANE_WIDTH) return;
    lastCodePaneWidthRef.current = storedWidth;
    const applied = applyCodePaneWidth(storedWidth);
    setCodePaneWidth(applied.width);
  }, [applyCodePaneWidth]);

  useEffect(() => {
    if (!showCodePanel) return;
    const layout = codePaneLayoutRef.current;
    if (!layout) return;
    const fitToLayout = () => {
      const availableWidth = Math.max(1, layout.clientWidth);
      if (codePaneFullWidth) {
        codePaneWidthRef.current = availableWidth;
        chatWindowRef.current?.style.setProperty("--code-pane-width", `${availableWidth}px`);
        return;
      }
      if (codePaneWidthRef.current <= availableWidth) return;
      const applied = applyCodePaneWidth(availableWidth);
      setCodePaneWidth(applied.width);
    };
    fitToLayout();
    const observer = new ResizeObserver(fitToLayout);
    observer.observe(layout);
    return () => observer.disconnect();
  }, [applyCodePaneWidth, codePaneFullWidth, showCodePanel]);

  const startCodePaneResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const layout = codePaneLayoutRef.current;
    if (!layout) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pane = layout.querySelector<HTMLElement>(".code-generation-pane");
    const startWidth = Math.min(layout.clientWidth, pane?.getBoundingClientRect().width ?? codePaneWidthRef.current);
    if (!codePaneFullWidth) lastCodePaneWidthRef.current = startWidth;
    codePaneResizeRef.current = {
      startX: event.clientX,
      startWidth,
      currentWidth: startWidth,
    };
    chatWindowRef.current?.classList.add("is-code-pane-resizing");
    setCodePaneResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [codePaneFullWidth]);

  useEffect(() => {
    const chatWindow = chatWindowRef.current;
    const applyResizeAt = (clientX: number) => {
      const resize = codePaneResizeRef.current;
      if (!resize) return;
      const requestedWidth = resize.startWidth + resize.startX - clientX;
      const applied = applyCodePaneWidth(requestedWidth);
      // When dragging away from a previously full-width pane, reveal the
      // conversation immediately without waiting for pointerup.
      syncCodePaneFullWidthClass(applied.availableWidth - applied.width < 1);
    };

    const stopResize = (clientX?: number) => {
      const resize = codePaneResizeRef.current;
      if (codePaneResizeFrameRef.current !== null) cancelAnimationFrame(codePaneResizeFrameRef.current);
      codePaneResizeFrameRef.current = null;
      const finalClientX = clientX ?? pendingCodePaneResizeXRef.current;
      pendingCodePaneResizeXRef.current = null;
      if (resize && finalClientX !== null && finalClientX !== undefined) applyResizeAt(finalClientX);

      if (resize) {
        const layoutWidth = Math.max(1, codePaneLayoutRef.current?.clientWidth ?? resize.currentWidth);
        const shouldFill = layoutWidth - resize.currentWidth <= CODE_PANE_FULL_SNAP_PX;
        const finalWidth = shouldFill ? layoutWidth : resize.currentWidth;
        const applied = applyCodePaneWidth(finalWidth);
        syncCodePaneFullWidthClass(shouldFill);
        setCodePaneWidth(applied.width);
        setCodePaneFullWidth(shouldFill);
        if (!shouldFill) {
          lastCodePaneWidthRef.current = applied.width;
          window.localStorage.setItem(CODE_PANE_WIDTH_STORAGE_KEY, String(applied.width));
        }
      }

      codePaneResizeRef.current = null;
      setCodePaneResizing(false);
      chatWindowRef.current?.classList.remove("is-code-pane-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const handleMove = (event: globalThis.PointerEvent) => {
      if (!codePaneResizeRef.current) return;
      if (event.buttons === 0) {
        stopResize(event.clientX);
        return;
      }
      pendingCodePaneResizeXRef.current = event.clientX;
      if (codePaneResizeFrameRef.current !== null) return;
      codePaneResizeFrameRef.current = requestAnimationFrame(() => {
        codePaneResizeFrameRef.current = null;
        const clientX = pendingCodePaneResizeXRef.current;
        pendingCodePaneResizeXRef.current = null;
        if (clientX !== null) applyResizeAt(clientX);
      });
    };
    const handlePointerEnd = (event: globalThis.PointerEvent) => stopResize(event.clientX);
    const handlePointerCancel = () => stopResize();
    const handleBlur = () => stopResize();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") stopResize();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      if (codePaneResizeFrameRef.current !== null) cancelAnimationFrame(codePaneResizeFrameRef.current);
      codePaneResizeFrameRef.current = null;
      pendingCodePaneResizeXRef.current = null;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("keydown", handleKeyDown);
      chatWindow?.classList.remove("is-code-pane-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [applyCodePaneWidth, syncCodePaneFullWidthClass]);

  const toggleCodePaneFullWidth = useCallback(() => {
    const availableWidth = Math.max(1, codePaneLayoutRef.current?.clientWidth ?? window.innerWidth);
    if (codePaneFullWidth) {
      const restoredWidth = Math.min(
        Math.max(MIN_CODE_PANE_WIDTH, lastCodePaneWidthRef.current),
        availableWidth,
      );
      const applied = applyCodePaneWidth(restoredWidth);
      syncCodePaneFullWidthClass(false);
      setCodePaneWidth(applied.width);
      setCodePaneFullWidth(false);
      return;
    }
    lastCodePaneWidthRef.current = Math.min(codePaneWidthRef.current, availableWidth);
    window.localStorage.setItem(CODE_PANE_WIDTH_STORAGE_KEY, String(lastCodePaneWidthRef.current));
    const applied = applyCodePaneWidth(availableWidth);
    syncCodePaneFullWidthClass(true);
    setCodePaneWidth(applied.width);
    setCodePaneFullWidth(true);
  }, [applyCodePaneWidth, codePaneFullWidth, syncCodePaneFullWidthClass]);

  const closeCodePane = useCallback(() => {
    syncCodePaneFullWidthClass(false);
    setCodePaneFullWidth(false);
    setCodePanelOpen(false);
  }, [syncCodePaneFullWidthClass]);

  const askFromCodePane = useCallback((prompt: string) => {
    if (codePaneFullWidth) toggleCodePaneFullWidth();
    chatInputRef?.current?.insertText(prompt);
  }, [chatInputRef, codePaneFullWidth, toggleCodePaneFullWidth]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const docQaDocumentsByMessageIndex = useMemo(() => {
    let active: AttachedDocument[] | undefined;
    return messages.map((message) => {
      if (message.role === "user") active = docQaDocumentsFromUserMessage(message);
      return active;
    });
  }, [messages]);
  const streamingDocQaDocuments = docQaDocumentsByMessageIndex.at(-1);
  const revealHistoryForMinimap = useCallback(() => {
    setVisibleCount((current) => Math.max(current, messages.length * 2));
  }, [messages.length]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const hasStreamingContent = Boolean(streamState.streamingMessage?.content.length);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight === promptAnchorSpacerHeightRef.current) return;

      promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
      spacer.style.height = nextPromptAnchorSpacerHeight > 0
        ? `${nextPromptAnchorSpacerHeight}px`
        : "";
      if (needsInitialAdjustment) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  useLayoutEffect(() => {
    promptAnchorUpdateRef.current?.();
  }, [streamState.streamingMessage]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      customAgents={customAgents}
      selectedAgentId={selectedAgentId}
      onAgentChange={handleAgentChange}
      agentSelectionLocked={agentSelectionLocked}
      subagents={subagents}
      selectedSubagentIds={selectedSubagentIds}
      onSubagentToggle={handleSubagentToggle}
      subagentExtensionAvailable={subagentExtensionAvailable}
      agentVersions={agentVersions}
      selectedAgentVersionId={selectedAgentVersionId}
      onAgentVersionChange={handleAgentVersionChange}
      agentVersionSelectionLocked={agentVersionSelectionLocked}
      modelSwitching={modelSwitching}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      mcpServers={mcpServers}
      mcpServersLoading={mcpServersLoading}
      mcpServersUpdating={mcpServersUpdating}
      mcpServersError={mcpServersError}
      mcpSelectionLocked={mcpSelectionLocked}
      onMcpServerToggle={handleMcpServerToggle}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      uiLanguage={uiLanguage}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );
  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      ref={chatWindowRef}
      className={`amedac-chat-window relative flex h-full min-w-0 flex-col overflow-hidden${showCodePanel && codePaneFullWidth ? " is-code-pane-full" : ""}`}
      style={{
        "--code-pane-width": `${codePaneResizeRef.current?.currentWidth ?? codePaneWidthRef.current}px`,
        paddingBottom: "env(safe-area-inset-bottom)",
      } as CSSProperties}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
          <div className="absolute bottom-[18%] rounded-full border border-[rgba(37,99,235,0.25)] px-4 py-2 text-xs font-semibold text-[var(--accent)] shadow-lg" style={{ background: "color-mix(in srgb, var(--bg) 90%, transparent)" }}>
            {uiText.chatInput.dropImages}
          </div>
        </div>
      )}

      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
          zIndex: 40,
          display: "flex",
          justifyContent: "center",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating />
      </div>

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-start overflow-y-auto px-4 py-6">
          <div
            className="w-full max-w-[820px]"
            style={{ marginTop: "auto", marginBottom: "auto", flexShrink: 0 }}
          >
            {customAgents.some((agent) => agent.id === "project:ifcn") ? (
              <IfcnWelcome
                workspace={ifcnWorkspace}
                cwd={newSessionCwd}
                selected={selectedAgentId === "project:ifcn"}
                onSelect={() => handleAgentChange("project:ifcn")}
                onPrepare={(prompt) => chatInputRef?.current?.insertText(prompt)}
              />
            ) : <NewSessionWelcome
              username={currentUser ?? "test"}
              accountUid={accountUid}
              uiLanguage={uiLanguage}
              isMobile={isMobile}
              onAsk={(prompt) => void handleSend(prompt)}
            />}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 10,
                margin: "6px 16px 4px",
                fontFamily: "var(--font-mono)",
              }}
            >
              <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                {" · "}pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
              </span>
            </div>
            {chatInputElement}
            <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />
          </div>
        </div>
      ) : (
      <div
        ref={codePaneLayoutRef}
        className={`code-pane-layout${showCodePanel && codePaneFullWidth ? " is-code-pane-full" : ""}`}
        style={{
          display: "grid",
          gridTemplateColumns: showCodePanel ? "minmax(0, 1fr) var(--code-pane-width)" : "minmax(0, 1fr)",
          gridTemplateRows: "minmax(0, 1fr) auto",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
      <div className="code-pane-chat-column relative flex min-h-0 min-w-0 overflow-hidden" style={{ gridColumn: 1, gridRow: 1 }}>
        <div className="relative flex min-w-0 flex-1 overflow-hidden">
          <div ref={scrollContainerRef} className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]">
            <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
              <div ref={messageContentRef} style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>
                <ExtensionStatusBar
                  statuses={[
                    ...(cliConnected ? [{ key: "CLI", text: uiText.cliSync.connected }] : []),
                    ...extensionStatuses,
                  ]}
                />
                <ExtensionWidgets widgets={aboveEditorWidgets} />
            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              // Anchor for live-tail detection: the last user message, or a
              // compaction summary when compaction has replaced it mid-turn.
              // Computed independently from lastUserIdx (which is kept for the
              // scroll-to-user ref) because a compaction summary can sit after
              // the last user message and anchor the still-streaming segment.
              let lastAnchorIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (msg.role === "user" || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[] } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${idx}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    entryId={entryIds[idx]}
                    onFork={sessionBusy || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={sessionBusy ? undefined : handleNavigate}
                    prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
                    onEditContent={handleEditContent}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    docQaDocuments={msg.role === "assistant" ? docQaDocumentsByMessageIndex[idx] : undefined}
                    feedback={msg.role === "assistant" ? feedbackByEntryId[entryIds[idx]] : undefined}
                    onFeedbackChange={msg.role === "assistant" && session?.id ? updateMessageFeedback : undefined}
                    uiLanguage={uiLanguage}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                  />
                );
                if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
                return (
                  <div key={`${keyPrefix}-${idx}`} ref={attachVisibleRef(idx, currentRefIdx)}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                if (!isGroupAnchor(msg)) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }

                const userIdx = idx;
                let endIdx = userIdx + 1;
                while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                if (finalAssistantIdx === -1) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isLiveTail) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                rendered.push(renderMessage(userIdx));

                const processIndices: number[] = [];
                for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                  processIndices.push(processIdx);
                }
                const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]));
                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                const finalProcessMessage = finalSplit.processBlocks.length > 0
                  ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
                  : null;
                const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                  : null;

                const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
                if (processCount > 0) {
                  const processRefIdx = visibleProcessIndices
                    .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
                    .find((value): value is number => typeof value === "number")
                    ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
                  const processGroup = (
                    <ProcessDetailsGroup
                      messageCount={processCount}
                      defaultExpanded={!finalAnswerMessage}
                      t={t}
                      toolCallCount={countToolCalls(messages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}
                    >
                      {visibleProcessIndices.map((processIdx) => renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }))}
                      {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })}
                    </ProcessDetailsGroup>
                  );
                  rendered.push(
                    <div
                      key={`process-group-${userIdx}-${finalAssistantIdx}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      {processGroup}
                    </div>,
                  );
                }

                if (finalAnswerMessage) {
                  // Each tool call is stored as its own assistant entry, so the
                  // final answer alone carries no record of what the turn wrote.
                  // Gather the turn's assistant blocks and derive the file list
                  // from the write/edit calls among them.
                  const turnContent: AssistantContentBlock[] = [];
                  for (let i = userIdx + 1; i <= finalAssistantIdx; i++) {
                    const m = messages[i];
                    if (m?.role === "assistant") {
                      for (const b of (m as AssistantMessage).content ?? []) turnContent.push(b);
                    }
                  }
                  const writtenFiles = extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd);
                  rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage, writtenFiles }));
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                idx = endIdx;
              }
              const { startIndex, hasMore } = getVisibleRenderWindow(rendered.length, visibleCount);
              return (
                <>
                  {hasMore && (
                     <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier", { count: startIndex })}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}
            {streamState.isStreaming && hasStreamingContent && streamState.streamingMessage && (
              <MessageView
                message={streamState.streamingMessage as AgentMessage}
                isStreaming
                toolResults={toolResultsMap}
                modelNames={modelNames}
                cwd={messageCwd}
                onOpenFile={onOpenFile}
                docQaDocuments={streamingDocQaDocuments}
                uiLanguage={uiLanguage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {agentRunning && !hasStreamingContent && agentPhase && (
              <div
                role="status"
                aria-live="polite"
                aria-label={uiText.chatInput.thinking}
                className="amedac-thinking-indicator"
              >
                <FcnPilotIcon size={29} motion="thinking" />
                <span className="animate-[pulse_1.5s_infinite] break-words text-[13px] text-text-muted">
                  {phaseLabel(agentPhase, t)}
                </span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />

            <div ref={messagesEndRef} />
              </div>
            </div>
          </div>
          {isMobile ? null : (
            <ChatMinimap
              messages={messages}
              streamingMessage={streamState.streamingMessage}
              scrollContainer={scrollContainerRef}
              messageRefs={messageRefs}
              onRevealHistory={revealHistoryForMinimap}
            />
          )}
        </div>
      </div>
        {showCodePanel && codePanelArtifact && (
          <CodeGenerationPane
            artifact={codePanelArtifact}
            artifacts={codePanelArtifacts}
            onSelectArtifact={selectCodeArtifact}
            terminal={latestTerminalArtifact}
            cwd={session?.cwd ?? newSessionCwd ?? "."}
            onClose={closeCodePane}
            onAsk={askFromCodePane}
            onResizeStart={startCodePaneResize}
            resizing={codePaneResizing}
            fullWidth={codePaneFullWidth}
            onToggleFullWidth={toggleCodePaneFullWidth}
            onFileSaved={onCodeFileSaved}
            onTerminalRequest={onTerminalRequest}
            uiLanguage={uiLanguage}
          />
        )}

      <div className="code-pane-input-region relative min-w-0 overflow-hidden" style={{ gridColumn: 1, gridRow: 2 }}>
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
      </div>
      </div>
      )}
      {codePaneResizing && <div className="code-pane-resize-overlay" aria-hidden="true" />}
    </div>
  );
});

function NewSessionWelcome({
  username,
  accountUid,
  uiLanguage,
  isMobile,
  onAsk,
}: {
  username: string;
  accountUid?: string | null;
  uiLanguage: UiLanguage;
  isMobile: boolean;
  onAsk: (prompt: string) => void;
}) {
  const cleanUsername = username.trim() || "test";
  const uiText = textForLanguage(uiLanguage);
  const defaultSuggestions = NEW_SESSION_SUGGESTIONS[uiLanguage];
  const [suggestions, setSuggestions] = useState<string[]>(() => [...defaultSuggestions]);
  const [editingSuggestions, setEditingSuggestions] = useState(false);
  const [suggestionDrafts, setSuggestionDrafts] = useState<string[]>(() => [...defaultSuggestions]);
  const [suggestionsSaving, setSuggestionsSaving] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);

  useEffect(() => {
    setSuggestions(defaultSuggestions);
    setSuggestionDrafts(defaultSuggestions);
    setEditingSuggestions(false);
    setSuggestionsError(null);
    if (!accountUid) return;
    const controller = new AbortController();
    fetch("/api/accounts/preferences", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ preferences?: { welcomeSuggestions?: string[] } }>;
      })
      .then((result) => {
        const stored = result.preferences?.welcomeSuggestions
          ?.map((suggestion) => suggestion.trim())
          .filter(Boolean)
          .slice(0, 6);
        if (!stored?.length) return;
        setSuggestions(stored);
        setSuggestionDrafts(stored);
      })
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError") console.warn("Failed to load welcome suggestions:", loadError);
      });
    return () => controller.abort();
  }, [accountUid, defaultSuggestions]);

  const saveSuggestions = useCallback(async (next: string[] | null) => {
    if (suggestionsSaving) return;
    const normalized = next
      ?.map((suggestion) => suggestion.trim())
      .filter(Boolean)
      .slice(0, 6) ?? null;
    if (next && !normalized?.length) {
      setSuggestionsError(uiText.welcome.requireSuggestion);
      return;
    }
    setSuggestionsSaving(true);
    setSuggestionsError(null);
    try {
      const response = await fetch("/api/accounts/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ welcomeSuggestions: normalized }),
      });
      const result = await response.json().catch(() => ({})) as {
        preferences?: { welcomeSuggestions?: string[] };
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const saved = result.preferences?.welcomeSuggestions?.length
        ? result.preferences.welcomeSuggestions
        : defaultSuggestions;
      setSuggestions(saved);
      setSuggestionDrafts(saved);
      setEditingSuggestions(false);
    } catch (saveError) {
      setSuggestionsError(`${uiText.welcome.saveSuggestionsFailed}: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    } finally {
      setSuggestionsSaving(false);
    }
  }, [defaultSuggestions, suggestionsSaving, uiText.welcome]);

  return (
    <section
      aria-label={uiText.welcome.ariaLabel}
      style={{
        position: "relative",
        boxSizing: "border-box",
        margin: `0 ${isMobile ? 16 : 52}px 4px 16px`,
        transform: "translateY(-10px)",
        padding: "16px 18px 14px",
        borderRadius: 20,
        overflow: "hidden",
        border: "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))",
        background: [
          "radial-gradient(circle at 14% 18%, color-mix(in srgb, var(--accent) 18%, transparent) 0, transparent 30%)",
          "radial-gradient(circle at 86% 10%, rgba(168,85,247,0.16) 0, transparent 28%)",
          "linear-gradient(135deg, var(--welcome-card-surface) 0%, var(--bg) 100%)",
        ].join(", "),
        boxShadow: "0 12px 34px rgba(15,23,42,0.07)",
        transition: "background 0.24s ease, border-color 0.24s ease, box-shadow 0.24s ease",
      }}
    >
      <style>
        {`
          @keyframes amedac-cloud-float {
            0%, 100% { transform: translateY(0) rotate(var(--cloud-rotate, 0deg)); }
            50% { transform: translateY(-4px) rotate(var(--cloud-rotate, 0deg)); }
          }
          @keyframes amedac-welcome-orb {
            0%, 100% { transform: translate3d(0, 0, 0) scale(1); opacity: .72; }
            50% { transform: translate3d(10px, -8px, 0) scale(1.06); opacity: .95; }
          }
        `}
      </style>
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: 136,
          height: 136,
          borderRadius: 999,
          right: -36,
          top: -42,
          background: "color-mix(in srgb, var(--accent) 18%, transparent)",
          filter: "blur(2px)",
          animation: "amedac-welcome-orb 5.8s ease-in-out infinite",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: 92,
          height: 92,
          borderRadius: 999,
          left: -26,
          bottom: -34,
          background: "rgba(34,197,94,0.12)",
          animation: "amedac-welcome-orb 6.4s ease-in-out infinite reverse",
        }}
      />

      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 13,
            display: "grid",
            placeItems: "center",
            background: "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))",
            border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
            boxShadow: "0 9px 22px color-mix(in srgb, var(--accent) 10%, transparent)",
            flexShrink: 0,
          }}
        >
          <FcnPilotIcon size={26} animated />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              color: "var(--text)",
              fontSize: "clamp(19px, 2.7vw, 27px)",
              fontWeight: 760,
              letterSpacing: "-0.035em",
              lineHeight: 1.06,
            }}
          >
            {uiLanguage === "zh"
              ? `${uiText.welcome.greeting}，${cleanUsername}，${uiText.welcome.welcomeTo}`
              : `${uiText.welcome.greeting}, ${cleanUsername}. ${uiText.welcome.welcomeTo}`}
          </div>
          <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.4 }}>
            {uiText.welcome.subtitle}
          </div>
        </div>
      </div>

      <div style={{ position: "relative", marginTop: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            {uiText.welcome.tryAsking}
          </div>
          <button
            type="button"
            aria-expanded={editingSuggestions}
            title={uiText.welcome.editSuggestions}
            onClick={() => {
              setSuggestionDrafts(suggestions);
              setSuggestionsError(null);
              setEditingSuggestions((editing) => !editing);
            }}
            style={{
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0 8px",
              border: "1px solid var(--welcome-label-border)",
              borderRadius: 7,
              background: editingSuggestions ? "color-mix(in srgb, var(--accent) 10%, var(--bg))" : "var(--bg)",
              color: editingSuggestions ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m10.8 2.2 3 3-8.2 8.2-3.6.6.6-3.6z" />
              <path d="m9.5 3.5 3 3" />
            </svg>
            {uiText.welcome.edit}
          </button>
        </div>
        {editingSuggestions && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveSuggestions(suggestionDrafts);
            }}
            style={{
              marginBottom: 10,
              padding: 10,
              border: "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))",
              borderRadius: 11,
              background: "color-mix(in srgb, var(--bg-panel) 94%, var(--accent) 2%)",
              boxShadow: "0 8px 22px rgba(15,23,42,0.05)",
            }}
          >
            <div style={{ display: "grid", gap: 6 }}>
              {suggestionDrafts.map((suggestion, index) => (
                <div key={index} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 16, flexShrink: 0, color: "var(--text-dim)", fontSize: 10, textAlign: "right" }}>
                    {index + 1}
                  </span>
                  <input
                    value={suggestion}
                    maxLength={240}
                    aria-label={`${uiText.welcome.suggestion} ${index + 1}`}
                    placeholder={uiText.welcome.suggestionPlaceholder}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSuggestionDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? value : item));
                    }}
                    style={{
                      minWidth: 0,
                      flex: 1,
                      height: 32,
                      padding: "0 9px",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      fontSize: 11,
                    }}
                  />
                  <button
                    type="button"
                    disabled={suggestionDrafts.length <= 1}
                    title={uiText.welcome.removeSuggestion}
                    aria-label={`${uiText.welcome.removeSuggestion} ${index + 1}`}
                    onClick={() => setSuggestionDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    style={{
                      width: 28,
                      height: 28,
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      background: "var(--bg)",
                      color: "var(--text-dim)",
                      cursor: suggestionDrafts.length <= 1 ? "not-allowed" : "pointer",
                      opacity: suggestionDrafts.length <= 1 ? 0.4 : 1,
                    }}
                  >
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M3 4h10M6 4V2.8h4V4M5 6.2v6.3M8 6.2v6.3M11 6.2v6.3M4 4l.7 10h6.6L12 4" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            {suggestionsError && (
              <div role="alert" style={{ marginTop: 7, color: "#ef4444", fontSize: 10.5 }}>
                {suggestionsError}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9 }}>
              <button
                type="button"
                disabled={suggestionDrafts.length >= 6 || suggestionsSaving}
                onClick={() => setSuggestionDrafts((current) => [...current, ""])}
                style={{
                  height: 28,
                  padding: "0 9px",
                  border: "1px dashed var(--border)",
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: suggestionDrafts.length >= 6 || suggestionsSaving ? "not-allowed" : "pointer",
                  opacity: suggestionDrafts.length >= 6 ? 0.45 : 1,
                  fontSize: 10.5,
                }}
              >
                + {uiText.welcome.addSuggestion}
              </button>
              <button
                type="button"
                disabled={suggestionsSaving}
                onClick={() => void saveSuggestions(null)}
                style={{
                  height: 28,
                  padding: "0 9px",
                  border: "none",
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: suggestionsSaving ? "wait" : "pointer",
                  fontSize: 10.5,
                }}
              >
                {uiText.welcome.restoreDefaults}
              </button>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                disabled={suggestionsSaving}
                onClick={() => {
                  setSuggestionDrafts(suggestions);
                  setSuggestionsError(null);
                  setEditingSuggestions(false);
                }}
                style={{
                  height: 28,
                  padding: "0 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg)",
                  color: "var(--text-muted)",
                  cursor: suggestionsSaving ? "not-allowed" : "pointer",
                  fontSize: 10.5,
                }}
              >
                {uiText.common.cancel}
              </button>
              <button
                type="submit"
                disabled={suggestionsSaving}
                style={{
                  height: 28,
                  padding: "0 11px",
                  border: "none",
                  borderRadius: 7,
                  background: "var(--accent)",
                  color: "#fff",
                  cursor: suggestionsSaving ? "wait" : "pointer",
                  opacity: suggestionsSaving ? 0.65 : 1,
                  fontSize: 10.5,
                  fontWeight: 750,
                }}
              >
                {suggestionsSaving ? uiText.welcome.saving : uiText.welcome.save}
              </button>
            </div>
          </form>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 10px", alignItems: "center" }}>
          {suggestions.map((suggestion, index) => (
            <button
              key={`${index}:${suggestion}`}
              type="button"
              onClick={() => onAsk(suggestion)}
              style={{
                "--cloud-rotate": index === 1 ? "1.2deg" : index === 2 ? "-1.5deg" : "-0.5deg",
                position: "relative",
                minHeight: 40,
                maxWidth: index === 2 ? 300 : 255,
                padding: "9px 14px",
                border: "1px solid var(--welcome-label-border)",
                borderRadius: "999px 999px 999px 22px",
                background: "linear-gradient(180deg, var(--welcome-label-top), var(--welcome-label-bottom))",
                color: "var(--text)",
                boxShadow: "var(--welcome-label-shadow)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 650,
                lineHeight: 1.35,
                textAlign: "left",
                letterSpacing: "0.005em",
                animation: `amedac-cloud-float ${4.6 + index * 0.45}s ease-in-out infinite`,
                animationDelay: `${index * 0.18}s`,
                transition: "transform 0.16s ease, background 0.24s ease, box-shadow 0.16s ease, border-color 0.16s ease, color 0.16s ease",
              } as CSSProperties}
              onMouseEnter={(event) => {
                event.currentTarget.style.transform = "translateY(-3px) scale(1.012)";
                event.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 40%, var(--border))";
                event.currentTarget.style.boxShadow = "var(--welcome-label-hover-shadow)";
                event.currentTarget.style.color = "var(--accent)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.transform = "";
                event.currentTarget.style.borderColor = "var(--welcome-label-border)";
                event.currentTarget.style.boxShadow = "var(--welcome-label-shadow)";
                event.currentTarget.style.color = "var(--text)";
              }}
            >
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  width: 24,
                  height: 24,
                  borderRadius: 999,
                  top: -8,
                  left: 18,
                  background: "inherit",
                  borderTop: "inherit",
                  borderLeft: "inherit",
                  pointerEvents: "none",
                }}
              />
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  top: -12,
                  left: 41,
                  background: "inherit",
                  borderTop: "inherit",
                  pointerEvents: "none",
                }}
              />
              <span style={{ position: "relative", zIndex: 1 }}>{suggestion}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function CodeGenerationPane({
  artifact,
  artifacts,
  onSelectArtifact,
  terminal,
  cwd,
  onClose,
  onAsk,
  onResizeStart,
  resizing,
  fullWidth,
  onToggleFullWidth,
  onFileSaved,
  onTerminalRequest,
  uiLanguage,
  tabMode = false,
}: {
  artifact: CodeArtifact;
  artifacts: CodeArtifact[];
  onSelectArtifact: (artifactId: string) => void;
  terminal?: CodeTerminalArtifact | null;
  cwd: string;
  onClose: () => void;
  onAsk?: (prompt: string) => void;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  resizing: boolean;
  fullWidth: boolean;
  onToggleFullWidth?: () => void;
  onFileSaved?: () => void;
  onTerminalRequest?: (request?: TerminalOpenRequest) => void;
  uiLanguage: UiLanguage;
  tabMode?: boolean;
}) {
  const { isDark } = useTheme();
  const dialog = useAppDialog();
  const uiText = textForLanguage(uiLanguage);
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // In tab mode the generated code is a standalone workspace tab. Terminal
  // commands must not automatically create a second panel underneath it.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const saveResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineCount = artifact.code ? artifact.code.split(/\r?\n/).length : 0;
  const displayCode = artifact.complete
    ? artifact.code
    : `${artifact.code}${artifact.code.endsWith("\n") || artifact.code.length === 0 ? "" : "\n"}▌`;
  const statusText = artifact.complete
    ? `${uiText.codePane.title} · ${artifact.operation === "edit" ? uiText.codePane.modified : uiText.codePane.updated}`
    : `${uiText.codePane.title} · ${artifact.operation === "edit" ? uiText.codePane.editing : uiText.codePane.writing}`;

  useEffect(() => {
    if (artifact.complete) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [artifact.code, artifact.complete]);

  useEffect(() => {
    setSaveState("idle");
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (saveResetTimerRef.current) {
      clearTimeout(saveResetTimerRef.current);
      saveResetTimerRef.current = null;
    }
  }, [artifact.id]);

  useEffect(() => () => {
    if (saveResetTimerRef.current) clearTimeout(saveResetTimerRef.current);
  }, []);

  const handleCopy = useCallback(() => {
    void copyCode(artifact.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [artifact.code]);

  const askForModification = useCallback(() => {
    onAsk?.(uiText.codePane.continuePrompt);
  }, [onAsk, uiText.codePane.continuePrompt]);

  const handleSaveFile = useCallback(async () => {
    if (!artifact.complete || saveState === "saving") return;
    const requested = await dialog.prompt({
      title: uiText.codePane.saveFile,
      message: uiText.codePane.saveFileMessage,
      defaultValue: artifact.suggestedFileName,
      placeholder: artifact.suggestedFileName,
      confirmLabel: uiText.codePane.saveFile,
    });
    const relativePath = requested?.trim().replace(/\\/g, "/");
    if (!relativePath) return;

    setSaveState("saving");
    try {
      const createResponse = await fetch(`/api/files/${encodeFilePathForApi(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "file", name: relativePath, content: artifact.code }),
      });
      const createResult = await createResponse.json().catch(() => ({})) as { path?: string; error?: string };
      let savedPath = createResult.path;

      if (createResponse.status === 409) {
        const overwrite = await dialog.confirm({
          title: uiText.codePane.overwriteFile,
          message: uiText.codePane.overwriteFileMessage,
          confirmLabel: uiText.codePane.overwrite,
          danger: true,
        });
        if (!overwrite) {
          setSaveState("idle");
          return;
        }
        savedPath = joinFilePath(cwd, relativePath);
        const overwriteResponse = await fetch(`/api/files/${encodeFilePathForApi(savedPath)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: artifact.code }),
        });
        const overwriteResult = await overwriteResponse.json().catch(() => ({})) as { error?: string };
        if (!overwriteResponse.ok) {
          throw new Error(overwriteResult.error || `Save failed (HTTP ${overwriteResponse.status})`);
        }
      } else if (!createResponse.ok || !savedPath) {
        throw new Error(createResult.error || `Save failed (HTTP ${createResponse.status})`);
      }

      setSaveState("saved");
      onFileSaved?.();
      saveResetTimerRef.current = setTimeout(() => {
        setSaveState("idle");
        saveResetTimerRef.current = null;
      }, 1800);
    } catch (saveError) {
      setSaveState("error");
      await dialog.alert({
        title: uiText.codePane.saveFailed,
        message: saveError instanceof Error ? saveError.message : String(saveError),
      });
    }
  }, [
    artifact.code,
    artifact.complete,
    artifact.suggestedFileName,
    cwd,
    dialog,
    onFileSaved,
    saveState,
    uiText.codePane,
  ]);

  return (
    <aside
      className="code-generation-pane"
      style={{
        gridColumn: 2,
        gridRow: "1 / -1",
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        maxWidth: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxSizing: "border-box",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg)",
        boxShadow: "-16px 0 36px rgba(15,23,42,0.06)",
        flexShrink: 0,
      }}
    >
      {!tabMode && onResizeStart && <div
        className={`code-generation-pane-resizer${resizing ? " is-resizing" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={uiLanguage === "zh" ? "调整代码栏宽度" : "Resize code pane"}
        title={uiLanguage === "zh" ? "拖动调整宽度，双击铺满" : "Drag to resize, double-click to fill"}
        onPointerDown={onResizeStart}
        onDoubleClick={onToggleFullWidth}
      />}
      <style>{`
        @keyframes amedac-code-dot {
          0%, 100% { opacity: 0.35; transform: scale(0.86); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        @keyframes amedac-code-save-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minHeight: 42,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: 8,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            color: "var(--accent)",
            fontSize: 12,
            fontWeight: 900,
            flexShrink: 0,
          }}
        >
          {"</>"}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            {!artifact.complete && (
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: "var(--accent)",
                  animation: "amedac-code-dot 1.05s ease-in-out infinite",
                  flexShrink: 0,
                }}
              />
            )}
            <span style={{ color: "var(--text)", fontWeight: 800, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {statusText}
            </span>
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {artifact.suggestedFileName} · {artifact.language || "code"} · {lineCount} {uiText.codePane.lines}
          </div>
        </div>
        {onTerminalRequest && <button
          type="button"
          onClick={() => onTerminalRequest({
            command: terminal?.command,
            key: terminal?.id,
            contextLabel: artifact.suggestedFileName,
          })}
          title={uiText.codePane.openTerminal}
          style={{
            height: 28,
            padding: "0 9px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
        >
          &gt;_
        </button>}
        <button
          type="button"
          onClick={handleCopy}
          style={{
            height: 28,
            padding: "0 9px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: copied ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {copied ? uiText.common.copied : uiText.common.copy}
        </button>
        <button
          type="button"
          onClick={() => void handleSaveFile()}
          disabled={!artifact.complete || saveState === "saving"}
          aria-label={saveState === "saved" ? uiText.codePane.savedFile : uiText.codePane.saveFile}
          title={!artifact.complete
            ? uiText.codePane.saveAfterGeneration
            : saveState === "saved"
              ? uiText.codePane.savedFile
              : uiText.codePane.saveFile}
          style={{
            width: 28,
            height: 28,
            display: "grid",
            placeItems: "center",
            padding: 0,
            borderRadius: 7,
            border: `1px solid ${saveState === "error" ? "rgba(239,68,68,0.35)" : "var(--border)"}`,
            background: saveState === "saved"
              ? "color-mix(in srgb, #22c55e 11%, var(--bg))"
              : "var(--bg)",
            color: saveState === "saved"
              ? "#22c55e"
              : saveState === "error"
                ? "#ef4444"
                : "var(--text-muted)",
            cursor: !artifact.complete || saveState === "saving" ? "not-allowed" : "pointer",
            opacity: !artifact.complete ? 0.45 : 1,
          }}
        >
          {saveState === "saving" ? (
            <span
              aria-hidden="true"
              style={{
                width: 11,
                height: 11,
                border: "1.5px solid currentColor",
                borderRightColor: "transparent",
                borderRadius: "50%",
                animation: "amedac-code-save-spin 0.75s linear infinite",
              }}
            />
          ) : saveState === "saved" ? (
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 8.2 3 3L13 4.5" />
            </svg>
          ) : (
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 2.5h9l2 2v9h-11z" />
              <path d="M5 2.5v4h5v-4M5 13.5v-4h6v4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={askForModification}
          style={{
            height: 28,
            padding: "0 9px",
            borderRadius: 7,
            border: "1px solid rgba(59,130,246,0.28)",
            background: "rgba(59,130,246,0.08)",
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {uiText.codePane.continueEditing}
        </button>
        <button
          type="button"
          aria-label={fullWidth
            ? (uiLanguage === "zh" ? "恢复代码栏宽度" : "Restore code pane")
            : (uiLanguage === "zh" ? "铺满代码栏" : "Fill code pane")}
          title={fullWidth
            ? (uiLanguage === "zh" ? "恢复对话与代码分栏" : "Restore chat and code split")
            : (uiLanguage === "zh" ? "代码栏铺满当前工作区" : "Fill the current workspace with code")}
          onClick={onToggleFullWidth}
          style={{
            width: 28,
            height: 28,
            display: "grid",
            placeItems: "center",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: fullWidth ? "var(--bg-selected)" : "var(--bg)",
            color: fullWidth ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {fullWidth ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 6H2V2M10 6h4V2M6 10H2v4M10 10h4v4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          aria-label={uiText.codePane.close}
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {artifacts.length > 0 && (
        <div
          role="tablist"
          aria-label={uiText.codePane.chooseCodeGroup}
          style={{
            maxHeight: 154,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "7px 8px 8px",
            overflowY: "auto",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--bg-panel) 90%, var(--accent) 2%)",
            scrollbarWidth: "thin",
          }}
        >
          <div
            style={{
              minHeight: 18,
              padding: "0 3px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              color: "var(--text-dim)",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            <span>{uiText.codePane.codeGroups}</span>
            <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{artifacts.length}</span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
              gap: 5,
            }}
          >
            {artifacts.map((candidate, index) => {
              const selected = candidate.id === artifact.id;
              const candidateLineCount = candidate.code ? candidate.code.split(/\r?\n/).length : 0;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={`${index + 1}/${artifacts.length} · ${candidate.suggestedFileName}`}
                  onClick={() => onSelectArtifact(candidate.id)}
                  style={{
                    minWidth: 0,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "0 8px",
                    border: `1px solid ${selected ? "color-mix(in srgb, var(--accent) 42%, var(--border))" : "var(--border)"}`,
                    borderRadius: 6,
                    background: selected
                      ? "color-mix(in srgb, var(--accent) 10%, var(--bg))"
                      : "var(--bg)",
                    color: selected ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 10.5,
                    fontWeight: selected ? 750 : 600,
                    textAlign: "left",
                  }}
                >
                  <span style={{ color: selected ? "var(--accent)" : "var(--text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                    {index + 1}
                  </span>
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {candidate.suggestedFileName}
                  </span>
                  <span style={{ color: "var(--text-dim)", fontSize: 9.5, fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0 }}>
                    {candidateLineCount} {uiText.codePane.lines}
                  </span>
                  {!candidate.complete && (
                    <span
                      aria-label={uiText.codePane.writing}
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: "var(--accent)",
                        flexShrink: 0,
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflow: "hidden" }}>
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            borderTop: "1px solid color-mix(in srgb, var(--accent) 7%, transparent)",
          }}
        >
        <SyntaxHighlighter
          language={artifact.language || "text"}
          style={isDark ? vscDarkPlus : vs}
          showLineNumbers
          lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal", minWidth: "2.75em" }}
          customStyle={{
            margin: 0,
            minHeight: "100%",
            padding: "14px 16px 28px",
            color: "var(--text)",
            fontSize: 13,
            lineHeight: 1.58,
            tabSize: 2,
            borderRadius: 0,
            background: "var(--bg-panel)",
          }}
          codeTagProps={{
            style: {
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre",
            },
          }}
        >
          {displayCode}
        </SyntaxHighlighter>
        </div>
      </div>
    </aside>
  );
}

function NoticeShelf({ notices, floating = false }: { notices: NoticeItem[]; floating?: boolean }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
