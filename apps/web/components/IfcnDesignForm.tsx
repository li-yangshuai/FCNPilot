"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { buildIfcnDesignPrompt, loadIfcnSourceDraft, ifcnDesignAlgorithms, ifcnSnapshotName, validateIfcnSource, type IfcnClockChoice, type IfcnDesignRequest, type IfcnInputMode } from "@/lib/ifcn-design-request";
import type { IfcnWorkspaceInfo } from "./IfcnWorkspace";
import { FcnPilotIcon } from "./FcnPilotIcon";

const CircuitEditor = dynamic(() => import("./MonacoCodeEditor").then((module) => module.MonacoCodeEditor), { ssr: false, loading: CircuitEditorLoading });
function CircuitEditorLoading() {
  const { t } = useI18n();
  return <p className="ifcn-design-hint">{t("fcn.design.loadingEditor")}</p>;
}

interface Draft extends IfcnDesignRequest { source: string; name: string; path: string; }
const INITIAL: Draft = { mode: "auto", clock: "irregular", algorithm: "auto", until: "map", note: "", source: "", name: "circuit.v", path: "" };
const EXAMPLES = { combinational: "module xor2(input a, input b, output y);\n  assign y = a ^ b;\nendmodule\n", sequential: "module toggle_ff(input clk, input en, output reg q);\n  always @(posedge clk)\n    if (en) q <= ~q;\nendmodule\n" };

export function IfcnDesignForm({ workspace, cwd, draftKey, busy, selection, onChooseFile, onSubmit, onCancel, onReference }: {
  workspace: IfcnWorkspaceInfo | null; cwd: string; draftKey: string; busy: boolean;
  selection?: { path: string; token: number } | null;
  onChooseFile?: () => void; onSubmit: (prompt: string) => Promise<void>; onCancel?: () => void; onReference?: () => void;
}) {
  const { isDark } = useTheme();
  const { locale, t } = useI18n();
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const readController = useRef<AbortController | null>(null);
  const submitLock = useRef(false);
  const sourceRef = useRef(draft.source); sourceRef.current = draft.source;
  const storageKey = `fcn-design:${draftKey}`;
  useEffect(() => {
    try { const value = JSON.parse(sessionStorage.getItem(storageKey) || "null"); if (value && typeof value.source === "string") setDraft({ ...INITIAL, source: value.source,
      name: typeof value.name === "string" ? value.name : INITIAL.name, path: typeof value.path === "string" ? value.path : "", note: typeof value.note === "string" ? value.note : "",
      mode: ["auto", "combinational", "sequential"].includes(value.mode) ? value.mode : INITIAL.mode,
      clock: ["2DDWave", "USE", "RES", "irregular"].includes(value.clock) ? value.clock : INITIAL.clock,
      algorithm: typeof value.algorithm === "string" ? value.algorithm : "auto", until: ["map", "simulate", "energy"].includes(value.until) ? value.until : "map" }); else setDraft(INITIAL); } catch { setDraft(INITIAL); }
    setLoadedKey(storageKey);
  }, [storageKey]);
  useEffect(() => {
    if (loadedKey !== storageKey) return;
    const timer = window.setTimeout(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* The editor buffer remains usable if browser storage is full. */ } }, 200);
    return () => window.clearTimeout(timer);
  }, [draft, loadedKey, storageKey]);
  useEffect(() => () => readController.current?.abort(), []);
  const update = (patch: Partial<Draft>) => { setDraft((value) => ({ ...value, ...patch })); setSavedPath(null); setError(null); };
  const algorithms = useMemo(() => ifcnDesignAlgorithms(workspace?.capabilities, draft.mode, draft.clock, locale), [workspace?.capabilities, draft.mode, draft.clock, locale]);
  const algorithm = algorithms.some((item) => item.id === draft.algorithm) ? draft.algorithm : "auto";
  const locked = busy || saving || reading;
  const readSource = async (value: string) => {
    const path = value.trim().startsWith("/") ? value.trim() : `${cwd.replace(/\/$/, "")}/${value.trim()}`;
    if (!/\.(?:v|sv)$/i.test(path) || !(path === cwd || path.startsWith(cwd.replace(/\/$/, "") + "/")) || path.split("/").includes("..")) { setError(t("fcn.design.chooseWorkspaceFile")); return; }
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setReading(true); setError(null);
    try {
      const response = await fetch(`/api/files/${encodeFilePathForApi(path)}?type=read`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok || typeof data.content !== "string") throw new Error(data.error || t("fcn.design.readFailed"));
      validateIfcnSource(data.content, locale);
      if (!controller.signal.aborted) { setDraft((current) => loadIfcnSourceDraft(current, { source: data.content, name: getFileName(path), path })); setSavedPath(null); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (!controller.signal.aborted) setReading(false); }
  };
  const readSourceRef = useRef(readSource); readSourceRef.current = readSource;
  useEffect(() => { if (selection) void readSourceRef.current(selection.path); }, [selection]);
  const submit = async () => {
    if (locked || submitLock.current) return;
    submitLock.current = true; setSaving(true); setError(null);
    try {
      validateIfcnSource(sourceRef.current, locale);
      if (!workspace?.available || !algorithms.length) throw new Error(t("fcn.design.noImplementationError"));
      const name = ifcnSnapshotName(draft.name, crypto.randomUUID());
      const response = await fetch(`/api/files/${encodeFilePathForApi(cwd)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, kind: "file", content: sourceRef.current }) });
      const result = await response.json();
      if (!response.ok || typeof result.path !== "string") throw new Error(result.error || t("fcn.design.saveFailed"));
      const expected = `${cwd.replace(/\/$/, "")}/${name}`;
      if (result.path !== expected) throw new Error(t("fcn.design.pathMismatch"));
      setSavedPath(result.path);
      try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Snapshot is already durable. */ }
      await onSubmit(buildIfcnDesignPrompt(result.path, { ...draft, algorithm }, locale));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { submitLock.current = false; setSaving(false); }
  };
  return <section className="ifcn-design-form" aria-label={t("fcn.design.inputLabel")}>
    <header><div className="ifcn-design-title"><FcnPilotIcon size={34} /><div><span>FCNPilot</span><h1>{t("fcn.design.title")}</h1></div></div>{onCancel && <button type="button" className="ifcn-design-text-button" onClick={onCancel}>{t("fcn.design.back")}</button>}</header>
    <p className="ifcn-design-intro">{t("fcn.design.intro")}</p>
    <div className="ifcn-design-section-heading"><h2><span>01</span> {t("fcn.design.inputHeading")}</h2><div>{onChooseFile && <button type="button" onClick={onChooseFile} disabled={locked}>{t("fcn.design.chooseFile")}</button>}<button type="button" disabled={locked} onClick={() => update({ source: EXAMPLES.combinational, name: "xor2.v", path: "", mode: "combinational", algorithm: "auto" })}>{t("fcn.design.xorExample")}</button><button type="button" disabled={locked} onClick={() => update({ source: EXAMPLES.sequential, name: "toggle_ff.v", path: "", mode: "sequential", clock: "irregular", algorithm: "auto" })}>{t("fcn.design.feedbackExample")}</button></div></div>
    <div className="ifcn-design-path"><input aria-label={t("fcn.design.pathLabel")} placeholder={t("fcn.design.pathPlaceholder")} value={draft.path} disabled={locked} onChange={(event) => update({ path: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void readSource(draft.path); } }} /><button type="button" onClick={() => void readSource(draft.path)} disabled={locked || !draft.path.trim()}>{reading ? t("fcn.design.reading") : t("fcn.design.read")}</button></div>
    <div className="ifcn-circuit-editor"><CircuitEditor filePath={`inmemory://fcn-design/${encodeURIComponent(draftKey)}.v`} language="verilog" value={draft.source} onChange={(source) => update({ source })} onSave={() => { try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Keep the current editor buffer. */ } }} isDark={isDark} wrapLines fontSize={13} uiLanguage={locale === "zh-CN" ? "zh" : "en"} readOnly={locked} /></div>
    <div className="ifcn-design-source-meta"><label>{t("fcn.design.namePrefix")}<input value={draft.name} aria-label={t("fcn.design.name")} disabled={locked} onChange={(event) => update({ name: event.target.value })} /></label><span>{t("fcn.design.snapshotNote")}</span></div>
    <div className="ifcn-design-settings"><section><h2><span>02</span> {t("fcn.design.modeHeading")}</h2><div className="ifcn-design-mode-options" role="group" aria-label={t("fcn.design.modeLabel")}>{([{ id: "auto", label: t("fcn.design.auto") }, { id: "combinational", label: t("fcn.design.combinational") }, { id: "sequential", label: t("fcn.design.sequential") }] as const).map((item) => <button type="button" key={item.id} disabled={locked} aria-pressed={draft.mode === item.id} onClick={() => update({ mode: item.id as IfcnInputMode, algorithm: "auto", ...(item.id === "sequential" ? { clock: "irregular" as IfcnClockChoice } : {}) })}>{item.label}</button>)}</div><p className="ifcn-design-hint">{draft.mode === "sequential" ? t("fcn.design.sequentialHint") : draft.mode === "auto" ? t("fcn.design.autoHint") : t("fcn.design.combinationalHint")}</p></section>
      <section><h2><span>03</span> {t("fcn.design.clockHeading")}</h2><div className="ifcn-design-clock-options"><button type="button" disabled={locked || draft.mode === "sequential"} aria-pressed={draft.clock !== "irregular"} onClick={() => update({ clock: "2DDWave", algorithm: "auto" })}><strong>{t("fcn.design.regularClock")}</strong><span>{t("fcn.design.regularClockHint")}</span></button><button type="button" disabled={locked} aria-pressed={draft.clock === "irregular"} onClick={() => update({ clock: "irregular", algorithm: "auto" })}><strong>{t("fcn.design.irregularClock")}</strong><span>{t("fcn.design.irregularClockHint")}</span></button></div>{draft.clock !== "irregular" && <div className="ifcn-template-options" role="group" aria-label={t("fcn.design.regularClock")}>{(["2DDWave", "USE", "RES"] as const).map((clock) => <button type="button" key={clock} disabled={locked} aria-pressed={draft.clock === clock} onClick={() => update({ clock, algorithm: "auto" })}>{clock}</button>)}</div>}</section></div>
    <div className="ifcn-design-scope"><strong>{t("fcn.design.scalePending")}</strong><span>{draft.clock !== "irregular" ? t("fcn.design.regularScope") : draft.mode === "sequential" ? t("fcn.design.sequentialScope") : t("fcn.design.combinationalScope")} {t("fcn.design.stateCountNote")}</span></div>
    <details className="ifcn-design-implementation"><summary>{t("fcn.design.implementationSummary")}</summary><label>{t("fcn.design.implementationLabel")}<select value={algorithm} disabled={locked || draft.mode === "auto"} onChange={(event) => update({ algorithm: event.target.value })}><option value="auto">{t("fcn.design.autoImplementation")}</option>{algorithms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>{draft.mode === "auto" ? t("fcn.design.autoImplementationHint") : draft.clock === "irregular" ? t("fcn.design.irregularImplementationHint") : t("fcn.design.regularImplementationHint")} {t("fcn.design.autoCandidateNote")}</p>{onReference && <button type="button" className="ifcn-design-text-button" onClick={onReference}>{t("fcn.design.viewReference")}</button>}</details>
    <div className="ifcn-design-finish"><label>{t("fcn.design.targetLabel")}<select value={draft.until} disabled={locked} onChange={(event) => update({ until: event.target.value as Draft["until"] })}><option value="map">{t("fcn.design.targetMap")}</option><option value="simulate">{t("fcn.design.targetSimulate")}</option><option value="energy">{t("fcn.design.targetEnergy")}</option></select></label><span>{t("fcn.design.drcNote")}</span></div>
    <textarea className="ifcn-design-note" aria-label={t("fcn.design.noteLabel")} placeholder={t("fcn.design.notePlaceholder")} rows={2} value={draft.note} disabled={locked} onChange={(event) => update({ note: event.target.value })} />
    {draft.mode === "auto" && draft.clock !== "irregular" && <p className="ifcn-design-hint">{t("fcn.design.autoRegularNote")}</p>}
    {draft.until !== "map" && <p className="ifcn-design-hint">{t("fcn.design.simulationNote")}</p>}
    {error && <p className="ifcn-design-error" role="alert">{error}</p>}{savedPath && <p className="ifcn-design-hint">{t("fcn.design.savedPrefix")}{savedPath}</p>}
    <footer><p>{!workspace?.available ? workspace?.message || t("fcn.design.checkingEngine") : algorithms.length ? t("fcn.design.resultsNote") : t("fcn.design.noImplementation")}</p><button type="button" className="ifcn-design-submit" disabled={locked || !workspace?.available || !algorithms.length || !draft.source.trim()} onClick={() => void submit()}>{saving ? t("fcn.design.submitting") : busy ? t("fcn.design.designing") : t("fcn.design.submit")}</button></footer>
  </section>;
}
