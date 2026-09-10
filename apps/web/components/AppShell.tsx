"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatWindow, type IfcnMainAgentHandle } from "./ChatWindow";
import { buildIfcnOptimizationPrompt } from "@/lib/ifcn-optimization-request";
import type { IfcnRunDetail } from "@/lib/ifcn-results-types";
import { SessionSidebar } from "./SessionSidebar";
import { IfcnWorkspaceBar, useIfcnWorkspace } from "./IfcnWorkspace";
import { IfcnResults } from "./IfcnResults";
import { IfcnAlgorithms } from "./IfcnAlgorithms";
import { FileViewer } from "./FileViewer";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { useAppDialog } from "./AppDialogProvider";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionInfo } from "@/lib/types";
import { isWithinFcnWorkspace, sessionsForFcnWorkspace } from "@/lib/fcn-workspace-scope";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { SHARED_ACCOUNT_IDENTITY } from "@/lib/shared-workspace";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useViewportHeight } from "@/hooks/useViewportHeight";

const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig));

type CircuitFile = { path: string; dirty: boolean };

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

export function AppShell({ defaultCwd = null }: { defaultCwd?: string | null }) {
  useViewportHeight();
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useAppDialog();
  const { toggleTheme, isDark } = useTheme();
  const { locale } = useI18n();
  const [refresh, setRefresh] = useState(0);
  const [modelsRefresh, setModelsRefresh] = useState(0);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const workspace = useIfcnWorkspace(`${modelsRefresh}:${catalogRefresh}`);
  const cwd = workspace?.cwd || defaultCwd;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"design" | "results" | "algorithms">("design");
  const [sidebar, setSidebar] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [draftId, setDraftId] = useState("initial");
  const draftKey = cwd ? `new:${draftId}:${cwd}` : null;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const mainAgentHandleRef = useRef<IfcnMainAgentHandle | null>(null);
  const optimizationPendingRef = useRef(false);
  const [optimizationReady, setOptimizationReady] = useState(false);
  const onMainAgentHandleChange = useCallback((handle: IfcnMainAgentHandle | null) => {
    mainAgentHandleRef.current = handle;
    setOptimizationReady(handle?.ready === true);
  }, []);

  const [files, setFiles] = useState<CircuitFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [filePanel, setFilePanel] = useState(false);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [selectingCircuit, setSelectingCircuit] = useState(false);
  const [fileSelectionRequest, setFileSelectionRequest] = useState(0);
  const [circuitSelection, setCircuitSelection] = useState<{ path: string; token: number } | null>(null);
  const requestedSession = searchParams.get("session");

  const startLayoutOptimization = useCallback(async (run: IfcnRunDetail) => {
    const handle = mainAgentHandleRef.current;
    if (optimizationPendingRef.current || !handle?.ready) throw new Error("主智能体正在运行或尚未就绪，请稍后重试。");
    const prompt = buildIfcnOptimizationPrompt(run);
    optimizationPendingRef.current = true;
    setView("design"); setFilePanel(false); setError(null);
    try { await handle.sendPrompt(prompt); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { optimizationPendingRef.current = false; }
  }, []);

  useEffect(() => { document.title = "FCNPilot · FCN 电路设计"; }, []);
  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();
    void readJson<{ sessions: SessionInfo[] }>(refresh ? "/api/sessions?force=1" : "/api/sessions", controller.signal)
      .then((data) => {
        setSessions(sessionsForFcnWorkspace(data.sessions, cwd));
        setError(null);
      }).catch((failure) => { if (!controller.signal.aborted) setError(String(failure.message || failure)); });
    return () => controller.abort();
  }, [cwd, refresh]);

  // A URL can restore only a design from this circuit workspace.
  useEffect(() => {
    if (!cwd || !requestedSession || selectedRef.current?.id === requestedSession) { setRestoring(false); return; }
    const controller = new AbortController();
    setRestoring(true);
    void readJson<{ info: SessionInfo }>(`/api/sessions/${encodeURIComponent(requestedSession)}`, controller.signal)
      .then(({ info }) => {
        if (controller.signal.aborted) return;
        if (!info || !isWithinFcnWorkspace(info.cwd, cwd)) throw new Error("这个记录不属于当前 FCN 电路工作区。");
        setSelected(info);
        setChatKey((key) => key + 1);
        setError(null);
      }).catch((failure) => {
        if (!controller.signal.aborted) { setSelected(null); setError(String(failure.message || failure)); }
      }).finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [cwd, requestedSession]);

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (document.hidden || controller) return;
      controller = new AbortController();
      try {
        const data = await readJson<{ runningSessionIds: string[] }>("/api/agent/running", controller.signal);
        if (!stopped) setRunning(new Set(data.runningSessionIds));
      } catch { /* A transient disconnect is handled by the active design stream. */ }
      finally { controller = null; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    document.addEventListener("visibilitychange", poll);
    return () => { stopped = true; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, []);

  const selectSession = useCallback((session: SessionInfo) => {
    if (!cwd || !isWithinFcnWorkspace(session.cwd, cwd)) return;
    if (selectedRef.current?.id !== session.id) { setSelected(session); setChatKey((key) => key + 1); }
    setRestoring(false); setView("design"); setSidebar(false); setError(null); setCircuitSelection(null); setSelectingCircuit(false);
    router.replace(`/?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [cwd, router]);

  const newDesign = useCallback(() => {
    setSelected(null); setDraftId(crypto.randomUUID()); setChatKey((key) => key + 1);
    setRestoring(false); setView("design"); setSidebar(false); setError(null); setCircuitSelection(null); setSelectingCircuit(false);
    router.replace("/", { scroll: false });
  }, [router]);

  const onSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefresh((value) => value + 1);
    // A delayed creation response must not replace a different design.
    if (sourceDraftKey !== draftKeyRef.current || selectedRef.current) return;
    setSelected(session);
    router.replace(`/?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  const onSessionForked = useCallback((id: string) => {
    setRefresh((value) => value + 1);
    router.replace(`/?session=${encodeURIComponent(id)}`, { scroll: false });
  }, [router]);

  const onAgentEnd = useCallback(() => {
    setRefresh((value) => value + 1); setFileRefresh((value) => value + 1);
  }, []);

  const chooseCircuitFile = useCallback((path: string) => {
    if (!/\.(?:v|sv)$/i.test(path)) { setError("请选择 .v 或 .sv 电路文件。"); return; }
    if (filesRef.current.some((file) => file.path === path && file.dirty)) { setError("该电路文件还有未保存修改，请先保存后再作为输入。"); return; }
    setCircuitSelection({ path, token: Date.now() }); setSelectingCircuit(false); setView("design"); setFilePanel(false); setSidebar(false); setError(null);
  }, []);
  const openFile = useCallback((path: string) => {
    if (selectingCircuit) { chooseCircuitFile(path); return; }
    setFiles((current) => current.some((file) => file.path === path) ? current : [...current, { path, dirty: false }]);
    setActiveFile(path); setFilePanel(true); setSidebar(false);
  }, [selectingCircuit, chooseCircuitFile]);
  const closeFile = useCallback(async (path: string) => {
    const file = files.find((item) => item.path === path);
    if (file?.dirty && !await dialog.confirm({ title: "关闭电路文件", message: "文件有尚未保存的修改。确认放弃这些修改并关闭？", confirmLabel: "放弃修改", danger: true })) return;
    const next = files.filter((item) => item.path !== path);
    setFiles(next);
    if (activeFile === path) setActiveFile(next.at(-1)?.path ?? null);
    if (!next.length) setFilePanel(false);
  }, [activeFile, dialog, files]);
  const dirtyChanged = useCallback((path: string, dirty: boolean) => {
    setFiles((current) => current.map((file) => file.path === path ? { ...file, dirty } : file));
  }, []);
  const mention = useCallback((path: string, isDir: boolean) => {
    setView("design"); chatInputRef.current?.insertText(buildAtMentionText(path, isDir));
    setFilePanel(false); setSidebar(false);
  }, []);
  const mentions = useCallback((paths: string[]) => {
    setView("design"); chatInputRef.current?.insertText(buildFileAtMentionsText(paths)); setSidebar(false);
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (files.some((file) => file.dirty)) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [files]);

  const beforeFileMutation = useCallback(async (paths: string[]) => {
    const unsaved = filesRef.current.find((file) => file.dirty && paths.some((path) => file.path === path || file.path.startsWith(path + "/")));
    if (!unsaved) return true;
    await dialog.alert({ title: "电路文件尚未保存", message: `请先保存 ${getFileName(unsaved.path)}，再移动、重命名或删除文件。` });
    return false;
  }, [dialog]);

  const trustProject = async () => {
    if (!cwd || trustBusy) return;
    setTrustBusy(true); setTrustError(null);
    try {
      const response = await fetch("/api/project-trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法启用电路引擎");
      setTrustOpen(false); setModelsRefresh((value) => value + 1); setChatKey((key) => key + 1);
    } catch (failure) { setTrustError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setTrustBusy(false); }
  };

  return <div className="fcn-app-shell">
    <aside className={`fcn-sidebar${sidebar ? " is-open" : ""}`}>
      <SessionSidebar fileSelectionRequest={fileSelectionRequest} selectingCircuit={selectingCircuit} onCancelCircuitSelection={() => setSelectingCircuit(false)} cwd={cwd} sessions={sessions} selectedId={selected?.id ?? null} runningIds={running}
        onSelect={selectSession} onNew={newDesign} onRefresh={() => setRefresh((value) => value + 1)}
        onSessionChanged={(id, deleted) => { setRefresh((value) => value + 1); if (deleted && selected?.id === id) newDesign(); }}
        onOpenFile={openFile} onAtMention={mention} onAtMentions={mentions} fileRefresh={fileRefresh} beforeFileMutation={beforeFileMutation}
        onFileDeleted={(path, directory) => { setFiles((current) => current.filter((file) => file.path !== path && !(directory && file.path.startsWith(path + "/")))); if (activeFile === path || (directory && activeFile?.startsWith(path + "/"))) setActiveFile(null); }}
        onFileMoved={(previous, next, directory) => { const move = (path: string) => path === previous ? next : directory && path.startsWith(previous + "/") ? next + path.slice(previous.length) : path; setFiles((current) => current.map((file) => ({ ...file, path: move(file.path) }))); setActiveFile((path) => path ? move(path) : null); }} />
      <div className="fcn-sidebar-settings">
        <button type="button" onClick={() => setModelsOpen(true)}>主智能体模型</button>
        <button type="button" onClick={() => toggleTheme()} aria-label="切换界面主题">{isDark ? "浅色" : "深色"}</button>
      </div>
    </aside>
    {sidebar && <button className="fcn-mobile-backdrop" aria-label="收起电路侧栏" onClick={() => setSidebar(false)} />}
    <main className="fcn-main-workspace">
      <IfcnWorkspaceBar workspace={workspace} onNewDesign={newDesign} />
      <nav className="ifcn-workbench-nav" aria-label="FCN 设计工作区">
        <button type="button" className="fcn-mobile-menu" onClick={() => setSidebar((open) => !open)} aria-label="打开电路侧栏">☰</button>
        <button type="button" aria-pressed={view === "design"} onClick={() => setView("design")}><span aria-hidden>01</span> 电路设计</button>
        <button type="button" aria-pressed={view === "results"} onClick={() => { setView("results"); setFilePanel(false); }}><span aria-hidden>02</span> 版图与结果</button>
        <button type="button" aria-pressed={view === "algorithms"} onClick={() => { setView("algorithms"); setFilePanel(false); }}>算法与规模参考</button>
        {files.length > 0 && <button type="button" className="fcn-reopen-file" onClick={() => setFilePanel((open) => !open)}>电路文件 · {files.length}</button>}
      </nav>
      {workspace?.requiresTrust && !workspace.trusted && <div className="fcn-workspace-notice"><span>首次使用需要确认启用当前电路工程。</span><button type="button" onClick={() => setTrustOpen(true)}>启用 iFCN 引擎</button></div>}
      {error && <div className="fcn-workspace-notice" role="alert">{error}</div>}
      <div className="fcn-design-view" style={{ display: view === "design" ? "flex" : "none" }} aria-hidden={view !== "design"}>
        {cwd && !restoring ? <ChatWindow key={chatKey} session={selected} sessionRunning={!!selected && running.has(selected.id)}
          newSessionCwd={cwd} newSessionDraftKey={draftKey} ifcnWorkspace={workspace} onMainAgentHandleChange={onMainAgentHandleChange}
          circuitSourceSelection={circuitSelection} onChooseCircuitFile={() => { setSelectingCircuit(true); setFileSelectionRequest((value) => value + 1); setSidebar(true); setFilePanel(false); }} onShowAlgorithmReference={() => { setView("algorithms"); setFilePanel(false); }}
          accountUid={SHARED_ACCOUNT_IDENTITY.uid} uiLanguage={locale === "zh-CN" ? "zh" : "en"}
          chatInputRef={chatInputRef} modelsRefreshKey={modelsRefresh} onSessionCreated={onSessionCreated}
          onSessionForked={onSessionForked} onAgentEnd={onAgentEnd} onOpenFile={openFile} />
          : <p className="fcn-loading" role="status">{restoring ? "正在读取电路设计…" : "正在连接 iFCN 电路工程…"}</p>}
      </div>
      {view === "results" && <div className="ifcn-results-workspace"><IfcnResults active capabilities={workspace?.capabilities} onOptimizeRun={startLayoutOptimization} optimizationReady={optimizationReady && !restoring} onShowAlgorithms={() => setView("algorithms")} /></div>}
      {view === "algorithms" && <div className="ifcn-results-workspace"><IfcnAlgorithms workspace={workspace} onRefresh={() => setCatalogRefresh((value) => value + 1)} /></div>}
    </main>
    {files.length > 0 && <aside className={`fcn-file-panel${filePanel ? "" : " is-hidden"}`} aria-label="电路文件编辑与预览">
      <div className="fcn-file-tabs">
        {files.map((file) => <div key={file.path} className={activeFile === file.path ? "active" : ""}>
          <button type="button" onClick={() => setActiveFile(file.path)} title={file.path}>{file.dirty ? "● " : ""}{getFileName(file.path)}</button>
          <button type="button" onClick={() => void closeFile(file.path)} aria-label={`关闭 ${getFileName(file.path)}`}>×</button>
        </div>)}
        <button type="button" className="fcn-file-hide" onClick={() => setFilePanel(false)} aria-label="收起电路文件预览">收起</button>
      </div>
      {files.map((file) => <div key={file.path} className="fcn-file-content" style={{ display: activeFile === file.path ? "flex" : "none" }}>
        <FileViewer filePath={file.path} cwd={cwd ?? undefined} accountUid={SHARED_ACCOUNT_IDENTITY.uid}
          active={filePanel && activeFile === file.path} onDirtyChange={dirtyChanged} onOpenFile={openFile} onAtMention={mention}
          onMentionLines={(path, start, end) => { setView("design"); chatInputRef.current?.insertText(buildFileLineMentionText(path, start, end)); }} />
      </div>)}
      {activeFile && /\.(?:v|sv)$/i.test(activeFile) && <button type="button" className="ifcn-use-circuit-file" disabled={files.some((file) => file.path === activeFile && file.dirty)} onClick={() => chooseCircuitFile(activeFile)}>使用此文件设计 ↗</button>}
      {activeFile && <div className="fcn-file-path" title={activeFile}>{cwd ? getRelativeFilePath(activeFile, cwd) : activeFile}</div>}
    </aside>}
    {modelsOpen && <ModelsConfig onClose={() => { setModelsOpen(false); setModelsRefresh((value) => value + 1); }} />}
    {trustOpen && cwd && <ProjectTrustDialog cwd={cwd} busy={trustBusy} error={trustError} onCancel={() => setTrustOpen(false)} onConfirm={() => void trustProject()} />}
  </div>;
}
