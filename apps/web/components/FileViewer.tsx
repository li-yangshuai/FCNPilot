"use client";

import { memo, useEffect, useState, useRef, useCallback, useMemo, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import dynamic from "next/dynamic";
import { useTheme } from "@/hooks/useTheme";
import { encodeFilePathForApi, getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { resolveLocalFileHref } from "@/lib/file-links";
import { parseFrontmatter } from "@/lib/frontmatter";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { documentPageNumberFromLocation, type AttachedDocument } from "@/lib/docqa";
import { PdfCanvasViewer } from "./PdfCanvasViewer";
import type { TerminalOpenRequest } from "./IntegratedTerminal";
import { AiCodeSettingsDialog } from "./AiCodeSettingsDialog";
import { FrontmatterCard } from "./FrontmatterCard";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import type { UiLanguage } from "@/lib/i18n";
import { DEFAULT_AI_CODE_SETTINGS, normalizeAiCodeSettings, type AiCodeSettings } from "@/lib/ai-code-settings";
import {
  resolveInitialFileDisplayMode,
  type FileViewerDisplayMode,
  type FileViewerState,
} from "@/lib/file-viewer-state";

export type { FileViewerState } from "@/lib/file-viewer-state";

interface Props {
  filePath: string;
  accountUid?: string;
  cwd?: string;
  location?: string;
  focusToken?: number;
  onDirtyChange?: (filePath: string, dirty: boolean) => void;
  onDocQa?: (document: AttachedDocument) => void;
  pdfFocusMode?: boolean;
  onPdfFocusModeChange?: (focused: boolean) => void;
  uiLanguage?: UiLanguage;
  active?: boolean;
  terminalOpen?: boolean;
  onTerminalRequest?: (request?: TerminalOpenRequest) => void;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string) => void;
  onMentionLines?: (relativePath: string, startLine: number, endLine: number) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  gitRefreshKey?: number;
  initialDisplayMode?: FileViewerDisplayMode;
  initialState?: FileViewerState;
  onStateChange?: (state: FileViewerState) => void;
  watchEnabled?: boolean;
}

const MonacoCodeEditor = dynamic(
  () => import("./MonacoCodeEditor").then((module) => module.MonacoCodeEditor),
  { ssr: false },
);

export function preloadCodeEditor(): void {
  (MonacoCodeEditor as unknown as { preload?: () => void }).preload?.();
}

interface FileData {
  content: string;
  language: string;
  size: number;
  mtimeMs: number;
}

const fileDataCache = new Map<string, FileData>();
const fileDataRequests = new Map<string, Promise<FileData>>();
const aiCodeSettingsCache = new Map<string, AiCodeSettings>();
const AI_CODE_SETTINGS_EVENT = "amedac-ai-code-settings-change";

interface OriginData {
  content: string;
  source: "git" | "untracked" | "snapshot";
  label: string;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm"]);
const DOCUMENT_PREVIEW_EXTS = new Set(["pdf", "docx"]);
const AI_CODE_EXTS = new Set([
  "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx",
  "py", "pyw", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "java", "kt", "kts", "go", "rs", "cs", "swift", "scala",
  "rb", "php", "sh", "bash", "zsh", "fish", "lua", "r",
  "dart", "ex", "exs", "erl", "hrl", "fs", "fsx", "vb",
  "vue", "svelte", "astro", "sql", "pl", "pm",
  "html", "htm", "css", "scss", "sass", "less", "xml",
]);
const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

function isImagePath(filePath: string): boolean {
  const base = getFileName(filePath);
  const ext = base.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTS.has(ext);
}

function isAudioPath(filePath: string): boolean {
  const base = getFileName(filePath);
  const ext = base.toLowerCase().split(".").pop() ?? "";
  return AUDIO_EXTS.has(ext);
}

function getFileExt(filePath: string): string {
  return getFileName(filePath).toLowerCase().split(".").pop() ?? "";
}

function isDocumentPreviewPath(filePath: string): boolean {
  return DOCUMENT_PREVIEW_EXTS.has(getFileExt(filePath));
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch" | "origin",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encodeFilePathForApi(filePath)}?${searchParams.toString()}`;
}

function requestFileData(filePath: string, sourceSessionId?: string | null): Promise<FileData> {
  const cacheKey = `${sourceSessionId ?? "current"}\0${filePath}`;
  const activeRequest = fileDataRequests.get(cacheKey);
  if (activeRequest) return activeRequest;
  const request = fetch(getFileApiUrl(filePath, "read", sourceSessionId), { cache: "no-store" })
    .then(async (response) => {
      const data = await response.json().catch(() => ({})) as FileData & { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `Unable to load file (HTTP ${response.status})`);
      }
      fileDataCache.set(cacheKey, data);
      return data;
    })
    .finally(() => {
      if (fileDataRequests.get(cacheKey) === request) fileDataRequests.delete(cacheKey);
    });
  fileDataRequests.set(cacheKey, request);
  return request;
}

/** Start the editor bundle and text request while the pointer is still over a
 * file row. Opening the file then reuses the same in-flight request. */
export function preloadFileContent(filePath: string): void {
  preloadCodeEditor();
  if (isImagePath(filePath) || isAudioPath(filePath) || isDocumentPreviewPath(filePath) || fileDataCache.has(`current\0${filePath}`)) return;
  void requestFileData(filePath).catch(() => {
    // The actual viewer reports errors if the user proceeds to open the file.
  });
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title="Download file"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 20,
        padding: "0 5px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-muted)",
        cursor: "pointer",
        flexShrink: 0,
        textDecoration: "none",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

type DiffLine =
  | { type: "unchanged"; text: string; lineNo: number }
  | { type: "removed"; text: string; lineNo: number }
  | { type: "added"; text: string; lineNo: number };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Myers diff — returns line-level unified diff
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max];
      } else {
        x = v[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= m && y >= n) {
        // backtrack
        const result: DiffLine[] = [];
        let cx = m, cy = n;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd - 1];
          const pk = cx - cy;
          let prevK: number;
          if (pk === -dd || (pk !== dd && pv[pk - 1 + max] < pv[pk + 1 + max])) {
            prevK = pk + 1;
          } else {
            prevK = pk - 1;
          }
          const prevX = pv[prevK + max];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
          }
          if (dd > 0) {
            if (cx > prevX) {
              cx--;
              result.unshift({ type: "removed", text: oldLines[cx], lineNo: cx + 1 });
            } else {
              cy--;
              result.unshift({ type: "added", text: newLines[cy], lineNo: cy + 1 });
            }
          }
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
        }
        return result;
      }
    }
  }
  // Fallback: treat all as replaced
  return [
    ...oldLines.map((t, i) => ({ type: "removed" as const, text: t, lineNo: i + 1 })),
    ...newLines.map((t, i) => ({ type: "added" as const, text: t, lineNo: i + 1 })),
  ];
}

function DiffView({ oldContent, newContent, wrapLines }: { oldContent: string; newContent: string; wrapLines: boolean }) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = diffLines(oldLines, newLines);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        No changes
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  // Track running line number for added/unchanged lines
  const newLineNos: number[] = [];
  let nlo = 1;
  for (const line of diff) {
    if (line.type === "removed") {
      newLineNos.push(0);
    } else {
      newLineNos.push(nlo++);
    }
  }

  let diffIdx = 0;

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.6 }}>
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              ... {seg.count} unchanged lines ...
            </div>
          );
          diffIdx += seg.count;
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          const idx = diffIdx + li;
          const newLno = newLineNos[idx];
          const bg =
            line.type === "added"
              ? "rgba(0,200,80,0.12)"
              : line.type === "removed"
              ? "rgba(240,60,60,0.14)"
              : "transparent";
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "#4ade80" : line.type === "removed" ? "#f87171" : "var(--text-dim)";

          return (
            <div
              key={li}
              style={{
                display: "flex",
                minWidth: wrapLines ? 0 : "max-content",
                background: bg,
                borderLeft: line.type === "added"
                  ? "3px solid #4ade80"
                  : line.type === "removed"
                  ? "3px solid #f87171"
                  : "3px solid transparent",
              }}
            >
              <span
                style={{
                  minWidth: 44,
                  padding: "0 8px 0 16px",
                  textAlign: "right",
                  color: "var(--text-dim)",
                  userSelect: "none",
                  fontSize: 11,
                  lineHeight: 1.6,
                  borderRight: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  flexShrink: 0,
                }}
              >
                {line.type === "removed" ? line.lineNo : newLno || ""}
              </span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                  fontWeight: 600,
                }}
              >
                {prefix}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "0 8px 0 0",
                  whiteSpace: wrapLines ? "pre-wrap" : "pre",
                  overflowWrap: wrapLines ? "anywhere" : "normal",
                  color: "var(--text)",
                  overflowX: wrapLines ? "hidden" : "auto",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
        });
        diffIdx += seg.lines.length;
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

function OriginView({ content, wrapLines }: { content: string; wrapLines: boolean }) {
  const lines = content.split("\n");
  return (
    <div style={{ minHeight: "100%", fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.65 }}>
      {lines.map((line, index) => (
        <div key={index} style={{ display: "flex", minWidth: wrapLines ? 0 : "max-content" }}>
          <span style={{
            width: 52,
            paddingRight: 12,
            flexShrink: 0,
            textAlign: "right",
            color: "var(--text-dim)",
            background: "color-mix(in srgb, var(--bg-panel) 88%, transparent)",
            borderRight: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
            userSelect: "none",
          }}>
            {index + 1}
          </span>
          <span style={{ flex: 1, minWidth: 0, padding: "0 14px", color: "var(--text)", whiteSpace: wrapLines ? "pre-wrap" : "pre", overflowWrap: wrapLines ? "anywhere" : "normal" }}>
            {line || "\u00a0"}
          </span>
        </div>
      ))}
    </div>
  );
}

const IMAGE_MIN_SCALE = 0.05;
const IMAGE_MAX_SCALE = 16;

function clampImageScale(scale: number): number {
  return Math.max(IMAGE_MIN_SCALE, Math.min(IMAGE_MAX_SCALE, scale));
}

function ImageViewer({ filePath, cwd, uiLanguage = "en", sourceSessionId, active = true, watchEnabled = true }: Props) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomMode, setZoomMode] = useState<"fit" | "custom">("fit");
  const [customScale, setCustomScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const imageSrcRef = useRef("");
  const scaleRef = useRef(1);
  const zoomModeRef = useRef<"fit" | "custom">("fit");
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";
  const displayedScale = zoomMode === "fit" ? fitScale : customScale;
  const zh = uiLanguage === "zh";
  scaleRef.current = displayedScale;
  zoomModeRef.current = zoomMode;
  naturalSizeRef.current = naturalSize;

  const measureFit = useCallback(() => {
    const viewport = viewportRef.current;
    const imageSize = naturalSizeRef.current;
    if (!viewport || !imageSize || imageSize.w <= 0 || imageSize.h <= 0) return;
    const availableWidth = Math.max(1, viewport.clientWidth - 32);
    const availableHeight = Math.max(1, viewport.clientHeight - 32);
    const nextScale = clampImageScale(Math.min(availableWidth / imageSize.w, availableHeight / imageSize.h));
    setFitScale(nextScale);
    if (zoomModeRef.current === "fit") scaleRef.current = nextScale;
  }, []);

  const setScaleAt = useCallback((requestedScale: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    const imageSize = naturalSizeRef.current;
    if (!viewport || !imageSize) return;

    const previousScale = Math.max(IMAGE_MIN_SCALE, scaleRef.current);
    const nextScale = clampImageScale(requestedScale);
    if (Math.abs(nextScale - previousScale) < 0.0001 && zoomModeRef.current === "custom") return;

    const bounds = viewport.getBoundingClientRect();
    const anchorX = clientX === undefined ? viewport.clientWidth / 2 : clientX - bounds.left;
    const anchorY = clientY === undefined ? viewport.clientHeight / 2 : clientY - bounds.top;
    const previousWidth = imageSize.w * previousScale;
    const previousHeight = imageSize.h * previousScale;
    const previousLeft = Math.max(16, (viewport.clientWidth - previousWidth) / 2);
    const previousTop = Math.max(16, (viewport.clientHeight - previousHeight) / 2);
    const imageX = (viewport.scrollLeft + anchorX - previousLeft) / previousScale;
    const imageY = (viewport.scrollTop + anchorY - previousTop) / previousScale;

    zoomModeRef.current = "custom";
    scaleRef.current = nextScale;
    setZoomMode("custom");
    setCustomScale(nextScale);

    window.requestAnimationFrame(() => {
      const currentViewport = viewportRef.current;
      const currentSize = naturalSizeRef.current;
      if (!currentViewport || !currentSize) return;
      const nextWidth = currentSize.w * nextScale;
      const nextHeight = currentSize.h * nextScale;
      const nextLeft = Math.max(16, (currentViewport.clientWidth - nextWidth) / 2);
      const nextTop = Math.max(16, (currentViewport.clientHeight - nextHeight) / 2);
      currentViewport.scrollLeft = imageX * nextScale + nextLeft - anchorX;
      currentViewport.scrollTop = imageY * nextScale + nextTop - anchorY;
    });
  }, []);

  const fitImage = useCallback(() => {
    zoomModeRef.current = "fit";
    setZoomMode("fit");
    measureFit();
    window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }, [measureFit]);

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);
    setZoomMode("fit");
    setCustomScale(1);
    setFitScale(1);
    zoomModeRef.current = "fit";
    scaleRef.current = 1;

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!active) return;
    if (!watchEnabled) return;

    let mounted = true;
    const synchronize = () => {
      void fetch(getFileApiUrl(filePath, "meta", sourceSessionId), { cache: "no-store" })
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!mounted) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setNaturalSize(null);
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (mounted) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      // Image generators commonly replace a file in multiple writes. If the
      // browser sampled an incomplete write, clear the sticky decode error and
      // retry the new version instead of leaving the preview permanently blank.
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      mounted = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [active, filePath, sourceSessionId, watchEnabled]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => measureFit());
    observer.observe(viewport);
    measureFit();
    return () => observer.disconnect();
  }, [measureFit, naturalSize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!naturalSizeRef.current) return;
      event.preventDefault();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * viewport.clientHeight
          : event.deltaY;
      const nextScale = scaleRef.current * Math.exp(-delta * 0.0017);
      setScaleAt(nextScale, event.clientX, event.clientY);
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [setScaleAt]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);
  imageSrcRef.current = src;

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg-panel)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "image"}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <span
          title={watching ? "Live sync active" : "Not watching"}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setScaleAt(scaleRef.current / 1.2)}
            disabled={!naturalSize || displayedScale <= IMAGE_MIN_SCALE}
            title={zh ? "缩小" : "Zoom out"}
            aria-label={zh ? "缩小图片" : "Zoom image out"}
            style={imageToolbarButtonStyle}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14" /></svg>
          </button>
          <button
            type="button"
            onClick={() => setScaleAt(1)}
            disabled={!naturalSize}
            title={zh ? "恢复原始尺寸" : "Actual size"}
            style={{ ...imageToolbarButtonStyle, width: 46, fontFamily: "var(--font-mono)", fontSize: 10 }}
          >
            {Math.round(displayedScale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setScaleAt(scaleRef.current * 1.2)}
            disabled={!naturalSize || displayedScale >= IMAGE_MAX_SCALE}
            title={zh ? "放大" : "Zoom in"}
            aria-label={zh ? "放大图片" : "Zoom image in"}
            style={imageToolbarButtonStyle}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button
            type="button"
            onClick={fitImage}
            disabled={!naturalSize}
            title={zh ? "适应查看区域（双击图片）" : "Fit to viewport (double-click image)"}
            aria-pressed={zoomMode === "fit"}
            style={{ ...imageToolbarButtonStyle, width: 34, color: zoomMode === "fit" ? "var(--accent)" : "var(--text-muted)" }}
          >
            {zh ? "适应" : "Fit"}
          </button>
        </div>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        ref={viewportRef}
        onDoubleClick={fitImage}
        onPointerDown={(event) => {
          if (event.button !== 0 || !naturalSize) return;
          const viewport = viewportRef.current;
          if (!viewport) return;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const viewport = viewportRef.current;
          if (!drag || !viewport || drag.pointerId !== event.pointerId) return;
          viewport.scrollLeft = drag.left - (event.clientX - drag.x);
          viewport.scrollTop = drag.top - (event.clientY - drag.y);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          position: "relative",
          cursor: dragging ? "grabbing" : naturalSize ? "grab" : "default",
          touchAction: "none",
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ minWidth: "100%", minHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "#f87171", fontSize: 13 }}>
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setBust((current) => current + 1);
              }}
              style={{
                height: 28,
                padding: "0 11px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
              }}
            >
              {zh ? "重新加载" : "Reload"}
            </button>
          </div>
        ) : (
          <div
            style={{
              width: naturalSize ? naturalSize.w * displayedScale + 32 : "100%",
              height: naturalSize ? naturalSize.h * displayedScale + 32 : "100%",
              minWidth: "100%",
              minHeight: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={filePath}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                const nextNaturalSize = { w: img.naturalWidth, h: img.naturalHeight };
                naturalSizeRef.current = nextNaturalSize;
                setNaturalSize(nextNaturalSize);
                setError(null);
                window.requestAnimationFrame(measureFit);
              }}
              onError={() => {
                // Ask for one byte so an HTTP error body (for example the size
                // limit) can be shown without downloading the image a second
                // time. A successful range response means decoding failed.
                const failedSrc = src;
                void fetch(failedSrc, {
                  cache: "no-store",
                  headers: { Range: "bytes=0-0" },
                })
                  .then(async (response) => {
                    if (imageSrcRef.current !== failedSrc) {
                      void response.body?.cancel();
                      return;
                    }
                    if (!response.ok) {
                      const body = await response.json().catch(() => ({})) as { error?: string };
                      if (imageSrcRef.current !== failedSrc) return;
                      setError(body.error || `${zh ? "图片加载失败" : "Failed to load image"} (HTTP ${response.status})`);
                      return;
                    }
                    void response.body?.cancel();
                    setError(zh ? "图片格式不受支持或文件已损坏" : "Unsupported image format or damaged file");
                  })
                  .catch(() => {
                    if (imageSrcRef.current === failedSrc) {
                      setError(zh ? "图片加载失败" : "Failed to load image");
                    }
                  });
              }}
              style={{
                display: "block",
                flex: "0 0 auto",
                width: naturalSize ? naturalSize.w * displayedScale : "auto",
                height: naturalSize ? naturalSize.h * displayedScale : "auto",
                maxWidth: "none",
                maxHeight: "none",
                userSelect: "none",
                pointerEvents: "none",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const imageToolbarButtonStyle = {
  width: 26,
  height: 22,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 10,
  lineHeight: 1,
  flexShrink: 0,
} as const;

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, sourceSessionId, active = true, watchEnabled = true }: Props) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!active) return;
    if (!watchEnabled) return;

    let mounted = true;
    const synchronize = () => {
      void fetch(getFileApiUrl(filePath, "meta", sourceSessionId), { cache: "no-store" })
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!mounted) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") setSize(next.size);
          setDuration(null);
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (mounted) setError(String(nextError));
        });
    };

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      mounted = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [active, filePath, sourceSessionId, watchEnabled]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg-panel)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? "Live sync active" : "Not watching"}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load audio")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({
  filePath,
  accountUid,
  cwd,
  location,
  focusToken,
  onDocQa,
  pdfFocusMode = false,
  onPdfFocusModeChange,
  uiLanguage = "en",
  active = true,
  sourceSessionId,
  watchEnabled = true,
}: Props) {
  const zh = uiLanguage === "zh";
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const canAskDocument = ext === "pdf" || ext === "docx";
  const basePreviewUrl = getFileApiUrl(
    filePath,
    isPdf ? "read" : "preview",
    sourceSessionId,
    bust ? { v: bust } : undefined,
  );
  const pdfPage = documentPageNumberFromLocation(location);

  useEffect(() => {
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);

    fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
      .then((r) => r.json())
      .then((d: { size?: number; error?: string }) => {
        if (d.error) setError(d.error);
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
          }
        }
      })
      .catch((e) => setError(String(e)));
  }, [filePath, isPdf, sourceSessionId]);

  useEffect(() => {
    if (!active) {
      esRef.current?.close();
      esRef.current = null;
      setWatching(false);
      return;
    }
    if (!watchEnabled) return;

    let mounted = true;
    const synchronize = () => {
      void fetch(getFileApiUrl(filePath, "meta", sourceSessionId), { cache: "no-store" })
        .then((response) => response.json())
        .then((next: { size?: number; error?: string }) => {
          if (!mounted) return;
          if (next.error) {
            setError(next.error);
            return;
          }
          if (typeof next.size === "number") {
            setSize(next.size);
            if (!isPdf && next.size > DOCX_PREVIEW_MAX_BYTES) {
              setError("DOCX too large for preview (>10MB)");
              return;
            }
          }
          setError(null);
          setBust((value) => value + 1);
        })
        .catch((nextError) => {
          if (mounted) setError(String(nextError));
        });
    };
    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      mounted = false;
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [active, filePath, isPdf, sourceSessionId, watchEnabled]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {!pdfFocusMode && <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 26,
          padding: "2px 10px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        {onDocQa && canAskDocument && (
          <button
            type="button"
            title={zh ? "将此文档作为问答上下文添加到对话" : "Attach this document to the chat as DocQA context"}
            onClick={() => onDocQa({
              path: filePath,
              name: getFileName(filePath),
              kind: ext,
              size: size ?? undefined,
            })}
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 22,
              padding: "0 8px",
              borderRadius: 5,
              border: "1px solid rgba(59,130,246,0.32)",
              background: "rgba(59,130,246,0.10)",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {zh ? `询问此 ${ext.toUpperCase()}` : `Ask this ${ext.toUpperCase()}`}
          </button>
        )}
        <span style={{ marginLeft: onDocQa && canAskDocument ? 0 : "auto" }}>{ext === "docx" ? "docx preview" : "pdf"}</span>
        {location && (
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>
            {zh ? `引用${pdfPage ? `第 ${pdfPage} 页` : location}` : `cited ${pdfPage ? `page ${pdfPage}` : location}`}
          </span>
        )}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? (zh ? "实时同步中" : "Live sync active") : (zh ? "未监听文件变化" : "Not watching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)", flexShrink: 0 }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? (zh ? "实时" : "live") : (zh ? "静态" : "static")}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", background: "var(--bg-panel)" }}>
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#f87171", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        ) : isPdf ? (
          <PdfCanvasViewer
            src={basePreviewUrl}
            fileName={getFileName(filePath)}
            storageKey={`${accountUid ?? "local"}:${filePath}`}
            requestedPage={pdfPage}
            focusToken={focusToken}
            focusMode={pdfFocusMode}
            onFocusModeChange={onPdfFocusModeChange}
            uiLanguage={uiLanguage}
          />
        ) : (
          <iframe
            key={basePreviewUrl}
            src={basePreviewUrl}
            sandbox=""
            title={`Preview ${getFileName(filePath)}`}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#eef1f5",
            }}
          />
        )}
      </div>
    </div>
  );
}

export const FileViewer = memo(function FileViewer({
  filePath,
  accountUid,
  cwd,
  location,
  focusToken,
  onDirtyChange,
  onDocQa,
  pdfFocusMode,
  onPdfFocusModeChange,
  uiLanguage = "en",
  active = true,
  terminalOpen = false,
  onTerminalRequest,
  sourceSessionId,
  onOpenFile,
  onMentionLines,
  onAtMention,
  gitRefreshKey,
  initialDisplayMode,
  initialState,
  onStateChange,
  watchEnabled = true,
}: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} uiLanguage={uiLanguage} sourceSessionId={sourceSessionId} active={active} watchEnabled={watchEnabled} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} active={active} watchEnabled={watchEnabled} />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return (
      <DocumentViewer
        filePath={filePath}
        accountUid={accountUid}
        cwd={cwd}
        location={location}
        focusToken={focusToken}
        onDocQa={onDocQa}
        pdfFocusMode={pdfFocusMode}
        onPdfFocusModeChange={onPdfFocusModeChange}
        uiLanguage={uiLanguage}
        active={active}
        sourceSessionId={sourceSessionId}
        watchEnabled={watchEnabled}
      />
    );
  }
  return (
    <TextFileViewer
      filePath={filePath}
      accountUid={accountUid}
      cwd={cwd}
      location={location}
      focusToken={focusToken}
      onDirtyChange={onDirtyChange}
      uiLanguage={uiLanguage}
      active={active}
      terminalOpen={terminalOpen}
      onTerminalRequest={onTerminalRequest}
      sourceSessionId={sourceSessionId}
      onOpenFile={onOpenFile}
      onMentionLines={onMentionLines}
      onAtMention={onAtMention}
      gitRefreshKey={gitRefreshKey}
      initialDisplayMode={initialDisplayMode}
      initialState={initialState}
      onStateChange={onStateChange}
      watchEnabled={watchEnabled}
    />
  );
});

function TextFileViewer({
  filePath,
  accountUid,
  cwd,
  location,
  focusToken,
  onDirtyChange,
  uiLanguage = "en",
  active = true,
  terminalOpen = false,
  onTerminalRequest,
  sourceSessionId,
  onOpenFile,
  onMentionLines,
  onAtMention,
  gitRefreshKey,
  initialDisplayMode,
  initialState,
  onStateChange,
  watchEnabled = true,
}: Props) {
  const { isDark } = useTheme();
  const zh = uiLanguage === "zh";
  const requestedInitialDisplayMode = resolveInitialFileDisplayMode(initialState, initialDisplayMode);
  const cacheKey = `${sourceSessionId ?? "current"}\0${filePath}`;
  const readOnly = Boolean(sourceSessionId);
  const initialWrapLines = initialState?.wrapLines ?? true;
  const initialScrollTop = initialState?.scrollTop ?? 0;
  const initialScrollLeft = initialState?.scrollLeft ?? 0;
  const [data, setData] = useState<FileData | null>(null);
  const [prevContent, setPrevContent] = useState<string | null>(null);
  const [originData, setOriginData] = useState<OriginData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(requestedInitialDisplayMode === "preview");
  const [viewMode, setViewMode] = useState<"source" | "origin" | "diff">(
    requestedInitialDisplayMode === "diff" ? "diff" : "source",
  );
  const [wrapLines, setWrapLines] = useState(initialWrapLines);
  const [codeFontSize, setCodeFontSize] = useState(13.5);
  const [, setWatching] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [externalConflict, setExternalConflict] = useState<{ content: string; mtimeMs: number } | null>(null);
  const [selectedLineRange, setSelectedLineRange] = useState<{ startLine: number; endLine: number } | null>(null);
  const [generateRequest] = useState(0);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiReviewEnabled, setAiReviewEnabled] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiCodeSettings, setAiCodeSettings] = useState<AiCodeSettings>(() => (
    aiCodeSettingsCache.get(accountUid ?? "current") ?? DEFAULT_AI_CODE_SETTINGS
  ));
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(true);
  const [generationState, setGenerationState] = useState<{
    status: "idle" | "generating" | "suggested" | "done" | "error";
    error?: string;
    modelName?: string;
  }>({ status: "idle" });
  const [, setDiagnostics] = useState({ errors: 0, warnings: 0 });
  const [, setLanguageServiceStatus] = useState<"builtin" | "connecting" | "clangd" | "unavailable">("builtin");
  const esRef = useRef<EventSource | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const editorValueRef = useRef("");
  const savedContentRef = useRef("");
  const ignoreWatchUntilRef = useRef(0);
  const defaultPreviewEligibleRef = useRef(
    initialState === undefined && initialDisplayMode === undefined,
  );
  const scrollRestorePendingRef = useRef(true);
  const viewerStateRef = useRef<FileViewerState>({
    displayMode: requestedInitialDisplayMode,
    wrapLines: initialWrapLines,
    scrollTop: initialScrollTop,
    scrollLeft: initialScrollLeft,
  });
  const onStateChangeRef = useRef(onStateChange);
  editorValueRef.current = editorValue;
  onStateChangeRef.current = onStateChange;

  const handleDiagnostics = useCallback((errors: number, warnings: number) => {
    setDiagnostics((current) => current.errors === errors && current.warnings === warnings
      ? current
      : { errors, warnings });
  }, []);

  useEffect(() => {
    const nextState: FileViewerState = {
      displayMode: requestedInitialDisplayMode,
      wrapLines: initialWrapLines,
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft,
    };
    viewerStateRef.current = nextState;
    scrollRestorePendingRef.current = true;

    return () => {
      onStateChangeRef.current?.({ ...viewerStateRef.current });
    };
  }, [cacheKey, initialScrollLeft, initialScrollTop, initialWrapLines, requestedInitialDisplayMode]);

  const updateDisplayMode = useCallback((nextDisplayMode: FileViewerDisplayMode) => {
    viewerStateRef.current.displayMode = nextDisplayMode;
    if (nextDisplayMode === "preview") {
      setViewMode("source");
      setPreviewMode(true);
      return;
    }
    setPreviewMode(false);
    setViewMode(nextDisplayMode === "diff" ? "diff" : "source");
  }, []);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem("lithochat.codeFontSize"));
    if (Number.isFinite(stored) && stored >= 10 && stored <= 24) setCodeFontSize(stored);
    setAiEnabled(window.localStorage.getItem("lithochat.codeAiEnabled") === "true");
    setAiReviewEnabled(window.localStorage.getItem("lithochat.codeAiReviewEnabled") === "true");
    setDiagnosticsEnabled(window.localStorage.getItem("lithochat.codeDiagnosticsEnabled") !== "false");
    if (initialState?.wrapLines === undefined) {
      setWrapLines(window.localStorage.getItem("lithochat.codeWrapLines") !== "false");
    }
  }, [initialState?.wrapLines]);

  useEffect(() => {
    const cacheKey = accountUid ?? "current";
    const cached = aiCodeSettingsCache.get(cacheKey);
    if (cached) setAiCodeSettings(cached);
    const controller = new AbortController();
    void fetch("/api/accounts/preferences", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { preferences?: { aiCode?: AiCodeSettings } };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = normalizeAiCodeSettings(body.preferences?.aiCode);
        aiCodeSettingsCache.set(cacheKey, next);
        setAiCodeSettings(next);
      })
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === "AbortError")) {
          console.warn("Unable to load AI code settings", loadError);
        }
      });
    const syncSettings = (event: Event) => {
      const next = normalizeAiCodeSettings((event as CustomEvent<AiCodeSettings>).detail);
      aiCodeSettingsCache.set(cacheKey, next);
      setAiCodeSettings(next);
    };
    window.addEventListener(AI_CODE_SETTINGS_EVENT, syncSettings);
    return () => {
      controller.abort();
      window.removeEventListener(AI_CODE_SETTINGS_EVENT, syncSettings);
    };
  }, [accountUid]);

  const toggleWrapLines = useCallback(() => {
    setWrapLines((current) => {
      const next = !current;
      viewerStateRef.current.wrapLines = next;
      window.localStorage.setItem("lithochat.codeWrapLines", String(next));
      return next;
    });
  }, []);

  const toggleAi = useCallback(() => {
    setAiEnabled((current) => {
      const next = !current;
      window.localStorage.setItem("lithochat.codeAiEnabled", String(next));
      if (!next) setGenerationState({ status: "idle" });
      return next;
    });
  }, []);

  const toggleAiReview = useCallback(() => {
    setAiReviewEnabled((current) => {
      const next = !current;
      window.localStorage.setItem("lithochat.codeAiReviewEnabled", String(next));
      return next;
    });
  }, []);

  const toggleDiagnostics = useCallback(() => {
    setDiagnosticsEnabled((current) => {
      const next = !current;
      window.localStorage.setItem("lithochat.codeDiagnosticsEnabled", String(next));
      if (!next) setDiagnostics({ errors: 0, warnings: 0 });
      return next;
    });
  }, []);

  const changeCodeFontSize = useCallback((delta: number) => {
    setCodeFontSize((current) => {
      const next = Math.max(10, Math.min(24, current + delta));
      window.localStorage.setItem("lithochat.codeFontSize", String(next));
      return next;
    });
  }, []);
  const citedLines = useMemo(() => {
    const match = location?.match(/^L(\d+)(?:-L?(\d+))?$/i);
    if (!match) return null;
    return { start: Number(match[1]), end: Number(match[2] ?? match[1]) };
  }, [location]);
  const markdownDirectory = useMemo(() => getFileDirectory(filePath), [filePath]);
  const markdownPreview = useMemo(() => normalizeDisplayMath(editorValue), [editorValue]);
  const markdownFrontmatter = useMemo(() => parseFrontmatter(editorValue), [editorValue]);
  const markdownComponents = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
      }
      return <code className={className} {...props}>{children}</code>;
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      delete props.node;
      const linkedFile = onOpenFile
        ? resolveLocalFileHref(href, markdownDirectory, cwd ?? markdownDirectory)
        : null;
      if (!linkedFile || !onOpenFile) {
        return <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpenFile(linkedFile);
      };
      return <a href={href} {...props} onClick={handleClick}>{children}</a>;
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const imagePath = typeof src === "string"
        ? resolveLocalFileHref(src, markdownDirectory, cwd ?? markdownDirectory)
        : null;
      const imageSrc = imagePath
        ? getFileApiUrl(imagePath, "read", sourceSessionId)
        : src;
      // Dynamic local paths are served directly by the file API.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
    table({ children }) {
      return <div className="markdown-table-wrap"><table>{children}</table></div>;
    },
  }), [cwd, markdownDirectory, onOpenFile, sourceSessionId]);

  const fetchContent = useCallback((filePath: string, isRefresh = false) => {
    return requestFileData(filePath, sourceSessionId)
      .then((d) => {
        if (isRefresh) {
          if (Date.now() < ignoreWatchUntilRef.current) return d;
          const isDirty = editorValueRef.current !== savedContentRef.current;
          if (isDirty) {
            setExternalConflict({ content: d.content, mtimeMs: d.mtimeMs });
          } else {
            setData((prev) => {
              if (prev && prev.content !== d.content) setPrevContent(prev.content);
              return d;
            });
            setEditorValue(d.content);
            savedContentRef.current = d.content;
            setExternalConflict(null);
          }
        } else {
          setData(d);
          setEditorValue(d.content);
          savedContentRef.current = d.content;
          setExternalConflict(null);
        }
        return d;
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      });
  }, [sourceSessionId]);

  // Load content first. Git Origin/Diff is intentionally fetched in the
  // background so spawning Git never blocks the editor's first paint.
  useEffect(() => {
    const cached = fileDataCache.get(cacheKey);
    setLoading(!cached);
    setError(null);
    setData(cached ?? null);
    setPrevContent(null);
    setOriginData(null);
    setPreviewMode(requestedInitialDisplayMode === "preview");
    setViewMode(requestedInitialDisplayMode === "diff" ? "diff" : "source");
    setWatching(false);
    setEditorValue(cached?.content ?? "");
    editorValueRef.current = cached?.content ?? "";
    savedContentRef.current = cached?.content ?? "";
    setSaving(false);
    setSaveState("idle");
    setSaveError(null);
    setExternalConflict(null);
    setSelectedLineRange(null);
    setDiagnostics({ errors: 0, warnings: 0 });
    setLanguageServiceStatus("builtin");
    setGenerationState({ status: "idle" });

    let originTimer: number | null = null;
    void fetchContent(filePath).then((d) => {
      if (
        defaultPreviewEligibleRef.current
        && (d?.language === "markdown" || d?.language === "html")
      ) {
        defaultPreviewEligibleRef.current = false;
        updateDisplayMode("preview");
      }
      if (d) setOriginData((current) => current ?? { content: d.content, source: "snapshot", label: "open snapshot" });
      // Let React paint the file before starting the synchronous Git lookup on
      // the server. Starting both requests together allowed `git show` to block
      // the Node event loop before the much cheaper file response was flushed.
      originTimer = window.setTimeout(() => {
        void fetch(getFileApiUrl(filePath, "origin", sourceSessionId))
          .then((response) => response.json())
          .catch(() => ({ available: false }))
          .then((origin) => {
            const gitOrigin = origin as { available?: boolean; tracked?: boolean; content?: string; ref?: string };
            if (gitOrigin.available && typeof gitOrigin.content === "string") {
              setOriginData({
                content: gitOrigin.content,
                source: gitOrigin.tracked ? "git" : "untracked",
                label: gitOrigin.ref || (gitOrigin.tracked ? "HEAD" : "untracked"),
              });
            }
          });
      }, 180);
    }).finally(() => setLoading(false));

    return () => {
      if (originTimer !== null) window.clearTimeout(originTimer);
    };
  }, [cacheKey, fetchContent, filePath, gitRefreshKey, initialDisplayMode, initialState, requestedInitialDisplayMode, sourceSessionId, updateDisplayMode]);

  // Hidden tabs retain their editor state but do not keep an SSE connection,
  // AI completion loop or language diagnostics running in the background.
  useEffect(() => {
    if (!active) {
      esRef.current?.close();
      esRef.current = null;
      setWatching(false);
      return;
    }
    if (!watchEnabled) return;

    const synchronize = () => {
      void fetchContent(filePath, true);
    };
    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
      synchronize();
    });

    es.addEventListener("change", synchronize);

    es.addEventListener("error", () => {
      setWatching(false);
    });

    es.onerror = () => {
      setWatching(false);
    };

    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [active, filePath, fetchContent, sourceSessionId, watchEnabled]);

  const dirty = !readOnly && data ? editorValue !== data.content : false;
  const reportedDisplayMode: FileViewerDisplayMode = viewMode === "diff"
    ? "diff"
    : previewMode && (data?.language === "html" || data?.language === "markdown")
      ? "preview"
      : "source";

  useEffect(() => {
    viewerStateRef.current.displayMode = reportedDisplayMode;
    viewerStateRef.current.wrapLines = wrapLines;
    onStateChangeRef.current?.({ ...viewerStateRef.current });
  }, [reportedDisplayMode, wrapLines]);

  useEffect(() => {
    if (!scrollRestorePendingRef.current || loading || error) return;
    const content = contentRef.current;
    if (!content) return;
    content.scrollTop = viewerStateRef.current.scrollTop;
    content.scrollLeft = viewerStateRef.current.scrollLeft;
    scrollRestorePendingRef.current = false;
  }, [error, loading, previewMode, viewMode]);

  useEffect(() => {
    onDirtyChange?.(filePath, dirty);
  }, [dirty, filePath, onDirtyChange]);

  useEffect(() => {
    return () => onDirtyChange?.(filePath, false);
  }, [filePath, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const saveFile = useCallback(async (force = false) => {
    if (readOnly || !data || saving || (!dirty && !force)) return;
    setSaving(true);
    setSaveState("idle");
    setSaveError(null);
    try {
      const encoded = encodeFilePathForApi(filePath);
      const valueToSave = editorValueRef.current;
      const response = await fetch(`/api/files/${encoded}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: valueToSave,
          ...(!force ? { expectedMtimeMs: data.mtimeMs } : {}),
        }),
      });
      const result = await response.json() as {
        error?: string;
        conflict?: boolean;
        currentContent?: string;
        currentMtimeMs?: number;
        size?: number;
        mtimeMs?: number;
      };
      if (response.status === 409 && result.conflict) {
        setExternalConflict({
          content: result.currentContent ?? "",
          mtimeMs: result.currentMtimeMs ?? data.mtimeMs,
        });
        throw new Error(result.error || "File changed on disk");
      }
      if (!response.ok || typeof result.mtimeMs !== "number") {
        throw new Error(result.error || `Save failed (HTTP ${response.status})`);
      }

      ignoreWatchUntilRef.current = Date.now() + 1000;
      setPrevContent(data.content);
      setData((previous) => previous ? {
        ...previous,
        content: valueToSave,
        size: result.size ?? new TextEncoder().encode(valueToSave).length,
        mtimeMs: result.mtimeMs!,
      } : previous);
      fileDataCache.set(cacheKey, {
        ...data,
        content: valueToSave,
        size: result.size ?? new TextEncoder().encode(valueToSave).length,
        mtimeMs: result.mtimeMs,
      });
      savedContentRef.current = valueToSave;
      setExternalConflict(null);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch (saveFailure) {
      setSaveState("error");
      setSaveError(saveFailure instanceof Error ? saveFailure.message : String(saveFailure));
    } finally {
      setSaving(false);
    }
  }, [cacheKey, data, dirty, filePath, readOnly, saving]);

  useEffect(() => {
    if (!dirty || saving || externalConflict || generationState.status === "generating") return;
    const timer = window.setTimeout(() => {
      void saveFile();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [dirty, editorValue, externalConflict, generationState.status, saveFile, saving]);

  const reloadExternal = useCallback(() => {
    if (!externalConflict || !data) return;
    setPrevContent(data.content);
    setData({
      ...data,
      content: externalConflict.content,
      size: new TextEncoder().encode(externalConflict.content).length,
      mtimeMs: externalConflict.mtimeMs,
    });
    setEditorValue(externalConflict.content);
    savedContentRef.current = externalConflict.content;
    setExternalConflict(null);
    setSaveError(null);
    setSaveState("idle");
  }, [data, externalConflict]);

  useEffect(() => {
    if (!citedLines || !data) return;
    updateDisplayMode("source");
  }, [citedLines, data, focusToken, updateDisplayMode]);

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (!data) return null;

  const isHtml = data.language === "html";
  const isMarkdown = data.language === "markdown";
  const hasSavedDiff = prevContent !== null && prevContent !== data.content;
  const diffOriginal = originData?.content ?? (dirty ? data.content : (prevContent ?? data.content));
  const diffModified = editorValue;
  const hasDiff = diffOriginal !== diffModified || dirty || hasSavedDiff;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Status bar */}
      <div
        className="code-editor-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 28,
          padding: "2px 8px",
          borderBottom: "1px solid var(--border)",
          fontSize: 10,
          color: "var(--text-dim)",
          background: isDark ? "#21252b" : "#f3f3f3",
          flexShrink: 0,
          overflowX: "auto",
          overflowY: "hidden",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>

        {/* Current / Origin / Diff are stable views for every text file. */}
        <div style={{ marginLeft: "auto", display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              onClick={() => setViewMode("source")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                background: viewMode === "source" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "source" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "source" ? 600 : 400,
              }}
            >
              {zh ? "当前" : "Current"}
            </button>
            <button
              onClick={() => setViewMode("origin")}
              disabled={!originData}
              title={originData ? `${zh ? "原始版本" : "Origin"}: ${originData.label}` : (zh ? "正在加载原始版本…" : "Loading Origin…")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: originData ? "pointer" : "wait",
                background: viewMode === "origin" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "origin" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "origin" ? 600 : 400,
                opacity: originData ? 1 : 0.55,
              }}
            >
              {zh ? "原始" : "Origin"}
            </button>
            <button
              onClick={() => updateDisplayMode("diff")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                background: viewMode === "diff" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "diff" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "diff" ? 600 : 400,
              }}
            >
              {zh ? "差异" : "Diff"} {hasDiff && <span style={{ color: "#4ade80", marginLeft: 2 }}>●</span>}
            </button>
          </div>
        {originData && (
          <span title={`Origin source: ${originData.label}`} style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {originData.label}
          </span>
        )}

        {/* HTML source/preview toggle */}
        {isHtml && viewMode === "source" && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              onClick={() => updateDisplayMode("source")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              {zh ? "代码" : "Code"}
            </button>
            <button
              onClick={() => updateDisplayMode("preview")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              {zh ? "预览" : "Preview"}
            </button>
          </div>
        )}

        {/* Markdown preview/raw toggle */}
        {isMarkdown && viewMode === "source" && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              onClick={() => updateDisplayMode("preview")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              {zh ? "预览" : "Preview"}
            </button>
            <button
              onClick={() => updateDisplayMode("source")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              {zh ? "源码" : "Raw"}
            </button>
          </div>
        )}
        {viewMode === "source" && !previewMode && (
          <>
            <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 5, overflow: "hidden" }}>
              <button
                type="button"
                onClick={() => changeCodeFontSize(-1)}
                disabled={codeFontSize <= 10}
                title={`${zh ? "缩小代码字体" : "Decrease code font size"} (${codeFontSize}px)`}
                aria-label={zh ? "缩小代码字体" : "Decrease code font size"}
                style={{ width: 26, height: 22, border: "none", background: "var(--bg-hover)", color: "var(--text-muted)", cursor: codeFontSize <= 10 ? "not-allowed" : "pointer", opacity: codeFontSize <= 10 ? 0.45 : 1 }}
              >
                −
              </button>
              <button
                type="button"
                onClick={() => changeCodeFontSize(1)}
                disabled={codeFontSize >= 24}
                title={`${zh ? "放大代码字体" : "Increase code font size"} (${codeFontSize}px)`}
                aria-label={zh ? "放大代码字体" : "Increase code font size"}
                style={{ width: 26, height: 22, border: "none", borderLeft: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-muted)", cursor: codeFontSize >= 24 ? "not-allowed" : "pointer", opacity: codeFontSize >= 24 ? 0.45 : 1 }}
              >
                +
              </button>
            </div>
            <button
              type="button"
              onClick={toggleWrapLines}
              aria-pressed={wrapLines}
              title={wrapLines ? (zh ? "关闭自动换行" : "Disable word wrap") : (zh ? "开启自动换行" : "Enable word wrap")}
              style={{
                padding: "2px 8px", fontSize: 11, cursor: "pointer",
                background: wrapLines ? "var(--bg-selected)" : "var(--bg-hover)",
                color: wrapLines ? "var(--text)" : "var(--text-dim)",
                border: "1px solid var(--border)", borderRadius: 5,
              }}
            >
              {zh ? "换行" : "Wrap"} {wrapLines ? "✓" : "—"}
            </button>
            {AI_CODE_EXTS.has(getFileExt(filePath)) && (
              <button
                type="button"
                onClick={toggleAi}
                aria-pressed={aiEnabled}
                title={aiEnabled ? (zh ? "关闭 AI 实时代码补全" : "Disable AI inline completion") : (zh ? "开启 AI 实时代码补全" : "Enable AI inline completion")}
                style={{
                  padding: "2px 8px", fontSize: 11,
                  cursor: "pointer",
                  background: aiEnabled ? "color-mix(in srgb, var(--accent) 16%, var(--bg))" : "var(--bg-hover)",
                  color: aiEnabled ? "var(--accent)" : "var(--text-muted)",
                  border: `1px solid ${aiEnabled ? "color-mix(in srgb, var(--accent) 38%, var(--border))" : "var(--border)"}`,
                  borderRadius: 5,
                  fontWeight: 600,
                }}
              >
                <span style={{ display: "inline-block", width: 6, height: 6, marginRight: 5, borderRadius: 99, background: aiEnabled ? "#22c55e" : "var(--text-dim)" }} />AI
              </button>
            )}
            {AI_CODE_EXTS.has(getFileExt(filePath)) && (
              <button
                type="button"
                onClick={toggleAiReview}
                aria-pressed={aiReviewEnabled}
                title={aiReviewEnabled ? (zh ? "关闭 AI 文件纠错" : "Disable AI file review") : (zh ? "开启 AI 文件纠错" : "Enable AI file review")}
                style={{
                  padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  background: aiReviewEnabled ? "color-mix(in srgb, #a855f7 14%, var(--bg))" : "var(--bg-hover)",
                  color: aiReviewEnabled ? "#a855f7" : "var(--text-muted)",
                  border: `1px solid ${aiReviewEnabled ? "color-mix(in srgb, #a855f7 42%, var(--border))" : "var(--border)"}`,
                  borderRadius: 5,
                  fontWeight: 600,
                }}
              >
                {zh ? "纠错" : "Review"} {aiReviewEnabled ? "✓" : "—"}
              </button>
            )}
            {AI_CODE_EXTS.has(getFileExt(filePath)) && (
              <button
                type="button"
                onClick={() => setAiSettingsOpen(true)}
                title={zh ? "设置 AI 补全与 Code Review 参数" : "Configure AI completion and Code Review"}
                aria-label={zh ? "AI 辅助编程设置" : "AI coding settings"}
                style={{ width: 26, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.97a1.7 1.7 0 0 0-.34-1.88l-.06-.06L7.03 4.2l.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.52 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
                </svg>
              </button>
            )}
            {AI_CODE_EXTS.has(getFileExt(filePath)) && (
              <button
                type="button"
                onClick={toggleDiagnostics}
                aria-pressed={diagnosticsEnabled}
                title={diagnosticsEnabled ? (zh ? "关闭语法检查和错误标记" : "Disable syntax diagnostics") : (zh ? "开启语法检查和错误标记" : "Enable syntax diagnostics")}
                style={{
                  padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  background: diagnosticsEnabled ? "var(--bg-selected)" : "var(--bg-hover)",
                  color: diagnosticsEnabled ? "var(--text)" : "var(--text-dim)",
                  border: "1px solid var(--border)", borderRadius: 5,
                }}
              >
                {zh ? "语法" : "Check"} {diagnosticsEnabled ? "✓" : "—"}
              </button>
            )}
          </>
        )}
        <button
          type="button"
          onClick={() => onTerminalRequest?.()}
          disabled={!onTerminalRequest}
          title={terminalOpen ? (zh ? "隐藏集成终端" : "Hide integrated terminal") : (zh ? "打开集成终端" : "Open integrated terminal")}
          style={{
            padding: "2px 7px", fontSize: 11, cursor: onTerminalRequest ? "pointer" : "not-allowed",
            background: terminalOpen ? "var(--bg-selected)" : "var(--bg-hover)",
            color: terminalOpen ? "var(--accent)" : "var(--text-muted)",
            border: "1px solid var(--border)", borderRadius: 5,
            fontWeight: terminalOpen ? 600 : 400,
          }}
        >
          {zh ? "终端" : "Terminal"}
        </button>
        {(onAtMention || onMentionLines) && (
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (viewMode === "source" && !previewMode && selectedLineRange && onMentionLines) {
                onMentionLines(
                  getRelativeFilePath(filePath, cwd),
                  selectedLineRange.startLine,
                  selectedLineRange.endLine,
                );
                return;
              }
              onAtMention?.(getRelativeFilePath(filePath, cwd), false);
            }}
            disabled={!onAtMention && !(viewMode === "source" && !previewMode && selectedLineRange)}
            title={viewMode === "source" && !previewMode && selectedLineRange && onMentionLines
              ? (zh
                ? `提及选中行 L${selectedLineRange.startLine}${selectedLineRange.startLine === selectedLineRange.endLine ? "" : `-L${selectedLineRange.endLine}`}`
                : `Mention selected lines L${selectedLineRange.startLine}${selectedLineRange.startLine === selectedLineRange.endLine ? "" : `-L${selectedLineRange.endLine}`}`)
              : (zh ? "将文件路径插入对话" : "Insert file path into chat")}
            aria-label={zh ? "提及文件" : "Mention file"}
            style={{ width: 26, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: !onAtMention && !(viewMode === "source" && !previewMode && selectedLineRange) ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700 }}
          >
            @
          </button>
        )}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>

      {saveState === "error" && !externalConflict && saveError && (
        <div
          role="alert"
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 12px", flexShrink: 0,
            borderBottom: "1px solid rgba(239,68,68,0.24)",
            background: "rgba(239,68,68,0.07)", color: "var(--text-muted)",
            fontSize: 11,
          }}
        >
          <span style={{ color: "#ef4444", fontWeight: 700 }}>{zh ? "保存失败" : "Save failed"}</span>
          <span>{saveError}</span>
          <button
            type="button"
            onClick={() => setSaveState("idle")}
            aria-label={zh ? "关闭保存错误" : "Dismiss save error"}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 15 }}
          >
            ×
          </button>
        </div>
      )}

      {aiEnabled && generationState.status === "error" && generationState.error && (
        <div
          role="alert"
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 12px", flexShrink: 0,
            borderBottom: "1px solid rgba(239,68,68,0.24)",
            background: "rgba(239,68,68,0.07)", color: "#ef4444",
            fontSize: 11,
          }}
        >
          <span style={{ fontWeight: 700 }}>{zh ? "AI 生成：" : "AI generation:"}</span>
          <span style={{ color: "var(--text-muted)" }}>{generationState.error}</span>
          <button
            type="button"
            onClick={() => setGenerationState({ status: "idle" })}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 15 }}
            aria-label={zh ? "关闭 AI 生成错误" : "Dismiss AI generation error"}
          >
            ×
          </button>
        </div>
      )}

      {externalConflict && (
        <div
          role="alert"
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "7px 12px", flexShrink: 0,
            borderBottom: "1px solid rgba(245,158,11,0.3)",
            background: "rgba(245,158,11,0.09)", color: "var(--text-muted)",
            fontSize: 11,
          }}
        >
          <span style={{ color: "#d97706", fontWeight: 700 }}>{zh ? "磁盘中的文件已变化。" : "File changed on disk."}</span>
          <span>{zh ? "未保存的编辑内容已保留。" : "Your unsaved editor content has been preserved."}</span>
          <button
            type="button"
            onClick={reloadExternal}
            style={{ marginLeft: "auto", padding: "3px 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
          >
            {zh ? "重新加载磁盘版本" : "Reload disk"}
          </button>
          <button
            type="button"
            onClick={() => void saveFile(true)}
            style={{ padding: "3px 7px", border: "1px solid #d97706", borderRadius: 4, background: "rgba(245,158,11,0.12)", color: "#b45309", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
          >
            Overwrite
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflow: "hidden" }}>
        <div
          ref={contentRef}
          onScroll={(event) => {
            viewerStateRef.current.scrollTop = event.currentTarget.scrollTop;
            viewerStateRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: viewMode === "source" && !previewMode ? "hidden" : "auto",
            background: isDark ? "#282c34" : "#fafafa",
          }}
        >
        {viewMode === "origin" && originData ? (
          <OriginView content={originData.content} wrapLines={wrapLines} />
        ) : viewMode === "diff" ? (
          <DiffView oldContent={diffOriginal} newContent={diffModified} wrapLines={wrapLines} />
        ) : isHtml && previewMode ? (
          <iframe
            srcDoc={editorValue}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
            title="HTML preview"
          />
        ) : isMarkdown && previewMode ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "24px 32px", maxWidth: 800 }}
          >
            {markdownFrontmatter.data && <FrontmatterCard data={markdownFrontmatter.data} />}
            <ReactMarkdown
              remarkPlugins={markdownPreviewRemarkPlugins}
              rehypePlugins={markdownPreviewRehypePlugins}
              components={markdownComponents}
            >
              {markdownPreview}
            </ReactMarkdown>
          </div>
        ) : (
          <MonacoCodeEditor
            value={editorValue}
            language={data.language}
            filePath={filePath}
            projectRoot={cwd}
            isDark={isDark}
            wrapLines={wrapLines}
            fontSize={codeFontSize}
            location={location}
            focusToken={focusToken}
            generateRequest={generateRequest}
            aiEnabled={active && !readOnly && aiEnabled}
            aiReviewEnabled={active && !readOnly && aiReviewEnabled}
            aiCodeSettings={aiCodeSettings}
            diagnosticsEnabled={active && diagnosticsEnabled}
            readOnly={readOnly}
            initialScrollTop={viewerStateRef.current.scrollTop}
            initialScrollLeft={viewerStateRef.current.scrollLeft}
            uiLanguage={uiLanguage}
            onChange={(nextValue) => {
              if (readOnly) return;
              setEditorValue(nextValue);
              setSaveState("idle");
              setSaveError(null);
            }}
            onSave={() => void saveFile()}
            onDiagnostics={handleDiagnostics}
            onLanguageServiceStatus={setLanguageServiceStatus}
            onGenerationState={setGenerationState}
            onScrollChange={(scrollTop, scrollLeft) => {
              viewerStateRef.current.scrollTop = scrollTop;
              viewerStateRef.current.scrollLeft = scrollLeft;
            }}
            onMentionLines={onMentionLines ? (startLine, endLine) => {
              onMentionLines(getRelativeFilePath(filePath, cwd), startLine, endLine);
            } : undefined}
            onSelectionChange={setSelectedLineRange}
          />
        )}
        </div>
      </div>
      {aiSettingsOpen && (
        <AiCodeSettingsDialog
          settings={aiCodeSettings}
          uiLanguage={uiLanguage}
          onClose={() => setAiSettingsOpen(false)}
          onSaved={(next) => {
            const normalized = normalizeAiCodeSettings(next);
            aiCodeSettingsCache.set(accountUid ?? "current", normalized);
            setAiCodeSettings(normalized);
            window.dispatchEvent(new CustomEvent(AI_CODE_SETTINGS_EVENT, { detail: normalized }));
          }}
        />
      )}
    </div>
  );
}
