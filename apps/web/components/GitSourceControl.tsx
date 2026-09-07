"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UiLanguage } from "@/lib/i18n";
import { getFileIcon } from "./FileIcons";
import { useAppDialog } from "./AppDialogProvider";

interface GitStatusEntry {
  path: string;
  absolutePath: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  changed: boolean;
  untracked: boolean;
  conflicted: boolean;
  deleted: boolean;
}

interface GitStatus {
  available: boolean;
  root: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  graph?: string[];
  error?: string;
}

interface GitCommitDetails {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{
    status: string;
    path: string;
    previousPath?: string;
    absolutePath: string;
    exists: boolean;
  }>;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onClose?: () => void;
  refreshKey?: number;
  uiLanguage?: UiLanguage;
}

type GroupKind = "conflicts" | "staged" | "changes" | "untracked";

interface StatusGroup {
  kind: GroupKind;
  entries: GitStatusEntry[];
}

const LABELS = {
  en: {
    sourceControl: "Source Control",
    refresh: "Refresh source control",
    noChanges: "No uncommitted changes",
    conflicts: "Merge Changes",
    staged: "Staged Changes",
    changes: "Changes",
    untracked: "Untracked",
    openFile: "Open file",
    deleted: "Deleted file",
    ahead: "ahead",
    behind: "behind",
    loading: "Reading repository status…",
    notRepository: "This workspace is not a Git repository.",
    unavailable: "Unable to read repository status.",
    close: "Close source control",
    hide: "Hide Source Control",
    graph: "Git Graph",
    noCommits: "No commits yet",
    commitDetails: "Commit details",
    changedFiles: "Changed files",
    loadingCommit: "Loading commit…",
    commitUnavailable: "Unable to load this commit.",
    openWorkingTreeFile: "Open working tree file",
    repository: "Repository",
    commitPlaceholder: "Message (Ctrl+Enter to commit)",
    commit: "Commit",
    committing: "Committing…",
    stage: "Stage Changes",
    unstage: "Unstage Changes",
    discard: "Discard Changes",
    stageAll: "Stage All Changes",
    unstageAll: "Unstage All Changes",
    discardTitle: "Discard changes?",
    discardMessage: "This permanently discards the selected working tree changes.",
    actionFailed: "Git operation failed",
  },
  zh: {
    sourceControl: "源代码管理",
    refresh: "刷新源代码管理",
    noChanges: "没有未提交的更改",
    conflicts: "合并冲突",
    staged: "已暂存的更改",
    changes: "更改",
    untracked: "未跟踪",
    openFile: "打开文件",
    deleted: "文件已删除",
    ahead: "领先",
    behind: "落后",
    loading: "正在读取仓库状态…",
    notRepository: "当前工作区不是 Git 仓库。",
    unavailable: "无法读取仓库状态。",
    close: "关闭源代码管理",
    hide: "隐藏源代码管理",
    graph: "Git 提交树",
    noCommits: "暂无提交记录",
    commitDetails: "提交详情",
    changedFiles: "变更文件",
    loadingCommit: "正在加载提交…",
    commitUnavailable: "无法加载该提交。",
    openWorkingTreeFile: "打开工作区文件",
    repository: "仓库",
    commitPlaceholder: "消息（Ctrl+Enter 提交）",
    commit: "提交",
    committing: "正在提交…",
    stage: "暂存更改",
    unstage: "取消暂存",
    discard: "放弃更改",
    stageAll: "暂存所有更改",
    unstageAll: "取消暂存所有更改",
    discardTitle: "放弃更改？",
    discardMessage: "此操作会永久丢弃所选工作区更改。",
    actionFailed: "Git 操作失败",
  },
} as const;

function commitHashFromGraphLine(line: string): string | null {
  return line.match(/([0-9a-f]{7,40})\t/i)?.[1] ?? null;
}

function fileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function directoryName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const splitAt = normalized.lastIndexOf("/");
  return splitAt > 0 ? normalized.slice(0, splitAt) : "";
}

function badgeFor(entry: GitStatusEntry, kind: GroupKind): string {
  if (kind === "untracked") return "U";
  if (kind === "conflicts") return "!";
  const status = kind === "staged" ? entry.indexStatus : entry.worktreeStatus;
  if (status === "M") return "M";
  if (status === "A") return "A";
  if (status === "D") return "D";
  if (status === "R") return "R";
  if (status === "C") return "C";
  return status.trim() || "M";
}

function badgeColor(kind: GroupKind, entry: GitStatusEntry): string {
  if (kind === "conflicts") return "#ef4444";
  if (kind === "untracked" || badgeFor(entry, kind) === "A") return "#22a06b";
  if (badgeFor(entry, kind) === "D") return "#ef4444";
  if (kind === "staged") return "#4f8cff";
  return "#d69e2e";
}

export const GitSourceControl = memo(function GitSourceControl({
  cwd,
  onOpenFile,
  onClose,
  refreshKey = 0,
  uiLanguage = "en",
}: Props) {
  const labels = LABELS[uiLanguage];
  const dialog = useAppDialog();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [open, setOpen] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKind>>(new Set());
  const [graphOpen, setGraphOpen] = useState(true);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitDetails, setCommitDetails] = useState<GitCommitDetails | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const commitRequestRef = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async (quiet = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json() as GitStatus & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setStatus(data);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setStatus((current) => current
          ? { ...current, error: String(error) }
          : {
              available: false,
              root: null,
              branch: null,
              ahead: 0,
              behind: 0,
              entries: [],
              error: String(error),
            });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setRefreshing(false);
      }
    }
  }, [cwd]);

  useEffect(() => {
    setStatus(null);
    void loadStatus();
    return () => requestRef.current?.abort();
  }, [loadStatus, refreshKey]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadStatus(true);
    };
    const timer = window.setInterval(refreshWhenVisible, 5000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadStatus]);

  const selectCommit = useCallback(async (commit: string) => {
    commitRequestRef.current?.abort();
    if (selectedCommit === commit) {
      setSelectedCommit(null);
      setCommitDetails(null);
      setCommitError(null);
      return;
    }
    setSelectedCommit(commit);
    setCommitDetails(null);
    setCommitError(null);
    setCommitLoading(true);
    const controller = new AbortController();
    commitRequestRef.current = controller;
    try {
      const response = await fetch(`/api/git/commit?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commit)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json() as GitCommitDetails & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setCommitDetails(data);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setCommitError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (commitRequestRef.current === controller) {
        commitRequestRef.current = null;
        setCommitLoading(false);
      }
    }
  }, [cwd, selectedCommit]);

  useEffect(() => () => commitRequestRef.current?.abort(), []);

  const runAction = useCallback(async (
    action: "stage" | "unstage" | "discard" | "commit",
    paths?: string[],
  ) => {
    if (actionBusy) return;
    if (action === "discard") {
      const confirmed = await dialog.confirm({
        title: labels.discardTitle,
        message: paths?.length === 1
          ? `${labels.discardMessage}\n${paths[0]}`
          : `${labels.discardMessage}\n${paths?.length ?? 0} files`,
        confirmLabel: labels.discard,
        danger: true,
      });
      if (!confirmed) return;
    }

    const busyKey = action === "commit" ? "commit" : `${action}:${paths?.join("\0") ?? ""}`;
    setActionBusy(busyKey);
    setActionError(null);
    try {
      const response = await fetch("/api/git/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          action,
          paths,
          message: action === "commit" ? commitMessage : undefined,
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (action === "commit") setCommitMessage("");
      await loadStatus(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      await dialog.alert({ title: labels.actionFailed, message, danger: true });
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, commitMessage, cwd, dialog, labels, loadStatus]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const groups = useMemo<StatusGroup[]>(() => {
    if (!status?.available) return [];
    return [
      { kind: "conflicts", entries: status.entries.filter((entry) => entry.conflicted) },
      { kind: "staged", entries: status.entries.filter((entry) => entry.staged) },
      { kind: "changes", entries: status.entries.filter((entry) => entry.changed) },
      { kind: "untracked", entries: status.entries.filter((entry) => entry.untracked) },
    ].filter((group) => group.entries.length > 0) as StatusGroup[];
  }, [status]);

  return (
    <section
      aria-label={labels.sourceControl}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
      }}
    >
      <div
        onContextMenu={(event) => {
          if (!onClose) return;
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            x: Math.min(event.clientX, window.innerWidth - 178),
            y: Math.min(event.clientY, window.innerHeight - 42),
          });
        }}
        style={{ display: "flex", alignItems: "center", minHeight: 31, padding: "0 6px 0 3px" }}
      >
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          title={labels.sourceControl}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            height: 30,
            padding: "0 6px",
            border: 0,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
            aria-hidden="true"
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="6" cy="4" r="2" />
            <circle cx="18" cy="8" r="2" />
            <circle cx="6" cy="20" r="2" />
            <path d="M6 6v12M8 8h5a5 5 0 0 1 5 5" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 650, letterSpacing: "0.035em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
            {labels.sourceControl}
          </span>
          {status?.available && status.entries.length > 0 && (
            <span style={{ marginLeft: "auto", minWidth: 17, padding: "1px 5px", borderRadius: 8, background: "var(--bg-hover)", fontSize: 10, textAlign: "center" }}>
              {status.entries.length}
            </span>
          )}
        </button>
        <button
          type="button"
          aria-label={labels.refresh}
          title={labels.refresh}
          onClick={() => void loadStatus()}
          style={{
            display: "grid",
            placeItems: "center",
            flex: "0 0 22px",
            width: 22,
            height: 22,
            padding: 0,
            border: 0,
            borderRadius: 4,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ animation: refreshing ? "git-status-refresh-spin 0.7s linear infinite" : "none" }}
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M18.2 9A7 7 0 0 0 6 6.5L4 9M5.8 15A7 7 0 0 0 18 17.5l2-2.5" />
          </svg>
        </button>
        {onClose && (
          <button
            type="button"
            aria-label={labels.close}
            title={labels.close}
            onClick={onClose}
            style={{
              display: "grid",
              placeItems: "center",
              flex: "0 0 22px",
              width: 22,
              height: 22,
              padding: 0,
              border: 0,
              borderRadius: 4,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div style={{ minHeight: 0, overflowY: "auto", padding: "1px 5px 7px" }}>
          {!status && (
            <div style={{ padding: "18px 12px", color: "var(--text-dim)", fontSize: 11 }}>
              {labels.loading}
            </div>
          )}
          {status && !status.available && (
            <div style={{ padding: "18px 12px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.55 }}>
              {status.error ? labels.unavailable : labels.notRepository}
            </div>
          )}
          {status?.available && (
            <>
              <div className="scm-repository-row">
                <span className="scm-repository-icon" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12M8 8h5a5 5 0 0 1 5 5" />
                  </svg>
                </span>
                <span title={status.root ?? ""} className="scm-repository-name">
                  {status.root ? fileName(status.root) : labels.repository}
                </span>
                <span title={status.branch ?? ""} className="scm-branch-pill">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <circle cx="6" cy="5" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 9h5a5 5 0 0 1 5 5" />
                  </svg>
                  {status.branch}
                </span>
                {(status.ahead > 0 || status.behind > 0) && (
                  <span className="scm-sync-counts">
                    {status.ahead > 0 ? `↑${status.ahead}` : ""}
                    {status.behind > 0 ? ` ↓${status.behind}` : ""}
                  </span>
                )}
              </div>
              <div className="scm-commit-box">
                <textarea
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      event.preventDefault();
                      if (commitMessage.trim() && status.entries.some((entry) => entry.staged) && !actionBusy) {
                        void runAction("commit");
                      }
                    }
                  }}
                  placeholder={labels.commitPlaceholder}
                  aria-label={labels.commitPlaceholder}
                  rows={2}
                  spellCheck={false}
                />
                <button
                  type="button"
                  disabled={!commitMessage.trim() || !status.entries.some((entry) => entry.staged) || Boolean(actionBusy)}
                  onClick={() => void runAction("commit")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                  {actionBusy === "commit" ? labels.committing : labels.commit}
                </button>
              </div>
              {actionError && <div className="scm-action-error">{actionError}</div>}
            </>
          )}
          {status?.available && groups.length === 0 && (
            <div style={{ padding: "8px 10px 9px 29px", color: "var(--text-dim)", fontSize: 11 }}>
              {labels.noChanges}
            </div>
          )}
          {groups.map((group) => {
            const collapsed = collapsedGroups.has(group.kind);
            return (
              <div key={group.kind}>
                <div className="scm-group-header">
                  <button
                    type="button"
                    onClick={() => setCollapsedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.kind)) next.delete(group.kind);
                      else next.add(group.kind);
                      return next;
                    })}
                    className="scm-group-toggle"
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}
                      aria-hidden="true"
                    >
                      <polyline points="3 2 7 5 3 8" />
                    </svg>
                    <span>{labels[group.kind]}</span>
                    <span className="scm-group-count">{group.entries.length}</span>
                  </button>
                  <button
                    type="button"
                    className="scm-inline-action scm-group-action"
                    disabled={Boolean(actionBusy)}
                    title={group.kind === "staged" ? labels.unstageAll : labels.stageAll}
                    aria-label={group.kind === "staged" ? labels.unstageAll : labels.stageAll}
                    onClick={() => void runAction(
                      group.kind === "staged" ? "unstage" : "stage",
                      group.entries.map((entry) => entry.path),
                    )}
                  >
                    {group.kind === "staged" ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 12h12" /></svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 6v12M6 12h12" /></svg>
                    )}
                  </button>
                </div>
                {!collapsed && group.entries.map((entry) => {
                  const name = fileName(entry.path);
                  const directory = directoryName(entry.path);
                  const disabled = entry.deleted;
                  return (
                    <div
                      key={`${group.kind}:${entry.path}`}
                      className="scm-file-row"
                    >
                      <button
                        type="button"
                        disabled={disabled}
                        title={disabled ? `${labels.deleted}: ${entry.path}` : `${labels.openFile}: ${entry.path}`}
                        onClick={() => onOpenFile(entry.absolutePath, name)}
                        className="scm-file-main"
                      >
                        <span style={{ display: "flex", alignItems: "center", flex: "0 0 auto" }}>{getFileIcon(name, 13)}</span>
                        <span className="scm-file-name">{name}</span>
                        {directory && <span className="scm-file-directory">{directory}</span>}
                      </button>
                      <div className="scm-file-actions">
                        {(group.kind === "changes" || group.kind === "untracked") && (
                          <button
                            type="button"
                            className="scm-inline-action"
                            disabled={Boolean(actionBusy)}
                            title={labels.discard}
                            aria-label={`${labels.discard}: ${entry.path}`}
                            onClick={() => void runAction("discard", [entry.path])}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
                            </svg>
                          </button>
                        )}
                        <button
                          type="button"
                          className="scm-inline-action"
                          disabled={Boolean(actionBusy)}
                          title={group.kind === "staged" ? labels.unstage : labels.stage}
                          aria-label={`${group.kind === "staged" ? labels.unstage : labels.stage}: ${entry.path}`}
                          onClick={() => void runAction(group.kind === "staged" ? "unstage" : "stage", [entry.path])}
                        >
                          {group.kind === "staged" ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M6 12h12" /></svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12" /></svg>
                          )}
                        </button>
                      </div>
                      <span
                        aria-label={badgeFor(entry, group.kind)}
                        className="scm-file-status"
                        style={{ color: badgeColor(group.kind, entry) }}
                      >
                        {badgeFor(entry, group.kind)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {status?.available && (
            <div style={{ marginTop: 7, paddingTop: 5, borderTop: "1px solid var(--border)" }}>
              <button
                type="button"
                onClick={() => setGraphOpen((current) => !current)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  width: "100%",
                  height: 26,
                  padding: "0 7px",
                  border: 0,
                  borderRadius: 4,
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 650,
                  textAlign: "left",
                }}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: graphOpen ? "rotate(90deg)" : "none", transition: "transform 0.12s" }} aria-hidden="true">
                  <polyline points="3 2 7 5 3 8" />
                </svg>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12M8 8h5a5 5 0 0 1 5 5" /></svg>
                <span>{labels.graph}</span>
                <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontWeight: 500 }}>{status.graph?.filter((line) => commitHashFromGraphLine(line)).length ?? 0}</span>
              </button>
              {graphOpen && (
                <div style={{ maxHeight: 360, overflow: "auto", margin: "0 3px 5px", padding: "5px", border: "1px solid var(--border)", borderRadius: 6, background: "color-mix(in srgb, var(--bg) 86%, var(--bg-panel))" }}>
                  {status.graph?.length ? status.graph.map((line, index) => {
                    const commit = commitHashFromGraphLine(line);
                    const selected = commit !== null && selectedCommit === commit;
                    if (!commit) {
                      return (
                        <div
                          key={`${index}:${line}`}
                          aria-hidden="true"
                          style={{ minWidth: "max-content", padding: "0 5px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.65, whiteSpace: "pre" }}
                        >
                          {line}
                        </div>
                      );
                    }
                    return (
                      <div key={`${index}:${line}`}>
                        <button
                          type="button"
                          title={`${labels.commitDetails}: ${commit}`}
                          aria-expanded={selected}
                          onClick={() => void selectCommit(commit)}
                          style={{
                            display: "block",
                            minWidth: "100%",
                            width: "max-content",
                            padding: "2px 5px",
                            border: 0,
                            borderRadius: 4,
                            background: selected ? "var(--bg-selected)" : "transparent",
                            color: selected ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer",
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                            lineHeight: 1.65,
                            textAlign: "left",
                            whiteSpace: "pre",
                          }}
                        >
                          {line}
                        </button>
                        {selected && (
                          <div style={{ margin: "3px 4px 6px 18px", padding: "8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
                            {commitLoading && <div style={{ color: "var(--text-dim)", fontSize: 10 }}>{labels.loadingCommit}</div>}
                            {commitError && <div style={{ color: "#ef4444", fontSize: 10 }}>{labels.commitUnavailable}</div>}
                            {commitDetails && (
                              <>
                                <div style={{ color: "var(--text)", fontSize: 11, fontWeight: 700, lineHeight: 1.45 }}>{commitDetails.subject}</div>
                                <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 9.5, lineHeight: 1.45 }}>
                                  {commitDetails.author} · {new Date(commitDetails.date).toLocaleString()}
                                </div>
                                {commitDetails.body && (
                                  <div style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 10, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{commitDetails.body}</div>
                                )}
                                <div style={{ marginTop: 8, marginBottom: 4, color: "var(--text-dim)", fontSize: 9.5, fontWeight: 700, textTransform: "uppercase" }}>
                                  {labels.changedFiles} · {commitDetails.files.length}
                                </div>
                                {commitDetails.files.map((file) => {
                                  const name = fileName(file.path);
                                  return (
                                    <button
                                      key={`${file.status}:${file.path}`}
                                      type="button"
                                      disabled={!file.exists}
                                      title={file.exists ? `${labels.openWorkingTreeFile}: ${file.path}` : file.path}
                                      onClick={() => onOpenFile(file.absolutePath, name)}
                                      style={{
                                        display: "grid",
                                        gridTemplateColumns: "16px minmax(0, 1fr) auto",
                                        alignItems: "center",
                                        gap: 5,
                                        width: "100%",
                                        minHeight: 23,
                                        padding: "2px 4px",
                                        border: 0,
                                        borderRadius: 4,
                                        background: "transparent",
                                        color: file.exists ? "var(--text-muted)" : "var(--text-dim)",
                                        cursor: file.exists ? "pointer" : "default",
                                        opacity: file.exists ? 1 : 0.65,
                                        textAlign: "left",
                                      }}
                                    >
                                      <span style={{ display: "flex" }}>{getFileIcon(name, 12)}</span>
                                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 }}>{file.path}</span>
                                      <span style={{ color: file.status.startsWith("D") ? "#ef4444" : "var(--accent)", fontSize: 9.5, fontWeight: 750 }}>{file.status}</span>
                                    </button>
                                  );
                                })}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }) : (
                    <div style={{ padding: "4px 6px", color: "var(--text-dim)", fontSize: 10 }}>{labels.noCommits}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {contextMenu && onClose && createPortal(
        <div
          role="menu"
          aria-label={labels.sourceControl}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 10030,
            width: 172,
            padding: 5,
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "color-mix(in srgb, var(--bg-panel) 97%, transparent)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
            backdropFilter: "blur(14px)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              onClose();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              height: 30,
              padding: "0 8px",
              border: 0,
              borderRadius: 5,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 11,
              textAlign: "left",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--bg-hover)";
              event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
              event.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h16M8 12h12M12 17h8" />
            </svg>
            {labels.hide}
          </button>
        </div>,
        document.body,
      )}
    </section>
  );
});
