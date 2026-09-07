"use client";

import { memo, useEffect, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import type { UiLanguage } from "@/lib/i18n";
import { getFileIcon } from "./FileIcons";

interface RevisionData {
  content: string;
  language: string;
  ref: string;
}

export const FileRevisionViewer = memo(function FileRevisionViewer({
  filePath,
  fileName,
  revision,
  uiLanguage = "en",
  onOpenCurrent,
}: {
  filePath: string;
  fileName: string;
  revision: { hash: string; shortHash: string; message: string };
  uiLanguage?: UiLanguage;
  onOpenCurrent?: () => void;
}) {
  const zh = uiLanguage === "zh";
  const [data, setData] = useState<RevisionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=revision&ref=${encodeURIComponent(revision.hash)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as RevisionData & { error?: string };
        if (!response.ok) throw new Error(payload.error || `${zh ? "无法读取历史版本" : "Unable to load revision"} (HTTP ${response.status})`);
        return payload;
      })
      .then(setData)
      .catch((reason) => {
        if ((reason as Error).name !== "AbortError") setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [filePath, revision.hash, zh]);

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "#282c34" }}>
      <div style={{ minHeight: 38, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <span style={{ display: "inline-flex", color: "var(--text-muted)" }}>{getFileIcon(fileName, 15)}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</span>
            <code style={{ padding: "1px 5px", borderRadius: 4, background: "var(--bg-hover)", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{revision.shortHash}</code>
            <span style={{ color: "var(--text-dim)", fontSize: 9 }}>{zh ? "只读" : "read-only"}</span>
          </div>
          <div title={revision.message} style={{ color: "var(--text-dim)", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{revision.message}</div>
        </div>
        {onOpenCurrent && (
          <button
            type="button"
            onClick={onOpenCurrent}
            style={{ height: 25, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}
          >
            {zh ? "打开当前文件" : "Open current"}
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "#282c34" }}>
        {error ? (
          <div style={{ margin: 14, padding: 12, border: "1px solid rgba(239,68,68,0.35)", borderRadius: 6, color: "#f87171", fontSize: 12 }}>{error}</div>
        ) : !data ? (
          <div style={{ padding: 14, color: "#7f8999", fontSize: 12 }}>{zh ? "正在加载历史版本…" : "Loading revision…"}</div>
        ) : (
          <pre
            style={{
              minWidth: "100%",
              width: "max-content",
              minHeight: "100%",
              boxSizing: "border-box",
              margin: 0,
              padding: "12px 16px 28px",
              color: "#abb2bf",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              lineHeight: 1.55,
              tabSize: 2,
              whiteSpace: "pre",
            }}
          >
            {data.content}
          </pre>
        )}
      </div>
    </div>
  );
});
