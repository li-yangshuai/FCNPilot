"use client";

import { forwardRef, memo, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getFileIcon, FolderIcon } from "./FileIcons";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { AttachedDocument } from "@/lib/docqa";
import { textForLanguage, type UiLanguage, type UiText } from "@/lib/i18n";
import { useAppDialog } from "./AppDialogProvider";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { useI18n } from "@/hooks/useI18n";
type Translate = ReturnType<typeof useI18n>["t"];

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface FileSearchEntry {
  name: string;
  fullPath: string;
  relativePath: string;
  isDir: boolean;
  size: number;
}

interface Props {
  accountUid?: string;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onPrefetchFile?: (filePath: string) => void;
  onOpenTimeline?: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  changesCollapsed?: boolean;
  onChangesCountChange?: (count: number) => void;
  onDocQa?: (document: AttachedDocument) => void;
  onFileDeleted?: (filePath: string, isDir: boolean) => void;
  onFileMoved?: (previousPath: string, nextPath: string, isDir: boolean) => void;
  uiLanguage?: UiLanguage;
}

export interface FileExplorerHandle {
  createFile: () => void;
  createDirectory: () => void;
  collapseAll: () => void;
  toggleSearch: () => void;
  openUploadPicker: () => void;
}

const DOCQA_EXTENSIONS = new Set([
  "pdf", "docx", "txt", "md", "mdx", "rst", "csv", "tsv",
  "html", "htm", "xml", "json", "jsonl", "yaml", "yml", "toml", "log",
]);

const DIRECTORY_CACHE_TTL_MS = 2 * 60_000;
const DIRECTORY_PREFETCH_LIMIT = 8;
const directoryEntriesCache = new Map<string, { entries: FileNode[]; expiresAt: number }>();
const directoryEntryRequests = new Map<string, Promise<FileNode[]>>();
const directoryCacheGenerations = new Map<string, number>();

function directoryCacheKey(cacheScope: string | undefined, dirPath: string): string {
  return `${cacheScope ?? "anonymous"}\0${dirPath}`;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

function docQaKind(fileName: string): string | null {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  return DOCQA_EXTENSIONS.has(extension) ? extension : null;
}

async function fetchEntries(dirPath: string, cacheScope?: string, force = false): Promise<FileNode[]> {
  const cacheKey = directoryCacheKey(cacheScope, dirPath);
  if (force) {
    directoryEntriesCache.delete(cacheKey);
    directoryCacheGenerations.set(cacheKey, (directoryCacheGenerations.get(cacheKey) ?? 0) + 1);
  }
  const generation = directoryCacheGenerations.get(cacheKey) ?? 0;
  const cached = directoryEntriesCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.entries;
  const activeRequest = directoryEntryRequests.get(cacheKey);
  // A forced refresh after a create/move/delete must not reuse an older list
  // request: that response may have been captured before the mutation.
  if (!force && activeRequest) return activeRequest;

  const encoded = encodeFilePathForApi(dirPath);
  const request = (async () => {
    const res = await fetch(`/api/files/${encoded}?type=list`, { cache: "no-store" });
    if (!res.ok) {
      let message = `Failed to load files (HTTP ${res.status})`;
      try {
        const data = await res.json() as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new Error(message);
    }
    const data = await res.json() as { entries?: FileEntry[] };
    const entries = (data.entries ?? []).map((entry) => ({
      name: entry.name,
      fullPath: joinFilePath(dirPath, entry.name),
      isDir: entry.isDir,
      size: entry.size,
      children: entry.isDir ? [] : undefined,
      loaded: !entry.isDir,
    }));
    if ((directoryCacheGenerations.get(cacheKey) ?? 0) === generation) {
      directoryEntriesCache.set(cacheKey, {
        entries,
        expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
      });
    }
    if (directoryEntriesCache.size > 256) {
      const oldestKey = directoryEntriesCache.keys().next().value;
      if (oldestKey !== undefined) directoryEntriesCache.delete(oldestKey);
    }
    return entries;
  })();
  directoryEntryRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (directoryEntryRequests.get(cacheKey) === request) {
      directoryEntryRequests.delete(cacheKey);
    }
  }
}

function prefetchChildDirectories(entries: FileNode[], cacheScope?: string): void {
  if (typeof window === "undefined") return;
  const directories = entries.filter((entry) => entry.isDir).slice(0, DIRECTORY_PREFETCH_LIMIT);
  if (directories.length === 0) return;
  const prefetch = () => {
    let index = 0;
    const worker = async () => {
      while (index < directories.length) {
        const directory = directories[index++];
        await fetchEntries(directory.fullPath, cacheScope).catch(() => []);
      }
    };
    void Promise.all([worker(), worker()]);
  };
  const idleWindow = window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(prefetch, { timeout: 500 });
  } else {
    window.setTimeout(prefetch, 160);
  }
}

async function createFileEntry(parentPath: string, kind: "file" | "directory", name: string): Promise<{ path: string; name: string; isDir: boolean }> {
  const encoded = encodeFilePathForApi(parentPath);
  const res = await fetch(`/api/files/${encoded}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, name }),
  });
  const data = await res.json().catch(() => ({})) as { path?: string; name?: string; isDir?: boolean; error?: string };
  if (!res.ok || !data.path || typeof data.isDir !== "boolean") {
    throw new Error(data.error ?? `Failed to create ${kind} (HTTP ${res.status})`);
  }
  return { path: data.path, name: data.name ?? name.replace(/\\/g, "/").split("/").pop() ?? name, isDir: data.isDir };
}

async function deleteFileEntry(filePath: string, isDir: boolean): Promise<void> {
  const encoded = encodeFilePathForApi(filePath);
  const res = await fetch(`/api/files/${encoded}${isDir ? "?recursive=true" : ""}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Failed to delete (HTTP ${res.status})`);
  }
}

interface MoveResult {
  path: string;
  previousPath: string;
  isDir: boolean;
  unchanged?: boolean;
}

class MoveConflictError extends Error {
  canOverwrite: boolean;

  constructor(message: string, canOverwrite: boolean) {
    super(message);
    this.name = "MoveConflictError";
    this.canOverwrite = canOverwrite;
  }
}

async function moveFileEntry(filePath: string, destinationDirectory: string, overwrite = false, newName?: string): Promise<MoveResult> {
  const encoded = encodeFilePathForApi(filePath);
  const res = await fetch(`/api/files/${encoded}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinationDirectory, overwrite, ...(newName ? { newName } : {}) }),
  });
  const data = await res.json().catch(() => ({})) as MoveResult & {
    error?: string;
    conflict?: boolean;
    canOverwrite?: boolean;
  };
  if (res.status === 409 && data.conflict) {
    throw new MoveConflictError(data.error ?? "An item with the same name already exists", data.canOverwrite === true);
  }
  if (!res.ok || !data.path || !data.previousPath || typeof data.isDir !== "boolean") {
    throw new Error(data.error ?? `Failed to move (HTTP ${res.status})`);
  }
  return data;
}

function normalizedTreePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function parentTreePath(value: string): string {
  const normalized = normalizedTreePath(value);
  return normalized.slice(0, normalized.lastIndexOf("/")) || "/";
}

function canDropNodeInDirectory(source: FileNode | null, destinationDirectory: string): boolean {
  if (!source) return false;
  const sourcePath = normalizedTreePath(source.fullPath);
  const destinationPath = normalizedTreePath(destinationDirectory);
  const sourceParent = parentTreePath(sourcePath);
  if (sourceParent === destinationPath || sourcePath === destinationPath) return false;
  return !(source.isDir && destinationPath.startsWith(`${sourcePath}/`));
}

function topLevelSelectedNodes(nodes: FileNode[]): FileNode[] {
  const unique = [...new Map(nodes.map((node) => [normalizedTreePath(node.fullPath), node])).values()];
  return unique.filter((node) => {
    const nodePath = normalizedTreePath(node.fullPath);
    return !unique.some((candidate) => {
      const candidatePath = normalizedTreePath(candidate.fullPath);
      return candidatePath !== nodePath && nodePath.startsWith(`${candidatePath}/`);
    });
  });
}

function canDropNodesInDirectory(nodes: FileNode[], destinationDirectory: string): boolean {
  const sources = topLevelSelectedNodes(nodes);
  return sources.length > 0 && sources.every((node) => canDropNodeInDirectory(node, destinationDirectory));
}

function ContextMenuItem({
  label,
  icon,
  danger,
  href,
  download,
  onSelect,
}: {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  href?: string;
  download?: boolean;
  onSelect: () => void;
}) {
  const style = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    height: 31,
    padding: "0 10px",
    background: "transparent",
    border: 0,
    borderRadius: 5,
    color: danger ? "#ef4444" : "var(--text)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
    lineHeight: 1,
    textAlign: "left" as const,
    textDecoration: "none",
  };
  const content = (
    <>
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 15,
          height: 15,
          flexShrink: 0,
          color: danger ? "#ef4444" : "var(--text-muted)",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {icon}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        download={download}
        role="menuitem"
        className="file-tree-context-item"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        style={style}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      className="file-tree-context-item"
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      style={style}
    >
      {content}
    </button>
  );
}

function MenuSeparator() {
  return <div role="separator" style={{ height: 1, margin: "4px 6px", background: "var(--border)" }} />;
}

function MoreButton({
  title,
  onOpen,
}: {
  title: string;
  onOpen: (x: number, y: number) => void;
}) {
  return (
    <button
      type="button"
      draggable={false}
      aria-label={title}
      title={title}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpen(rect.right - 208, rect.bottom + 3);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        flex: "0 0 20px",
        height: 20,
        width: 20,
        minWidth: 20,
        maxWidth: 20,
        padding: 0,
        overflow: "hidden",
        background: "color-mix(in srgb, var(--bg-panel) 88%, transparent)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-muted)",
        cursor: "pointer",
        lineHeight: 0,
      }}
    >
      <svg
        aria-hidden="true"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="currentColor"
        focusable="false"
      >
        <circle cx="2" cy="6" r="1.05" />
        <circle cx="6" cy="6" r="1.05" />
        <circle cx="10" cy="6" r="1.05" />
      </svg>
    </button>
  );
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </button>
  );
}

const uploadActionStyle = {
  minHeight: 22,
  padding: "0 7px",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 10,
} as const;

function TreeNode({
  node,
  depth,
  cacheScope,
  cwd,
  onOpenFile,
  onPrefetchFile,
  onOpenTimeline,
  onAtMention,
  onDocQa,
  onCreateEntry,
  onDeleteEntries,
  onRenameEntry,
  onMoveEntries,
  selectedNodes,
  onSelectNode,
  draggedNodes,
  onDragStarted,
  onDragFinished,
  mutationBusy,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  text,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  t,
}: {
  node: FileNode;
  depth: number;
  cacheScope?: string;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onPrefetchFile?: (filePath: string) => void;
  onOpenTimeline?: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onDocQa?: (document: AttachedDocument) => void;
  onCreateEntry: (parentPath: string, kind: "file" | "directory") => void;
  onDeleteEntries: (nodes: FileNode[]) => void;
  onRenameEntry: (node: FileNode) => void;
  onMoveEntries: (nodes: FileNode[], destinationDirectory: string) => void;
  selectedNodes: Map<string, FileNode>;
  onSelectNode: (node: FileNode, additive: boolean) => void;
  draggedNodes: FileNode[];
  onDragStarted: (node: FileNode) => void;
  onDragFinished: () => void;
  mutationBusy: boolean;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
  text: UiText["files"];
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  t: Translate;
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [dropHovered, setDropHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const expandTimerRef = useRef<number | null>(null);
  const filePrefetchTimerRef = useRef<number | null>(null);
  const documentKind = node.isDir ? null : docQaKind(node.name);
  const selected = selectedNodes.has(node.fullPath);
  const selectedBatch = selected ? [...selectedNodes.values()] : [node];

  const openContextMenu = useCallback((x: number, y: number) => {
    const menuWidth = 208;
    const estimatedHeight = node.isDir ? 237 : documentKind ? 237 : 201;
    setContextMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 8)),
    });
  }, [documentKind, node.isDir]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current !== null) window.clearTimeout(expandTimerRef.current);
    expandTimerRef.current = null;
  }, []);

  const clearFilePrefetchTimer = useCallback(() => {
    if (filePrefetchTimerRef.current !== null) window.clearTimeout(filePrefetchTimerRef.current);
    filePrefetchTimerRef.current = null;
  }, []);

  useEffect(() => () => {
    clearExpandTimer();
    clearFilePrefetchTimer();
  }, [clearExpandTimer, clearFilePrefetchTimer]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => closeContextMenu();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeContextMenu, contextMenu]);

  const loadChildren = useCallback(async (force = false) => {
    if ((loaded || loading) && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath, cacheScope, force);
      setChildren(entries);
      setLoaded(true);
      prefetchChildDirectories(entries, cacheScope);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [cacheScope, loaded, loading, node.fullPath]);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    const cacheKey = directoryCacheKey(cacheScope, node.fullPath);
    directoryEntriesCache.delete(cacheKey);
    directoryCacheGenerations.set(cacheKey, (directoryCacheGenerations.get(cacheKey) ?? 0) + 1);
    if (open && loaded) {
      loadChildren(true);
    } else if (loaded) {
      // Mark a collapsed directory stale. It will fetch a fresh listing the
      // next time it is expanded instead of showing its old cached children.
      setLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onPrefetchFile?.(node.fullPath);
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onPrefetchFile, onToggleExpanded]);

  return (
    <div>
      <div
        className="file-tree-row"
        onClick={(event) => {
          const additive = event.ctrlKey || event.metaKey;
          onSelectNode(node, additive);
          if (!additive) handleClick();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!selected) onSelectNode(node, false);
          openContextMenu(event.clientX, event.clientY);
        }}
        draggable={!mutationBusy}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-pi-web-file", node.fullPath);
          event.dataTransfer.setData("text/plain", node.fullPath);
          onDragStarted(node);
        }}
        onDragEnd={() => {
          clearExpandTimer();
          setDropHovered(false);
          onDragFinished();
        }}
        onDragEnter={(event) => {
          if (!node.isDir || !canDropNodesInDirectory(draggedNodes, node.fullPath)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropHovered(true);
          if (!open && expandTimerRef.current === null) {
            expandTimerRef.current = window.setTimeout(() => {
              onToggleExpanded(node.fullPath, true);
              if (!loaded) void loadChildren();
              expandTimerRef.current = null;
            }, 650);
          }
        }}
        onDragOver={(event) => {
          if (!node.isDir || !canDropNodesInDirectory(draggedNodes, node.fullPath)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          setDropHovered(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          clearExpandTimer();
          setDropHovered(false);
        }}
        onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
          if (!node.isDir || !canDropNodesInDirectory(draggedNodes, node.fullPath)) return;
          event.preventDefault();
          event.stopPropagation();
          clearExpandTimer();
          setDropHovered(false);
          onMoveEntries(draggedNodes, node.fullPath);
          onDragFinished();
        }}
        onMouseEnter={() => {
          setHovered(true);
          if (node.isDir && !loaded && !loading) void loadChildren();
          else if (!node.isDir && onPrefetchFile) {
            clearFilePrefetchTimer();
            filePrefetchTimerRef.current = window.setTimeout(() => {
              onPrefetchFile(node.fullPath);
              filePrefetchTimerRef.current = null;
            }, 70);
          }
        }}
        onMouseLeave={() => {
          setHovered(false);
          clearFilePrefetchTimer();
        }}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          boxSizing: "border-box",
          height: 24,
          minWidth: 0,
          overflow: "hidden",
          cursor: "pointer",
          background: dropHovered
            ? "color-mix(in srgb, var(--accent) 18%, var(--bg-panel))"
            : selected
              ? "color-mix(in srgb, var(--accent) 15%, var(--bg-panel))"
              : hovered
                ? "var(--bg-hover)"
                : "transparent",
          outline: dropHovered || selected ? "1px solid color-mix(in srgb, var(--accent) 55%, transparent)" : "1px solid transparent",
          borderRadius: 4,
          userSelect: "none",
          opacity: draggedNodes.some((draggedNode) => draggedNode.fullPath === node.fullPath) ? 0.48 : 1,
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {hovered && <MoreButton title={text.moreActions} onOpen={openContextMenu} />}
      </div>
      {contextMenu && createPortal(
        <div
          role="menu"
          aria-label={`${text.moreActions}: ${node.name}`}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 10020,
            width: 208,
            padding: 5,
            background: "color-mix(in srgb, var(--bg-panel) 96%, transparent)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 14px 38px rgba(0,0,0,0.22), 0 3px 10px rgba(0,0,0,0.12)",
            backdropFilter: "blur(16px)",
          }}
        >
          <div
            title={node.fullPath}
            style={{
              padding: "5px 9px 7px",
              color: "var(--text-dim)",
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.name}
          </div>
          {node.isDir && (
            <>
              <ContextMenuItem
                label={text.newFileInFolder}
                icon={<span style={{ fontSize: 15, fontWeight: 400 }}>＋</span>}
                onSelect={() => {
                  closeContextMenu();
                  onCreateEntry(node.fullPath, "file");
                }}
              />
              <ContextMenuItem
                label={text.newFolderInFolder}
                icon={<FolderIcon size={14} />}
                onSelect={() => {
                  closeContextMenu();
                  onCreateEntry(node.fullPath, "directory");
                }}
              />
            </>
          )}
          {onAtMention && (
            <ContextMenuItem
              label={text.insertPath}
              icon="@"
              onSelect={() => {
                closeContextMenu();
                onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
              }}
            />
          )}
          {onOpenTimeline && (
            <ContextMenuItem
              label={text.openTimeline}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /><path d="M4 4v5h5" />
                </svg>
              }
              onSelect={() => {
                closeContextMenu();
                onOpenTimeline(node.fullPath, node.name);
              }}
            />
          )}
          {onDocQa && documentKind && (
            <ContextMenuItem
              label={text.attachDocQa}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16v13H7l-3 3Z" /><path d="M9 9h6M9 13h4" />
                </svg>
              }
              onSelect={() => {
                closeContextMenu();
                onDocQa({ path: node.fullPath, name: node.name, kind: documentKind, size: node.size });
              }}
            />
          )}
          {!node.isDir && (
            <ContextMenuItem
              label={text.download}
              href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
              download
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              }
              onSelect={closeContextMenu}
            />
          )}
          <MenuSeparator />
          {selectedBatch.length === 1 && (
            <ContextMenuItem
              label={node.isDir ? text.renameFolder : text.renameFile}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              }
              onSelect={() => {
                closeContextMenu();
                onRenameEntry(node);
              }}
            />
          )}
          <ContextMenuItem
            label={selectedBatch.length > 1
              ? `${text.deleteSelected} (${selectedBatch.length})`
              : node.isDir ? text.deleteFolder : text.deleteFile}
            danger
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6" />
              </svg>
            }
            onSelect={() => {
              closeContextMenu();
              onDeleteEntries(selectedBatch);
            }}
          />
        </div>,
        document.body,
      )}
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cacheScope={cacheScope}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onPrefetchFile={onPrefetchFile}
              onOpenTimeline={onOpenTimeline}
              onAtMention={onAtMention}
              onDocQa={onDocQa}
              onCreateEntry={onCreateEntry}
              onDeleteEntries={onDeleteEntries}
              onRenameEntry={onRenameEntry}
              onMoveEntries={onMoveEntries}
              selectedNodes={selectedNodes}
              onSelectNode={onSelectNode}
              draggedNodes={draggedNodes}
              onDragStarted={onDragStarted}
              onDragFinished={onDragFinished}
              mutationBusy={mutationBusy}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              text={text}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              {text.empty}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        height: 24,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {rel}
      </span>
    </div>
  );
}

export const FileExplorer = memo(forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  accountUid,
  cwd,
  onOpenFile,
  onPrefetchFile,
  onOpenTimeline,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  changesCollapsed = true,
  onChangesCountChange,
  onDocQa,
  onFileDeleted,
  onFileMoved,
  uiLanguage = "en",
}, ref) {
  const { t } = useI18n();
  const uiText = textForLanguage(uiLanguage);
  const text = uiText.files;
  const dialog = useAppDialog();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [mutationKey, setMutationKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selectedNodes, setSelectedNodes] = useState<Map<string, FileNode>>(new Map());
  const [draggedNodes, setDraggedNodes] = useState<FileNode[]>([]);
  const [rootDropHovered, setRootDropHovered] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileSearchEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const prevCwdRef = useRef<string | null>(null);
  const searchRequestRef = useRef<AbortController | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const directoryWatchRef = useRef<EventSource | null>(null);
  const directoryRefreshTimerRef = useRef<number | null>(null);
  const [uploadRefreshKey, setUploadRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${mutationKey}:${uploadRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";

  const handleSelectNode = useCallback((node: FileNode, additive: boolean) => {
    setSelectedNodes((current) => {
      if (!additive) return new Map([[node.fullPath, node]]);
      const next = new Map(current);
      if (next.has(node.fullPath)) next.delete(node.fullPath);
      else next.set(node.fullPath, node);
      return next;
    });
  }, []);

  const handleDragStarted = useCallback((node: FileNode) => {
    if (selectedNodes.has(node.fullPath)) {
      setDraggedNodes(topLevelSelectedNodes([...selectedNodes.values()]));
      return;
    }
    setSelectedNodes(new Map([[node.fullPath, node]]));
    setDraggedNodes([node]);
  }, [selectedNodes]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const handleCreateEntry = useCallback(async (parentPath: string, kind: "file" | "directory") => {
    const label = kind === "directory" ? text.newFolder : text.newFile;
    const name = await dialog.prompt({ title: label, message: text.newName, placeholder: text.newName, confirmLabel: label });
    const trimmed = name?.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const created = await createFileEntry(parentPath, kind, trimmed);
      const cacheKey = directoryCacheKey(accountUid, parentPath);
      directoryEntriesCache.delete(cacheKey);
      directoryCacheGenerations.set(cacheKey, (directoryCacheGenerations.get(cacheKey) ?? 0) + 1);
      setExpandedPaths((prev) => new Set(prev).add(parentPath));
      setMutationKey((key) => key + 1);
      if (!created.isDir) onOpenFile(created.path, created.name);
    } catch (error) {
      await dialog.alert({ title: uiText.common.operationFailed, message: error instanceof Error ? error.message : String(error), danger: true });
    } finally {
      setBusy(false);
    }
  }, [accountUid, dialog, onOpenFile, text.newFile, text.newFolder, text.newName, uiText.common.operationFailed]);

  const handleDeleteEntries = useCallback(async (nodes: FileNode[]) => {
    const targets = topLevelSelectedNodes(nodes);
    if (targets.length === 0) return;
    const single = targets.length === 1 ? targets[0] : null;
    const title = single
      ? single.isDir ? text.deleteFolderConfirm : text.deleteFileConfirm
      : `${text.deleteSelected} (${targets.length})`;
    const message = single
      ? `${single.isDir ? text.deleteFolderConfirm : text.deleteFileConfirm} "${single.name}"?`
      : `${text.deleteSelected} (${targets.length})?`;
    if (!await dialog.confirm({ title, message, confirmLabel: uiText.common.delete, danger: true })) return;
    setBusy(true);
    const deleted: FileNode[] = [];
    try {
      for (const node of targets) {
        await deleteFileEntry(node.fullPath, node.isDir);
        deleted.push(node);
      }
    } catch (error) {
      await dialog.alert({ title: uiText.common.operationFailed, message: error instanceof Error ? error.message : String(error), danger: true });
    } finally {
      if (deleted.length > 0) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          for (const node of deleted) {
            for (const expandedPath of next) {
              if (expandedPath === node.fullPath || expandedPath.startsWith(`${node.fullPath}/`)) next.delete(expandedPath);
            }
          }
          return next;
        });
        setMutationKey((key) => key + 1);
        deleted.forEach((node) => onFileDeleted?.(node.fullPath, node.isDir));
      }
      setSelectedNodes(new Map());
      setBusy(false);
    }
  }, [dialog, onFileDeleted, text.deleteFileConfirm, text.deleteFolderConfirm, text.deleteSelected, uiText.common.delete, uiText.common.operationFailed]);

  const handleMoveEntry = useCallback(async (node: FileNode, destinationDirectory: string, newName?: string) => {
    if (busy || (!newName && !canDropNodeInDirectory(node, destinationDirectory))) return;
    setBusy(true);
    setRootDropHovered(false);
    try {
      let moved: MoveResult;
      try {
        moved = await moveFileEntry(node.fullPath, destinationDirectory, false, newName);
      } catch (error) {
        if (!(error instanceof MoveConflictError) || !error.canOverwrite) throw error;
        const replace = await dialog.confirm({
          title: text.moveConflict,
          message: `${text.moveConflictMessage}\n\n${node.name}`,
          confirmLabel: uiText.common.confirm,
          cancelLabel: uiText.common.cancel,
          danger: true,
        });
        if (!replace) return;
        moved = await moveFileEntry(node.fullPath, destinationDirectory, true, newName);
      }
      if (moved.unchanged) return;
      setExpandedPaths((previous) => {
        const next = new Set<string>();
        const oldPrefix = normalizedTreePath(moved.previousPath);
        const newPrefix = normalizedTreePath(moved.path);
        for (const expandedPath of previous) {
          const normalized = normalizedTreePath(expandedPath);
          if (normalized === oldPrefix || normalized.startsWith(`${oldPrefix}/`)) {
            next.add(`${newPrefix}${normalized.slice(oldPrefix.length)}`);
          } else {
            next.add(expandedPath);
          }
        }
        next.add(destinationDirectory);
        return next;
      });
      setMutationKey((key) => key + 1);
      onFileMoved?.(moved.previousPath, moved.path, moved.isDir);
    } catch (error) {
      await dialog.alert({
        title: text.moveFailed,
        message: error instanceof Error ? error.message : String(error),
        danger: true,
      });
    } finally {
      setBusy(false);
      setDraggedNodes([]);
    }
  }, [busy, dialog, onFileMoved, text.moveConflict, text.moveConflictMessage, text.moveFailed, uiText.common.cancel, uiText.common.confirm]);

  const handleMoveEntries = useCallback(async (nodes: FileNode[], destinationDirectory: string) => {
    const targets = topLevelSelectedNodes(nodes);
    if (targets.length === 0 || busy || !canDropNodesInDirectory(targets, destinationDirectory)) return;
    if (targets.length === 1) {
      await handleMoveEntry(targets[0], destinationDirectory);
      setSelectedNodes(new Map());
      return;
    }

    setBusy(true);
    setRootDropHovered(false);
    const movedEntries: MoveResult[] = [];
    try {
      for (const node of targets) {
        try {
          let moved: MoveResult;
          try {
            moved = await moveFileEntry(node.fullPath, destinationDirectory);
          } catch (error) {
            if (!(error instanceof MoveConflictError) || !error.canOverwrite) throw error;
            const replace = await dialog.confirm({
              title: text.moveConflict,
              message: `${text.moveConflictMessage}\n\n${node.name}`,
              confirmLabel: uiText.common.confirm,
              cancelLabel: uiText.common.cancel,
              danger: true,
            });
            if (!replace) continue;
            moved = await moveFileEntry(node.fullPath, destinationDirectory, true);
          }
          if (!moved.unchanged) movedEntries.push(moved);
        } catch (error) {
          await dialog.alert({
            title: text.moveFailed,
            message: `${node.name}: ${error instanceof Error ? error.message : String(error)}`,
            danger: true,
          });
        }
      }
      if (movedEntries.length > 0) {
        setExpandedPaths((previous) => {
          const next = new Set(previous);
          for (const moved of movedEntries) {
            const oldPrefix = normalizedTreePath(moved.previousPath);
            const newPrefix = normalizedTreePath(moved.path);
            for (const expandedPath of [...next]) {
              const normalized = normalizedTreePath(expandedPath);
              if (normalized === oldPrefix || normalized.startsWith(`${oldPrefix}/`)) {
                next.delete(expandedPath);
                next.add(`${newPrefix}${normalized.slice(oldPrefix.length)}`);
              }
            }
          }
          next.add(destinationDirectory);
          return next;
        });
        setMutationKey((key) => key + 1);
        movedEntries.forEach((moved) => onFileMoved?.(moved.previousPath, moved.path, moved.isDir));
      }
    } finally {
      setBusy(false);
      setDraggedNodes([]);
      setSelectedNodes(new Map());
    }
  }, [busy, dialog, handleMoveEntry, onFileMoved, text.moveConflict, text.moveConflictMessage, text.moveFailed, uiText.common.cancel, uiText.common.confirm]);

  const handleRenameEntry = useCallback(async (node: FileNode) => {
    if (busy) return;
    const title = node.isDir ? text.renameFolder : text.renameFile;
    const nextName = await dialog.prompt({
      title,
      message: text.renameName,
      placeholder: text.renameName,
      defaultValue: node.name,
      confirmLabel: title,
    });
    const trimmed = nextName?.trim();
    if (!trimmed || trimmed === node.name) return;
    await handleMoveEntry(node, parentTreePath(node.fullPath), trimmed);
  }, [busy, dialog, handleMoveEntry, text.renameFile, text.renameFolder, text.renameName]);

  useImperativeHandle(ref, () => ({
    createFile: () => { void handleCreateEntry(cwd, "file"); },
    createDirectory: () => { void handleCreateEntry(cwd, "directory"); },
    collapseAll: () => setExpandedPaths(new Set()),
    toggleSearch: () => {
      setSearchOpen((open) => {
        if (open) setSearchQuery("");
        return !open;
      });
    },
    openUploadPicker: () => {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [cwd, handleCreateEntry, uploadBusy]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
      setUploadRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(cwd, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setSelectedNodes(new Map());
      setDraggedNodes([]);
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd, accountUid, !cwdChanged)
      .then((entries) => {
        if (cancelled) return;
        setRoots(entries);
        prefetchChildDirectories(entries, accountUid);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountUid, cwd, refreshKey, mutationKey, uploadRefreshKey]);

  useEffect(() => {
    directoryWatchRef.current?.close();
    if (directoryRefreshTimerRef.current !== null) {
      window.clearTimeout(directoryRefreshTimerRef.current);
      directoryRefreshTimerRef.current = null;
    }

    const encoded = encodeFilePathForApi(cwd);
    const events = new EventSource(`/api/files/${encoded}?type=watch`);
    directoryWatchRef.current = events;
    const scheduleRefresh = () => {
      if (directoryRefreshTimerRef.current !== null) window.clearTimeout(directoryRefreshTimerRef.current);
      directoryRefreshTimerRef.current = window.setTimeout(() => {
        directoryRefreshTimerRef.current = null;
        setMutationKey((key) => key + 1);
      }, 140);
    };
    events.addEventListener("change", scheduleRefresh);

    return () => {
      events.close();
      if (directoryWatchRef.current === events) directoryWatchRef.current = null;
      if (directoryRefreshTimerRef.current !== null) {
        window.clearTimeout(directoryRefreshTimerRef.current);
        directoryRefreshTimerRef.current = null;
      }
    };
  }, [accountUid, cwd]);

  useEffect(() => {
    searchRequestRef.current?.abort();
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    searchRequestRef.current = controller;
    const timer = window.setTimeout(() => {
      setSearching(true);
      const encoded = encodeFilePathForApi(cwd);
      void fetch(`/api/files/${encoded}?type=search&q=${encodeURIComponent(query)}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json() as { entries?: FileSearchEntry[]; error?: string };
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
          setSearchResults(data.entries ?? []);
        })
        .catch((searchError) => {
          if ((searchError as Error).name !== "AbortError") setSearchResults([]);
        })
        .finally(() => {
          if (searchRequestRef.current === controller) {
            searchRequestRef.current = null;
            setSearching(false);
          }
        });
    }, 140);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cwd, searchQuery, refreshKey, mutationKey, uploadRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, mutationKey, uploadRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div
      onDragOver={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!canDropNodesInDirectory(draggedNodes, cwd)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setRootDropHovered(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setRootDropHovered(false);
      }}
      onDrop={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!canDropNodesInDirectory(draggedNodes, cwd)) return;
        event.preventDefault();
        setRootDropHovered(false);
        void handleMoveEntries(draggedNodes, cwd);
      }}
      style={{
        minHeight: "100%",
        padding: "2px 4px",
        borderRadius: 5,
        background: rootDropHovered ? "color-mix(in srgb, var(--accent) 7%, transparent)" : "transparent",
        boxShadow: rootDropHovered ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent)" : "none",
      }}
    >
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ margin: "2px 3px 6px", padding: 7, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", fontSize: 11 }}>
          {uploadBusy && (
            <div role="status" aria-live="polite" style={{ color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}
              {uploadPhase === "uploading" && (
                <div style={{ height: 3, marginTop: 5, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                  <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--accent)", transition: "width 120ms ease" }} />
                </div>
              )}
            </div>
          )}
          {pendingConflict && (
            <div role="alert">
              <div style={{ color: "#f59e0b", overflowWrap: "anywhere" }}>
                {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
              </div>
              {pendingConflict.nonReplaceable.length > 0 && (
                <div style={{ marginTop: 3, color: "#f59e0b", overflowWrap: "anywhere" }}>
                  {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
                </div>
              )}
              <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
                <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={uploadActionStyle}>{t("files.replace")}</button>
                <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={uploadActionStyle}>{t("files.skipExisting")}</button>
                <button type="button" onClick={() => setPendingConflict(null)} style={uploadActionStyle}>{t("files.cancel")}</button>
              </div>
            </div>
          )}
          {uploadError && (
            <div role="alert" style={{ display: "flex", alignItems: "center", gap: 6, color: "#f87171" }}>
              <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
              <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
            </div>
          )}
          {uploadSummary && (
            <div aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ minWidth: 0, flex: 1, color: "var(--text-muted)" }}>
                <span style={{ color: "#22c55e" }}>✓ {uploadSummary.uploaded.length}</span>
                {uploadSummary.skipped.length > 0 && <span> · {uploadSummary.skipped.length} {t("files.skipExisting")}</span>}
                {uploadSummary.errors.length > 0 && <span style={{ color: "#f87171" }}> · {uploadSummary.errors.length} failed</span>}
              </span>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button type="button" onClick={addUploadedFilesToChat} title={t("files.addAllUploadedFiles")} style={uploadActionStyle}>
                  <MentionIcon /> {t("files.mention")}
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
          )}
        </div>
      )}
      {!changesCollapsed && gitFiles.length > 0 && (
        <div style={{ margin: "0 0 5px", padding: "0 0 4px", borderBottom: "1px solid var(--border)" }}>
          <div aria-label={t("files.changeStats", { count: gitFiles.length, additions: gitLineStats.additions, deletions: gitLineStats.deletions })} style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", color: "var(--text-dim)", fontSize: 12 }}>
            <span>{t("files.changedCount", { count: gitFiles.length })}</span>
            <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{gitLineStats.additions}</span>
            <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{gitLineStats.deletions}</span>
          </div>
          {gitFiles.map((status) => <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />)}
        </div>
      )}
      {loading && <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>{text.loading}</div>}
      {error && <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>}
      {!loading && !error && <>
      {searchOpen && <div style={{ position: "sticky", top: 0, zIndex: 4, padding: "3px 3px 5px", background: "var(--bg-panel)" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            aria-hidden="true"
            style={{ position: "absolute", left: 8, color: "var(--text-dim)", pointerEvents: "none" }}
          >
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setSearchQuery("");
              setSearchOpen(false);
            }}
            placeholder={text.searchFiles}
            aria-label={text.searchFiles}
            spellCheck={false}
            style={{
              width: "100%",
              height: 28,
              padding: "0 28px 0 27px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              outline: "none",
              background: "color-mix(in srgb, var(--bg) 86%, var(--bg-panel))",
              color: "var(--text)",
              fontFamily: "inherit",
              fontSize: 11,
            }}
          />
          {searching && (
            <span aria-hidden="true" style={{ position: "absolute", right: 8, width: 10, height: 10, border: "1.5px solid var(--text-dim)", borderTopColor: "transparent", borderRadius: "50%", animation: "git-status-refresh-spin 0.7s linear infinite" }} />
          )}
          {!searching && searchQuery && (
            <button
              type="button"
              title={uiText.common.close}
              aria-label={uiText.common.close}
              onClick={() => {
                setSearchQuery("");
                setSearchOpen(false);
              }}
              style={{ position: "absolute", right: 4, width: 22, height: 22, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 15 }}
            >
              ×
            </button>
          )}
        </div>
      </div>}
      {busy && <div style={{ padding: "3px 8px", color: "var(--text-dim)", fontSize: 11 }}>{text.working}</div>}
      {searchQuery.trim() ? (
        <>
          {searchResults.map((entry) => (
            <button
              type="button"
              key={entry.fullPath}
              title={entry.relativePath}
              onClick={() => {
                if (!entry.isDir) {
                  onPrefetchFile?.(entry.fullPath);
                  onOpenFile(entry.fullPath, entry.name);
                  return;
                }
                const expanded = new Set(expandedPaths);
                let current = normalizedTreePath(entry.fullPath);
                const root = normalizedTreePath(cwd);
                while (current.startsWith(root) && current !== root) {
                  expanded.add(current);
                  current = parentTreePath(current);
                }
                setExpandedPaths(expanded);
                setSearchQuery("");
                setSearchOpen(false);
              }}
              style={{
                display: "grid",
                gridTemplateColumns: "16px minmax(0, 1fr)",
                alignItems: "center",
                gap: 6,
                width: "100%",
                minHeight: 27,
                padding: "3px 7px",
                border: 0,
                borderRadius: 4,
                background: "transparent",
                color: "var(--text)",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ display: "flex" }}>{entry.isDir ? <FolderIcon size={14} /> : getFileIcon(entry.name, 14)}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5 }}>{entry.name}</span>
                <span style={{ display: "block", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 9.5 }}>{entry.relativePath}</span>
              </span>
            </button>
          ))}
          {!searching && searchResults.length === 0 && (
            <div style={{ padding: "10px 9px", color: "var(--text-dim)", fontSize: 11 }}>{text.noSearchResults}</div>
          )}
        </>
      ) : roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          cacheScope={accountUid}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onPrefetchFile={onPrefetchFile}
          onOpenTimeline={onOpenTimeline}
          onAtMention={onAtMention}
          onDocQa={onDocQa}
          onCreateEntry={handleCreateEntry}
          onDeleteEntries={(nodes) => { void handleDeleteEntries(nodes); }}
          onRenameEntry={(node) => { void handleRenameEntry(node); }}
          onMoveEntries={(nodes, destinationDirectory) => { void handleMoveEntries(nodes, destinationDirectory); }}
          selectedNodes={selectedNodes}
          onSelectNode={handleSelectNode}
          draggedNodes={draggedNodes}
          onDragStarted={handleDragStarted}
          onDragFinished={() => {
            setDraggedNodes([]);
            setRootDropHovered(false);
          }}
          mutationBusy={busy}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshToken={refreshToken}
          text={text}
          highlightedPaths={highlightedPaths}
          gitStatusByPath={gitStatusByPath}
          changedDirectoryPaths={changedDirectoryPaths}
          t={t}
        />
      ))}
      {!searchQuery.trim() && roots.length === 0 && (
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          {text.noFiles}
        </div>
      )}
      </>}
    </div>
  );
}));
