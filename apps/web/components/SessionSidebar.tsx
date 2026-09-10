"use client";

import { useI18n } from "@/hooks/useI18n";
import { memo, useEffect, useRef, useState } from "react";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { FcnPilotIcon } from "./FcnPilotIcon";
import { useAppDialog } from "./AppDialogProvider";
import { SHARED_ACCOUNT_IDENTITY } from "@/lib/shared-workspace";
import type { SessionInfo } from "@/lib/types";

interface Props {
  cwd: string | null;
  fileSelectionRequest?: number;
  selectingCircuit?: boolean;
  onCancelCircuitSelection?: () => void;
  sessions: SessionInfo[];
  selectedId: string | null;
  runningIds: Set<string>;
  onSelect: (session: SessionInfo) => void;
  onNew: () => void;
  onRefresh: () => void;
  onSessionChanged: (id: string, deleted: boolean) => void;
  onOpenFile: (path: string) => void;
  onAtMention: (path: string, directory: boolean) => void;
  onAtMentions: (paths: string[]) => void;
  onFileDeleted: (path: string, directory: boolean) => void;
  onFileMoved: (previous: string, next: string, directory: boolean) => void;
  fileRefresh: number;
  beforeFileMutation: (paths: string[]) => Promise<boolean>;
}

export const SessionSidebar = memo(function SessionSidebar({ cwd, fileSelectionRequest, selectingCircuit, onCancelCircuitSelection, sessions, selectedId, runningIds, onSelect, onNew, onRefresh, onSessionChanged, onOpenFile, onAtMention, onAtMentions, onFileDeleted, onFileMoved, fileRefresh, beforeFileMutation }: Props) {
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<"sessions" | "files">("sessions");
  const [filter, setFilter] = useState("");
  useEffect(() => { if (fileSelectionRequest) setTab("files"); }, [fileSelectionRequest]);
  const [busy, setBusy] = useState<string | null>(null);
  const explorer = useRef<FileExplorerHandle | null>(null);
  const dialog = useAppDialog();
  const shown = sessions.filter((session) => `${session.name || ""} ${session.firstMessage}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const rename = async (session: SessionInfo) => {
    const name = await dialog.prompt({ title: t("fcn.shell.renameDesign"), defaultValue: session.name || "", placeholder: t("fcn.shell.renamePlaceholder") });
    if (!name?.trim()) return;
    setBusy(session.id);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
      if (!response.ok) throw new Error((await response.json()).error || t("fcn.shell.renameFailed"));
      onSessionChanged(session.id, false);
    } catch (error) { await dialog.alert({ title: t("fcn.shell.renameError"), message: String(error) }); }
    finally { setBusy(null); }
  };
  const remove = async (session: SessionInfo) => {
    if (!await dialog.confirm({ title: t("fcn.shell.deleteDesign"), message: t("fcn.shell.deleteQuestion"), confirmLabel: t("fcn.shell.deleteRecord"), danger: true })) return;
    setBusy(session.id);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error || t("fcn.shell.deleteFailed"));
      onSessionChanged(session.id, true);
    } catch (error) { await dialog.alert({ title: t("fcn.shell.deleteError"), message: String(error) }); }
    finally { setBusy(null); }
  };
  return <>
    <div className="fcn-sidebar-brand"><FcnPilotIcon size={30} /><strong>FCNPilot</strong></div>
    <div className="fcn-sidebar-context" title={cwd ?? undefined}><strong>{t("fcn.shell.workspaceTitle")}</strong><span>{t("fcn.shell.workspaceSubtitle")}</span></div>
    <button className="fcn-new-design" type="button" disabled={!cwd} onClick={onNew}>{t("fcn.shell.newDesign")}</button>
    <div className="fcn-sidebar-tabs" role="tablist" aria-label={t("fcn.shell.sidebarNavigation")}>
      <button type="button" role="tab" aria-selected={tab === "sessions"} onClick={() => setTab("sessions")}>{t("fcn.shell.history")}</button>
      <button type="button" role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>{t("fcn.shell.files")}</button>
    </div>
    {selectingCircuit && <div className="ifcn-file-selection-note"><span>{t("fcn.shell.chooseInput")}</span><button type="button" onClick={onCancelCircuitSelection}>{t("fcn.shell.cancelSelection")}</button></div>}
    {tab === "sessions" ? <div className="fcn-session-list">
      <div className="fcn-session-search"><input type="search" placeholder={t("fcn.shell.searchDesigns")} aria-label={t("fcn.shell.searchDesigns")} value={filter} onChange={(event) => setFilter(event.target.value)} /><button type="button" onClick={onRefresh} aria-label={t("fcn.shell.refreshDesigns")}>↻</button></div>
      {shown.length === 0 && <p className="fcn-sidebar-empty">{filter ? t("fcn.shell.noMatches") : t("fcn.shell.noDesigns")}</p>}
      {shown.map((session) => <div key={session.id} className={`fcn-session-row${selectedId === session.id ? " active" : ""}`}>
        <button type="button" className="fcn-session-select" onClick={() => onSelect(session)} title={session.name || session.firstMessage || session.id}>
          <strong>{runningIds.has(session.id) && <i aria-label={t("fcn.shell.running")} />}{session.name || session.firstMessage?.slice(0, 60) || t("fcn.shell.unnamed")}</strong>
          <span>{session.parentSessionId ? t("fcn.shell.branchPrefix") : ""}{new Date(session.modified).toLocaleDateString(locale)} · {session.messageCount} {t("fcn.shell.messagesSuffix")}</span>
        </button>
        <div className="fcn-session-actions"><button type="button" disabled={busy === session.id || session.transient} onClick={() => void rename(session)} aria-label={t("fcn.shell.renameNamedDesign", { name: session.name || t("fcn.shell.design") })}>{t("fcn.shell.rename")}</button><button type="button" disabled={busy === session.id || runningIds.has(session.id) || session.transient} onClick={() => void remove(session)} aria-label={t("fcn.shell.deleteNamedDesign", { name: session.name || t("fcn.shell.design") })}>{t("fcn.shell.delete")}</button></div>
      </div>)}
    </div> : <div className="fcn-sidebar-files">
      <div className="fcn-file-tools">
        <button type="button" title={t("fcn.shell.createSource")} onClick={() => explorer.current?.createFile()}>{t("fcn.shell.newFile")}</button>
        <button type="button" title={t("fcn.shell.importFiles")} onClick={() => explorer.current?.openUploadPicker()}>{t("fcn.shell.import")}</button>
        <button type="button" title={t("fcn.shell.findFiles")} onClick={() => explorer.current?.toggleSearch()}>{t("fcn.shell.find")}</button>
        <button type="button" title={t("fcn.shell.collapseDirectories")} onClick={() => explorer.current?.collapseAll()}>{t("fcn.shell.collapse")}</button>
      </div>
      {cwd && <FileExplorer ref={explorer} cwd={cwd} accountUid={SHARED_ACCOUNT_IDENTITY.uid} onOpenFile={onOpenFile} onAtMention={onAtMention} onAtMentions={onAtMentions} onFileDeleted={onFileDeleted} onFileMoved={onFileMoved} refreshKey={fileRefresh} beforeFileMutation={beforeFileMutation} uiLanguage={locale === "zh-CN" ? "zh" : "en"} />}
    </div>}
  </>;
});
