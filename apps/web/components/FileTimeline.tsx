"use client";

import { memo, useCallback, useEffect, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { UiLanguage } from "@/lib/i18n";
import { getFileIcon } from "./FileIcons";

export interface TimelineEntry {
  hash: string;
  shortHash: string;
  author: string;
  timestamp: string;
  message: string;
  path?: string;
}

interface TimelineData {
  available: boolean;
  isDirectory: boolean;
  relativePath: string;
  workingTreeChanges: number;
  entries: TimelineEntry[];
}

const COPY = {
  en: {
    title: "Timeline",
    refresh: "Refresh timeline",
    loading: "Loading file history…",
    unavailable: "This item is not inside a Git repository.",
    empty: "No Git history is available for this item yet.",
    workingTree: "Working Tree",
    workingDetail: (count: number) => `${count} uncommitted ${count === 1 ? "change" : "changes"}`,
    commits: "Git history",
    loadFailed: "Unable to load timeline",
    openRevision: "Open this file revision",
  },
  zh: {
    title: "时间线",
    refresh: "刷新时间线",
    loading: "正在加载文件历史…",
    unavailable: "该项目不在 Git 仓库中。",
    empty: "该项目暂时没有 Git 历史记录。",
    workingTree: "工作区",
    workingDetail: (count: number) => `${count} 项未提交更改`,
    commits: "Git 历史",
    loadFailed: "无法加载时间线",
    openRevision: "打开该版本的文件",
  },
} as const;

function formatTimestamp(value: string, language: UiLanguage): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export const FileTimeline = memo(function FileTimeline({
  filePath,
  fileName,
  onOpenRevision,
  uiLanguage = "en",
}: {
  filePath: string;
  fileName: string;
  onOpenRevision?: (entry: TimelineEntry) => void;
  uiLanguage?: UiLanguage;
}) {
  const copy = COPY[uiLanguage];
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=timeline`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as TimelineData & { error?: string };
        if (!response.ok) throw new Error(payload.error || `${copy.loadFailed} (HTTP ${response.status})`);
        return payload;
      })
      .then(setData)
      .catch((reason) => {
        if ((reason as Error).name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [copy.loadFailed, filePath, refreshKey]);

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <div style={{ height: 38, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <span style={{ display: "inline-flex", color: "var(--text-muted)" }}>{getFileIcon(fileName, 15)}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</div>
          <div title={filePath} style={{ color: "var(--text-dim)", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data?.relativePath || filePath}
          </div>
        </div>
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{copy.title}</span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          title={copy.refresh}
          aria-label={copy.refresh}
          style={{ width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 0, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text-muted)", cursor: loading ? "wait" : "pointer", opacity: loading ? 0.55 : 1 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: loading ? "rotate(30deg)" : undefined }}>
            <path d="M20 6v5h-5M4 18v-5h5" /><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9M5.5 15A7 7 0 0 0 18 17.5l2-2.5" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 14px 28px" }}>
        {loading && !data ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>{copy.loading}</div>
        ) : error ? (
          <div style={{ padding: 12, border: "1px solid color-mix(in srgb, #ef4444 35%, var(--border))", borderRadius: 7, color: "#ef4444", fontSize: 12 }}>{error}</div>
        ) : data && !data.available ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>{copy.unavailable}</div>
        ) : data ? (
          <>
            {data.workingTreeChanges > 0 && (
              <section style={{ marginBottom: 18 }}>
                <div style={{ marginBottom: 8, color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{copy.workingTree}</div>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 10px", border: "1px solid color-mix(in srgb, #f59e0b 32%, var(--border))", borderRadius: 7, background: "color-mix(in srgb, #f59e0b 7%, var(--bg-panel))" }}>
                  <span style={{ width: 8, height: 8, marginTop: 3, flexShrink: 0, borderRadius: "50%", background: "#f59e0b" }} />
                  <div>
                    <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{copy.workingTree}</div>
                    <div style={{ marginTop: 3, color: "var(--text-muted)", fontSize: 10 }}>{copy.workingDetail(data.workingTreeChanges)}</div>
                  </div>
                </div>
              </section>
            )}

            <section>
              <div style={{ marginBottom: 9, color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{copy.commits}</div>
              {data.entries.length === 0 ? (
                <div style={{ color: "var(--text-dim)", fontSize: 12 }}>{copy.empty}</div>
              ) : (
                <div>
                  {data.entries.map((entry, index) => (
                    <button
                      key={entry.hash}
                      type="button"
                      className="file-timeline-entry"
                      disabled={data.isDirectory || !entry.path || !onOpenRevision}
                      title={!data.isDirectory && entry.path ? copy.openRevision : undefined}
                      onClick={() => onOpenRevision?.(entry)}
                      style={{
                        position: "relative",
                        display: "grid",
                        gridTemplateColumns: "16px minmax(0, 1fr)",
                        gap: 9,
                        width: "100%",
                        padding: `0 4px ${index === data.entries.length - 1 ? 0 : 14}px 0`,
                        border: 0,
                        borderRadius: 5,
                        background: "transparent",
                        fontFamily: "inherit",
                        textAlign: "left",
                        cursor: !data.isDirectory && entry.path && onOpenRevision ? "pointer" : "default",
                      }}
                    >
                      {index < data.entries.length - 1 && <span aria-hidden="true" style={{ position: "absolute", left: 7, top: 12, bottom: -1, width: 1, background: "var(--border)" }} />}
                      <span aria-hidden="true" style={{ position: "relative", zIndex: 1, width: 9, height: 9, marginTop: 3, marginLeft: 3, border: "2px solid var(--accent)", borderRadius: "50%", background: "var(--bg)" }} />
                      <div style={{ minWidth: 0, padding: "0 0 2px" }}>
                        <div title={entry.message} style={{ color: "var(--text)", fontSize: 12, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.message}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 8px", marginTop: 4, color: "var(--text-dim)", fontSize: 10 }}>
                          <code title={entry.hash} style={{ padding: "1px 4px", borderRadius: 3, background: "var(--bg-hover)", color: "var(--accent)", fontFamily: "var(--font-mono)" }}>{entry.shortHash}</code>
                          <span>{entry.author}</span>
                          <span>{formatTimestamp(entry.timestamp, uiLanguage)}</span>
                          {!data.isDirectory && entry.path && <span style={{ color: "var(--accent)" }}>↗</span>}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
});
