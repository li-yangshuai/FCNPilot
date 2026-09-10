"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { buildIfcnDesignPrompt, loadIfcnSourceDraft, ifcnDesignAlgorithms, ifcnSnapshotName, validateIfcnSource, type IfcnClockChoice, type IfcnDesignRequest, type IfcnInputMode } from "@/lib/ifcn-design-request";
import type { IfcnWorkspaceInfo } from "./IfcnWorkspace";
import { FcnPilotIcon } from "./FcnPilotIcon";

const CircuitEditor = dynamic(() => import("./MonacoCodeEditor").then((module) => module.MonacoCodeEditor), { ssr: false, loading: () => <p className="ifcn-design-hint">正在打开 Verilog 编辑器…</p> });
interface Draft extends IfcnDesignRequest { source: string; name: string; path: string; }
const INITIAL: Draft = { mode: "auto", clock: "irregular", algorithm: "auto", until: "map", note: "", source: "", name: "circuit.v", path: "" };
const EXAMPLES = { combinational: "module xor2(input a, input b, output y);\n  assign y = a ^ b;\nendmodule\n", sequential: "module toggle_ff(input clk, input en, output reg q);\n  always @(posedge clk)\n    if (en) q <= ~q;\nendmodule\n" };

export function IfcnDesignForm({ workspace, cwd, draftKey, busy, selection, onChooseFile, onSubmit, onCancel, onReference }: {
  workspace: IfcnWorkspaceInfo | null; cwd: string; draftKey: string; busy: boolean;
  selection?: { path: string; token: number } | null;
  onChooseFile?: () => void; onSubmit: (prompt: string) => Promise<void>; onCancel?: () => void; onReference?: () => void;
}) {
  const { isDark } = useTheme();
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
  const algorithms = useMemo(() => ifcnDesignAlgorithms(workspace?.capabilities, draft.mode, draft.clock), [workspace?.capabilities, draft.mode, draft.clock]);
  const algorithm = algorithms.some((item) => item.id === draft.algorithm) ? draft.algorithm : "auto";
  const locked = busy || saving || reading;
  const readSource = async (value: string) => {
    const path = value.trim().startsWith("/") ? value.trim() : `${cwd.replace(/\/$/, "")}/${value.trim()}`;
    if (!/\.(?:v|sv)$/i.test(path) || !(path === cwd || path.startsWith(cwd.replace(/\/$/, "") + "/")) || path.split("/").includes("..")) { setError("请选择当前 FCN 工程内的 .v 或 .sv 文件。"); return; }
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setReading(true); setError(null);
    try {
      const response = await fetch(`/api/files/${encodeFilePathForApi(path)}?type=read`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok || typeof data.content !== "string") throw new Error(data.error || "无法读取电路文件。");
      validateIfcnSource(data.content);
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
      validateIfcnSource(sourceRef.current);
      if (!workspace?.available || !algorithms.length) throw new Error("当前模式与时钟下没有可用实现，请检查引擎能力。");
      const name = ifcnSnapshotName(draft.name, crypto.randomUUID());
      const response = await fetch(`/api/files/${encodeFilePathForApi(cwd)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, kind: "file", content: sourceRef.current }) });
      const result = await response.json();
      if (!response.ok || typeof result.path !== "string") throw new Error(result.error || "无法保存本次电路输入。");
      const expected = `${cwd.replace(/\/$/, "")}/${name}`;
      if (result.path !== expected) throw new Error("保存路径与本次电路输入不一致。");
      setSavedPath(result.path);
      try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Snapshot is already durable. */ }
      await onSubmit(buildIfcnDesignPrompt(result.path, { ...draft, algorithm }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { submitLock.current = false; setSaving(false); }
  };
  return <section className="ifcn-design-form" aria-label="FCN 电路设计输入">
    <header><div className="ifcn-design-title"><FcnPilotIcon size={34} /><div><span>FCNPilot</span><h1>设计你的 FCN 电路</h1></div></div>{onCancel && <button type="button" className="ifcn-design-text-button" onClick={onCancel}>返回对话</button>}</header>
    <p className="ifcn-design-intro">输入 Verilog，选择电路模式与时钟。iFCN 主智能体负责设计、检查和结果解释。</p>
    <div className="ifcn-design-section-heading"><h2><span>01</span> 电路输入</h2><div>{onChooseFile && <button type="button" onClick={onChooseFile} disabled={locked}>选择工程文件</button>}<button type="button" disabled={locked} onClick={() => update({ source: EXAMPLES.combinational, name: "xor2.v", path: "", mode: "combinational", algorithm: "auto" })}>XOR 示例</button><button type="button" disabled={locked} onClick={() => update({ source: EXAMPLES.sequential, name: "toggle_ff.v", path: "", mode: "sequential", clock: "irregular", algorithm: "auto" })}>反馈示例</button></div></div>
    <div className="ifcn-design-path"><input aria-label="已有 Verilog 文件路径" placeholder="工程内的 .v 文件路径，也可以直接在下方输入" value={draft.path} disabled={locked} onChange={(event) => update({ path: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void readSource(draft.path); } }} /><button type="button" onClick={() => void readSource(draft.path)} disabled={locked || !draft.path.trim()}>{reading ? "读取中…" : "读取"}</button></div>
    <div className="ifcn-circuit-editor"><CircuitEditor filePath={`inmemory://fcn-design/${encodeURIComponent(draftKey)}.v`} language="verilog" value={draft.source} onChange={(source) => update({ source })} onSave={() => { try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Keep the current editor buffer. */ } }} isDark={isDark} wrapLines fontSize={13} uiLanguage="zh" readOnly={locked} /></div>
    <div className="ifcn-design-source-meta"><label>电路名称 <input value={draft.name} aria-label="电路名称" disabled={locked} onChange={(event) => update({ name: event.target.value })} /></label><span>提交前保存独立输入快照 · 原文件保留</span></div>
    <div className="ifcn-design-settings"><section><h2><span>02</span> 电路模式</h2><div className="ifcn-design-mode-options" role="group" aria-label="电路模式选择">{([{ id: "auto", label: "自动识别" }, { id: "combinational", label: "组合" }, { id: "sequential", label: "时序" }] as const).map((item) => <button type="button" key={item.id} disabled={locked} aria-pressed={draft.mode === item.id} onClick={() => update({ mode: item.id as IfcnInputMode, algorithm: "auto", ...(item.id === "sequential" ? { clock: "irregular" as IfcnClockChoice } : {}) })}>{item.label}</button>)}</div><p className="ifcn-design-hint">{draft.mode === "sequential" ? "保留状态与反馈，生成候选版图；状态器件尚未签核。" : draft.mode === "auto" ? "主智能体先读取电路，再确定组合或时序流程。" : "解析标量组合逻辑，核对布线后的功能与端口。"}</p></section>
      <section><h2><span>03</span> 时钟策略</h2><div className="ifcn-design-clock-options"><button type="button" disabled={locked || draft.mode === "sequential"} aria-pressed={draft.clock !== "irregular"} onClick={() => update({ clock: "2DDWave", algorithm: "auto" })}><strong>规则时钟模板</strong><span>在给定模板约束下布局与布线</span></button><button type="button" disabled={locked} aria-pressed={draft.clock === "irregular"} onClick={() => update({ clock: "irregular", algorithm: "auto" })}><strong>先布局布线，再分配相位</strong><span>按布线路径求解非规则相位</span></button></div>{draft.clock !== "irregular" && <div className="ifcn-template-options" role="group" aria-label="规则时钟模板">{(["2DDWave", "USE", "RES"] as const).map((clock) => <button type="button" key={clock} disabled={locked} aria-pressed={draft.clock === clock} onClick={() => update({ clock, algorithm: "auto" })}>{clock}</button>)}</div>}</section></div>
    <div className="ifcn-design-scope"><strong>规模待解析</strong><span>{draft.clock !== "irregular" ? "规则启发式初版适用 ≤50 个逻辑门；图布局仅用于 2DDWave，当前有小样本证据。" : draft.mode === "sequential" ? "时序反馈布局仅有小规模候选样本，中大规模尚未验证。" : "组合图算法当前有小规模样本证据，中大规模尚未验证。"} 时序门数按状态切分 DAG 统计，状态位单列。</span></div>
    <details className="ifcn-design-implementation"><summary>实现与适用范围</summary><label>布局实现 <select value={algorithm} disabled={locked || draft.mode === "auto"} onChange={(event) => update({ algorithm: event.target.value })}><option value="auto">自动选择 · 保持所选时钟</option>{algorithms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>{draft.mode === "auto" ? "自动识别电路模式后，在所选时钟约束内选择可用实现。" : draft.clock === "irregular" ? "组合图绘制家族包含 Compact 与 June 两个实现；时序使用反馈布局实现。" : "规则启发式支持 2DDWave / USE / RES；图布局与压缩仅支持 2DDWave。"} 自动选择按顺序接受通过检查的候选，不保证最小面积。</p>{onReference && <button type="button" className="ifcn-design-text-button" onClick={onReference}>查看算法与规模参考 ↗</button>}</details>
    <div className="ifcn-design-finish"><label>运行目标 <select value={draft.until} disabled={locked} onChange={(event) => update({ until: event.target.value as Draft["until"] })}><option value="map">门级与 QCA 版图</option><option value="simulate">版图与数值仿真</option><option value="energy">版图、数值仿真与能耗</option></select></label><span>DRC 必须通过；不自动更换时钟。</span></div>
    <textarea className="ifcn-design-note" aria-label="补充电路设计要求" placeholder="补充要求（可选），例如优先减小版图面积" rows={2} value={draft.note} disabled={locked} onChange={(event) => update({ note: event.target.value })} />
    {draft.mode === "auto" && draft.clock !== "irregular" && <p className="ifcn-design-hint">如果识别为时序电路，当前规则时钟流程不适用，主智能体将说明原因，保留你的时钟选择。</p>}
    {draft.until !== "map" && <p className="ifcn-design-hint">仿真与能耗属于数值模型探索，尤其不能替代时序存储功能验证。</p>}
    {error && <p className="ifcn-design-error" role="alert">{error}</p>}{savedPath && <p className="ifcn-design-hint">本次输入已保存：{savedPath}</p>}
    <footer><p>{!workspace?.available ? workspace?.message || "正在检查电路引擎…" : algorithms.length ? "生成的版图和报告将显示在「版图与结果」。" : "当前模式与时钟下暂无可用实现。"}</p><button type="button" className="ifcn-design-submit" disabled={locked || !workspace?.available || !algorithms.length || !draft.source.trim()} onClick={() => void submit()}>{saving ? "正在保存并提交…" : busy ? "主智能体设计中…" : "提交给 iFCN 设计 ↗"}</button></footer>
  </section>;
}
