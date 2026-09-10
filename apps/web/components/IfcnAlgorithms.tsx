"use client";

import { Fragment, useMemo, useState } from "react";
import { readIfcnAlgorithmCatalog, ifcnScaleLabel, type IfcnAlgorithm, type IfcnDesignMode, type IfcnScale } from "@/lib/ifcn-algorithms";
import type { IfcnWorkspaceInfo } from "./IfcnWorkspace";

const SCALES: { id: IfcnScale; label: string }[] = [{ id: "small", label: "小规模" }, { id: "medium", label: "中规模" }, { id: "large", label: "大规模" }];
const COVERAGE_LABELS = { validated_samples: "有样本验证", candidate: "候选 · 待规模验证", unassessed: "本档尚未评估", out_of_scope: "不适用于本档" };

function clockGroups(entries: IfcnAlgorithm[]) {
  const result = new Map<string, { id: string; label: string }>();
  for (const entry of entries) if (!result.has(entry.clockFamily)) result.set(entry.clockFamily, { id: entry.clockFamily, label: entry.clockFamilyLabel });
  return [...result.values()];
}

export function IfcnAlgorithms({ workspace, onRefresh }: { workspace: IfcnWorkspaceInfo | null; onRefresh: () => void }) {
  const catalog = useMemo(() => readIfcnAlgorithmCatalog(workspace?.capabilities), [workspace?.capabilities]);
  const [mode, setMode] = useState<IfcnDesignMode>("combinational");
  const [scale, setScale] = useState<IfcnScale>("small");
  const [clock, setClock] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const modeEntries = catalog.entries.filter((entry) => entry.designModes.includes(mode) || entry.designModes.length === 0);
  const implementations = modeEntries.filter((entry) => entry.entryKind !== "component");
  const clocks = clockGroups(implementations);
  const activeClock = clocks.some((item) => item.id === clock) ? clock : clocks[0]?.id || "";
  const entries = implementations.filter((entry) => entry.clockFamily === activeClock);
  const components = modeEntries.filter((entry) => entry.entryKind === "component");
  const evidenceCount = entries.filter((entry) => entry.designModes.includes(mode) && entry.scaleCoverage[scale].status === "validated_samples").length;
  const modeLabel = mode === "combinational" ? "组合电路" : "时序电路";
  const scaleLabel = SCALES.find((item) => item.id === scale)!.label;

  return <section className="ifcn-algorithms" aria-label="按电路规模与时钟选择实现">
    <header className="ifcn-algorithms-header"><div><span className="ifcn-algorithms-eyebrow">FCNPilot / DESIGN SCOPE</span><h1>规模与时钟</h1><p>先确定电路大小，再选择时钟类型，最后查看实现。</p></div><button type="button" className="ifcn-algorithms-refresh" onClick={onRefresh}>↻ 更新能力</button></header>
    <div className="ifcn-design-mode" role="group" aria-label="选择电路模式"><button type="button" aria-pressed={mode === "combinational"} onClick={() => { setMode("combinational"); setExpanded(null); }}>组合电路</button><button type="button" aria-pressed={mode === "sequential"} onClick={() => { setMode("sequential"); setExpanded(null); }}>时序电路</button></div>
    <section className="ifcn-scope-step" aria-label="第一步：电路规模"><h2><span>01</span> 电路规模</h2><div className="ifcn-scale-options">{SCALES.map((item) => <button type="button" key={item.id} aria-pressed={scale === item.id} onClick={() => { setScale(item.id); setExpanded(null); }}><strong>{item.label}</strong><span>{ifcnScaleLabel(item.id, catalog.scalePolicy)}</span></button>)}</div><details className="ifcn-scale-definition"><summary>规模如何划分</summary><p>{catalog.scalePolicy.note}</p><p>统计指标：{catalog.scalePolicy.metric === "dag_gate_nodes" ? "逻辑 DAG 的门节点数" : catalog.scalePolicy.metric}。分档仅用于整理选择；样本验证不等于整档电路均可处理。</p></details></section>
    {!workspace ? <p className="ifcn-algorithms-notice" role="status">正在读取电路引擎能力…</p> : !workspace.capabilities ? <p className="ifcn-algorithms-notice" role="status">{workspace.message || "能力尚未加载。启用 iFCN 引擎后可查看实际实现。"}</p> : <>
      {!catalog.complete && <p className="ifcn-algorithms-notice">当前引擎只返回已接入的后端，尚无完整规模分类；缺失信息均按未评估显示。</p>}
      <section className="ifcn-scope-step" aria-label="第二步：时钟类型"><h2><span>02</span> 时钟类型</h2><div className="ifcn-clock-options" role="group" aria-label="选择时钟类型">{clocks.map((item) => <button type="button" key={item.id} aria-pressed={activeClock === item.id} onClick={() => { setClock(item.id); setExpanded(null); }}>{item.label}</button>)}</div><p className="ifcn-clock-note">时钟类型描述相位约束。“非规则”与“随机采样时钟场”分别标注，不代表求解方法一定使用随机搜索。</p></section>
      <section className="ifcn-scope-step" aria-label="第三步：可选实现"><h2><span>03</span> 实现选项</h2><p className="ifcn-scope-path">{modeLabel} <span>／</span> {scaleLabel} <span>／</span> {clocks.find((item) => item.id === activeClock)?.label || "时钟未分类"}</p>
        <p className={`ifcn-scale-evidence${evidenceCount ? " has-samples" : ""}`} role="status">{evidenceCount ? `${evidenceCount} 项实现具有本档样本验证；结论限于列出的样本及约束。` : "尚无本档验证数据。以下仅为候选或未评估实现，不表示已支持该规模。"}</p>
        {entries.length ? <div className="ifcn-implementation-table-wrap"><table className="ifcn-implementation-table"><thead><tr><th>实现</th><th>流程接入</th><th>本档证据</th></tr></thead><tbody>{entries.map((entry) => {
          const inMode = entry.designModes.includes(mode);
          const coverage = entry.scaleCoverage[scale];
          const status = inMode ? coverage.status : "unassessed";
          return <Fragment key={entry.id}><tr className={expanded === entry.id ? "is-expanded" : ""}><td><button type="button" className="ifcn-implementation-toggle" aria-expanded={expanded === entry.id} onClick={() => setExpanded((current) => current === entry.id ? null : entry.id)}><span aria-hidden>{expanded === entry.id ? "−" : "+"}</span>{entry.name}</button></td><td><span className="ifcn-integration-label" data-ready={inMode && entry.available}>{!inMode ? "模式待确认" : entry.available ? "已接入" : entry.integrated ? "已接入 · 暂不可用" : "尚未接入"}</span></td><td><span className="ifcn-coverage-label" data-status={status}>{COVERAGE_LABELS[status]}</span>{inMode && coverage.status === "validated_samples" && <small>{coverage.benchmarkCount !== null ? `${coverage.benchmarkCount} 个样本` : "已测样本"}{coverage.maxGateNodes !== null ? ` · 最大 ${coverage.maxGateNodes} 门` : ""}</small>}</td></tr>
            {expanded === entry.id && <tr className="ifcn-implementation-details"><td colSpan={3}><dl><div><dt>求解方法</dt><dd>{entry.methodLabel}</dd></div><div><dt>具体时钟</dt><dd>{entry.clockLabel}</dd></div><div><dt>规模依据</dt><dd>{inMode ? coverage.note : "能力目录尚未标明此实现适用的电路模式。"}</dd></div>{entry.scope && <div><dt>适用范围</dt><dd>{entry.scope}</dd></div>}</dl><p>{entry.description}</p>{entry.runAlgorithm && entry.integrated && <p>流程算法标识：<code>{entry.runAlgorithm}</code></p>}{(entry.sourceRepository || entry.sourcePaths.length > 0) && <details><summary>实现来源</summary>{entry.sourceRepository && <p>{entry.sourceRepository}</p>}{entry.originBranch && <p>原始分支：{entry.originBranch}{entry.originCommit ? ` · ${entry.originCommit.slice(0, 12)}` : ""}</p>}<ul>{entry.sourcePaths.map((path, index) => <li key={`${path}-${index}`}><code>{path}</code></li>)}</ul>{entry.evidenceSourcePaths.length > 0 && <><p>验证记录来源（FCNPilot）</p><ul>{entry.evidenceSourcePaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></>}</details>}</td></tr>}
          </Fragment>;
        })}</tbody></table></div> : <p className="ifcn-algorithms-empty">该模式和时钟下尚未登记独立实现。</p>}
        {components.length > 0 && <details className="ifcn-support-components"><summary>组件参考 · {components.length} 项</summary><p>本模式的组件参考，不按门数作支持承诺，也不是可独立选择的布局后端。</p><ul>{components.map((entry) => <li key={entry.id}><strong>{entry.name}</strong><span>{entry.description}</span></li>)}</ul></details>}
      </section>
      {mode === "sequential" && <p className="ifcn-sequential-boundary">时序流程会单独报告状态边界、反馈路径和状态转移检查。反馈版图候选不等于状态器件已完成物理签核。</p>}
      <p className="ifcn-algorithms-footer">auto 仅按预定顺序选择已接入的实现并在失败时回退；不作为独立算法，不承诺全局最优。</p>
    </>}
  </section>;
}
