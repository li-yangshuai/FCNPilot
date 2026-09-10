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
  const { locale, setLocale, t } = useI18n();
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
    if (optimizationPendingRef.current || !handle?.ready) throw new Error(t("fcn.shell.agentNotReady"));
    const prompt = buildIfcnOptimizationPrompt(run, locale);
    optimizationPendingRef.current = true;
    setView("design"); setFilePanel(false); setError(null);
    try { await handle.sendPrompt(prompt); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { optimizationPendingRef.current = false; }
  }, [locale, t]);

  useEffect(() => { document.title = t("fcn.shell.pageTitle"); }, [t]);
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
        if (!info || !isWithinFcnWorkspace(info.cwd, cwd)) throw new Error(t("fcn.shell.wrongWorkspace"));
        setSelected(info);
        setChatKey((key) => key + 1);
        setError(null);
      }).catch((failure) => {
        if (!controller.signal.aborted) { setSelected(null); setError(String(failure.message || failure)); }
      }).finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [cwd, requestedSession, t]);

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
    if (!/\.(?:v|sv)$/i.test(path)) { setError(t("fcn.shell.chooseVerilog")); return; }
    if (filesRef.current.some((file) => file.path === path && file.dirty)) { setError(t("fcn.shell.saveBeforeInput")); return; }
    setCircuitSelection({ path, token: Date.now() }); setSelectingCircuit(false); setView("design"); setFilePanel(false); setSidebar(false); setError(null);
  }, [t]);
  const openFile = useCallback((path: string) => {
    if (selectingCircuit) { chooseCircuitFile(path); return; }
    setFiles((current) => current.some((file) => file.path === path) ? current : [...current, { path, dirty: false }]);
    setActiveFile(path); setFilePanel(true); setSidebar(false);
  }, [selectingCircuit, chooseCircuitFile]);
  const closeFile = useCallback(async (path: string) => {
    const file = files.find((item) => item.path === path);
    if (file?.dirty && !await dialog.confirm({ title: t("fcn.shell.closeFile"), message: t("fcn.shell.discardQuestion"), confirmLabel: t("fcn.shell.discard"), danger: true })) return;
    const next = files.filter((item) => item.path !== path);
    setFiles(next);
    if (activeFile === path) setActiveFile(next.at(-1)?.path ?? null);
    if (!next.length) setFilePanel(false);
  }, [activeFile, dialog, files, t]);
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
    await dialog.alert({ title: t("fcn.shell.unsavedFile"), message: t("fcn.shell.saveBeforeMutation", { name: getFileName(unsaved.path) }) });
    return false;
  }, [dialog, t]);

  const trustProject = async () => {
    if (!cwd || trustBusy) return;
    setTrustBusy(true); setTrustError(null);
    try {
      const response = await fetch("/api/project-trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("fcn.shell.enableFailed"));
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
        <button type="button" className="fcn-language-toggle" onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")} aria-label={t("fcn.shell.switchLanguage")}>{locale === "zh-CN" ? "English" : "简体中文"}</button>
        <button type="button" onClick={() => setModelsOpen(true)}>{t("fcn.shell.model")}</button>
        <button type="button" onClick={() => toggleTheme()} aria-label={t("fcn.shell.switchTheme")}>{isDark ? t("fcn.shell.light") : t("fcn.shell.dark")}</button>
      </div>
    </aside>
    {sidebar && <button className="fcn-mobile-backdrop" aria-label={t("fcn.shell.hideSidebar")} onClick={() => setSidebar(false)} />}
    <main className="fcn-main-workspace">
      <IfcnWorkspaceBar workspace={workspace} onNewDesign={newDesign} />
      <nav className="ifcn-workbench-nav" aria-label={t("fcn.shell.workspaceNavigation")}>
        <button type="button" className="fcn-mobile-menu" onClick={() => setSidebar((open) => !open)} aria-label={t("fcn.shell.openSidebar")}>☰</button>
        <button type="button" aria-pressed={view === "design"} onClick={() => setView("design")}><span aria-hidden>01</span> {t("fcn.shell.designTab")}</button>
        <button type="button" aria-pressed={view === "results"} onClick={() => { setView("results"); setFilePanel(false); }}><span aria-hidden>02</span> {t("fcn.shell.resultsTab")}</button>
        <button type="button" aria-pressed={view === "algorithms"} onClick={() => { setView("algorithms"); setFilePanel(false); }}>{t("fcn.shell.algorithmsTab")}</button>
        {files.length > 0 && <button type="button" className="fcn-reopen-file" onClick={() => setFilePanel((open) => !open)}>{t("fcn.shell.filesCountPrefix")}{files.length}</button>}
      </nav>
      {workspace?.requiresTrust && !workspace.trusted && <div className="fcn-workspace-notice"><span>{t("fcn.shell.trustNotice")}</span><button type="button" onClick={() => setTrustOpen(true)}>{t("fcn.shell.enableEngine")}</button></div>}
      {error && <div className="fcn-workspace-notice" role="alert">{error}</div>}
      <div className="fcn-design-view" style={{ display: view === "design" ? "flex" : "none" }} aria-hidden={view !== "design"}>
        {cwd && !restoring ? <ChatWindow key={chatKey} session={selected} sessionRunning={!!selected && running.has(selected.id)}
          newSessionCwd={cwd} newSessionDraftKey={draftKey} ifcnWorkspace={workspace} onMainAgentHandleChange={onMainAgentHandleChange}
          circuitSourceSelection={circuitSelection} onChooseCircuitFile={() => { setSelectingCircuit(true); setFileSelectionRequest((value) => value + 1); setSidebar(true); setFilePanel(false); }} onShowAlgorithmReference={() => { setView("algorithms"); setFilePanel(false); }}
          accountUid={SHARED_ACCOUNT_IDENTITY.uid} uiLanguage={locale === "zh-CN" ? "zh" : "en"}
          chatInputRef={chatInputRef} modelsRefreshKey={modelsRefresh} onSessionCreated={onSessionCreated}
          onSessionForked={onSessionForked} onAgentEnd={onAgentEnd} onOpenFile={openFile} />
          : <p className="fcn-loading" role="status">{restoring ? t("fcn.shell.loadingDesign") : t("fcn.shell.connecting")}</p>}
      </div>
      {view === "results" && <div className="ifcn-results-workspace"><IfcnResults active capabilities={workspace?.capabilities} onOptimizeRun={startLayoutOptimization} optimizationReady={optimizationReady && !restoring} onShowAlgorithms={() => setView("algorithms")} /></div>}
      {view === "algorithms" && <div className="ifcn-results-workspace"><IfcnAlgorithms workspace={workspace} onRefresh={() => setCatalogRefresh((value) => value + 1)} /></div>}
    </main>
    {files.length > 0 && <aside className={`fcn-file-panel${filePanel ? "" : " is-hidden"}`} aria-label={t("fcn.shell.filePanel")}>
      <div className="fcn-file-tabs">
        {files.map((file) => <div key={file.path} className={activeFile === file.path ? "active" : ""}>
          <button type="button" onClick={() => setActiveFile(file.path)} title={file.path}>{file.dirty ? "● " : ""}{getFileName(file.path)}</button>
          <button type="button" onClick={() => void closeFile(file.path)} aria-label={t("fcn.shell.closeNamedFile", { name: getFileName(file.path) })}>×</button>
        </div>)}
        <button type="button" className="fcn-file-hide" onClick={() => setFilePanel(false)} aria-label={t("fcn.shell.hidePreview")}>{t("fcn.shell.collapse")}</button>
      </div>
      {files.map((file) => <div key={file.path} className="fcn-file-content" style={{ display: activeFile === file.path ? "flex" : "none" }}>
        <FileViewer filePath={file.path} cwd={cwd ?? undefined} accountUid={SHARED_ACCOUNT_IDENTITY.uid} uiLanguage={locale === "zh-CN" ? "zh" : "en"}
          active={filePanel && activeFile === file.path} onDirtyChange={dirtyChanged} onOpenFile={openFile} onAtMention={mention}
          onMentionLines={(path, start, end) => { setView("design"); chatInputRef.current?.insertText(buildFileLineMentionText(path, start, end)); }} />
      </div>)}
      {activeFile && /\.(?:v|sv)$/i.test(activeFile) && <button type="button" className="ifcn-use-circuit-file" disabled={files.some((file) => file.path === activeFile && file.dirty)} onClick={() => chooseCircuitFile(activeFile)}>{t("fcn.shell.useFile")}</button>}
      {activeFile && <div className="fcn-file-path" title={activeFile}>{cwd ? getRelativeFilePath(activeFile, cwd) : activeFile}</div>}
    </aside>}
    {modelsOpen && <ModelsConfig onClose={() => { setModelsOpen(false); setModelsRefresh((value) => value + 1); }} />}
    {trustOpen && cwd && <ProjectTrustDialog cwd={cwd} busy={trustBusy} error={trustError} onCancel={() => setTrustOpen(false)} onConfirm={() => void trustProject()} />}
  </div>;
}
