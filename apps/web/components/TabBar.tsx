"use client";

import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";
import type { UiLanguage } from "@/lib/i18n";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  location?: string;
  focusToken?: number;
  dirty?: boolean;
  view?: "file" | "timeline" | "revision" | "terminal" | "generated-code";
  revision?: {
    hash: string;
    shortHash: string;
    message: string;
  };
  sourceSessionId?: string | null;
  initialDisplayMode?: FileViewerDisplayMode;
  viewerState?: FileViewerState;
  viewerRevision?: number;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  uiLanguage?: UiLanguage;
  onSplitTab?: (id: string) => void;
  onMoveTabToMain?: (id: string) => void;
  isMainGroup?: boolean;
}

export const TabBar = memo(function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, uiLanguage = "en", onSplitTab, onMoveTabToMain, isMainGroup = true }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", keydown);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 30,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(event) => {
              if (!onSplitTab) return;
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                tabId: tab.id,
                x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)),
                y: Math.max(8, Math.min(event.clientY, window.innerHeight - 82)),
              });
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              height: 30,
              paddingLeft: 9,
              paddingRight: 5,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 11,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.view === "generated-code" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" /></svg>
              ) : tab.view === "terminal" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>
              ) : tab.view === "timeline" || tab.view === "revision" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /><path d="M4 4v5h5" />
                </svg>
              ) : getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            {tab.dirty && (
              <span title={uiLanguage === "zh" ? "有未保存的更改" : "Unsaved changes"} style={{ color: "#f59e0b", fontSize: 10, flexShrink: 0 }}>●</span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
              title={t("i18n.close")}
              aria-label={`${t("i18n.close")} ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
      {contextMenu && createPortal(
        <div
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 13000,
            width: 182,
            padding: 5,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "color-mix(in srgb, var(--bg-panel) 97%, transparent)",
            boxShadow: "0 14px 38px rgba(0,0,0,0.22)",
            backdropFilter: "blur(14px)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = contextMenu.tabId;
              setContextMenu(null);
              onSplitTab?.(id);
            }}
            style={tabContextMenuItemStyle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>
            {uiLanguage === "zh" ? "在右侧新建分栏" : "Split into new column"}
          </button>
          {!isMainGroup && onMoveTabToMain && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const id = contextMenu.tabId;
                setContextMenu(null);
                onMoveTabToMain(id);
              }}
              style={tabContextMenuItemStyle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 7-5 5 5 5M5 12h14" /></svg>
              {uiLanguage === "zh" ? "移回主栏" : "Move to main column"}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
});

const tabContextMenuItemStyle = {
  width: "100%",
  height: 32,
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  border: 0,
  borderRadius: 5,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 11,
  textAlign: "left",
} as const;
