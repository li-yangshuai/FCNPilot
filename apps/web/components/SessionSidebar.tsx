"use client";

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
  const [tab, setTab] = useState<"sessions" | "files">("sessions");
  const [filter, setFilter] = useState("");
  useEffect(() => { if (fileSelectionRequest) setTab("files"); }, [fileSelectionRequest]);
  const [busy, setBusy] = useState<string | null>(null);
  const explorer = useRef<FileExplorerHandle | null>(null);
  const dialog = useAppDialog();
  const shown = sessions.filter((session) => `${session.name || ""} ${session.firstMessage}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const rename = async (session: SessionInfo) => {
    const name = await dialog.prompt({ title: "重命名电路设计", defaultValue: session.name || "", placeholder: "例如：XOR 四相时钟布局" });
    if (!name?.trim()) return;
    setBusy(session.id);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
      if (!response.ok) throw new Error((await response.json()).error || "重命名失败");
      onSessionChanged(session.id, false);
    } catch (error) { await dialog.alert({ title: "无法修改设计名称", message: String(error) }); }
    finally { setBusy(null); }
  };
  const remove = async (session: SessionInfo) => {
    if (!await dialog.confirm({ title: "删除设计对话", message: "删除这条对话记录？电路运行产物仍保留在「版图与结果」。", confirmLabel: "删除记录", danger: true })) return;
    setBusy(session.id);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error || "删除失败");
      onSessionChanged(session.id, true);
    } catch (error) { await dialog.alert({ title: "无法删除设计对话", message: String(error) }); }
    finally { setBusy(null); }
  };
  return <>
    <div className="fcn-sidebar-brand"><FcnPilotIcon size={30} /><strong>FCNPilot</strong></div>
    <div className="fcn-sidebar-context" title={cwd ?? undefined}><strong>FCN 电路设计工作区</strong><span>组合 / 时序 · 版图 · 仿真与能耗</span></div>
    <button className="fcn-new-design" type="button" disabled={!cwd} onClick={onNew}>＋ 新建设计</button>
    <div className="fcn-sidebar-tabs" role="tablist" aria-label="电路工作区导航">
      <button type="button" role="tab" aria-selected={tab === "sessions"} onClick={() => setTab("sessions")}>设计记录</button>
      <button type="button" role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>电路文件</button>
    </div>
    {selectingCircuit && <div className="ifcn-file-selection-note"><span>选择 .v / .sv 文件作为电路输入</span><button type="button" onClick={onCancelCircuitSelection}>取消选择</button></div>}
    {tab === "sessions" ? <div className="fcn-session-list">
      <div className="fcn-session-search"><input type="search" placeholder="查找电路设计" aria-label="查找电路设计" value={filter} onChange={(event) => setFilter(event.target.value)} /><button type="button" onClick={onRefresh} aria-label="刷新设计记录">↻</button></div>
      {shown.length === 0 && <p className="fcn-sidebar-empty">{filter ? "没有匹配的电路设计。" : "新建设计，描述你的电路或提供 Verilog 文件。"}</p>}
      {shown.map((session) => <div key={session.id} className={`fcn-session-row${selectedId === session.id ? " active" : ""}`}>
        <button type="button" className="fcn-session-select" onClick={() => onSelect(session)} title={session.name || session.firstMessage || session.id}>
          <strong>{runningIds.has(session.id) && <i aria-label="设计进行中" />}{session.name || session.firstMessage?.slice(0, 60) || "未命名电路设计"}</strong>
          <span>{session.parentSessionId ? "分支设计 · " : ""}{new Date(session.modified).toLocaleDateString("zh-CN")} · {session.messageCount} 条记录</span>
        </button>
        <div className="fcn-session-actions"><button type="button" disabled={busy === session.id || session.transient} onClick={() => void rename(session)} aria-label={`重命名 ${session.name || "电路设计"}`}>重命名</button><button type="button" disabled={busy === session.id || runningIds.has(session.id) || session.transient} onClick={() => void remove(session)} aria-label={`删除 ${session.name || "电路设计"}`}>删除</button></div>
      </div>)}
    </div> : <div className="fcn-sidebar-files">
      <div className="fcn-file-tools">
        <button type="button" title="新建电路源文件" onClick={() => explorer.current?.createFile()}>＋ 文件</button>
        <button type="button" title="导入 Verilog 与电路文件" onClick={() => explorer.current?.openUploadPicker()}>导入</button>
        <button type="button" title="查找电路文件" onClick={() => explorer.current?.toggleSearch()}>查找</button>
        <button type="button" title="收起电路目录" onClick={() => explorer.current?.collapseAll()}>收起</button>
      </div>
      {cwd && <FileExplorer ref={explorer} cwd={cwd} accountUid={SHARED_ACCOUNT_IDENTITY.uid} onOpenFile={onOpenFile} onAtMention={onAtMention} onAtMentions={onAtMentions} onFileDeleted={onFileDeleted} onFileMoved={onFileMoved} refreshKey={fileRefresh} beforeFileMutation={beforeFileMutation} uiLanguage="zh" />}
    </div>}
  </>;
});
