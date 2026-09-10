"use client";

import { Fragment, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { readIfcnAlgorithmCatalog, ifcnScaleLabel, type IfcnAlgorithm, type IfcnDesignMode, type IfcnScale } from "@/lib/ifcn-algorithms";
import type { IfcnWorkspaceInfo } from "./IfcnWorkspace";

const SCALES: IfcnScale[] = ["small", "medium", "large"];

function clockGroups(entries: IfcnAlgorithm[]) {
  const result = new Map<string, { id: string; label: string }>();
  for (const entry of entries) if (!result.has(entry.clockFamily)) result.set(entry.clockFamily, { id: entry.clockFamily, label: entry.clockFamilyLabel });
  return [...result.values()];
}

export function IfcnAlgorithms({ workspace, onRefresh }: { workspace: IfcnWorkspaceInfo | null; onRefresh: () => void }) {
  const { t, locale } = useI18n();
  const catalog = useMemo(() => readIfcnAlgorithmCatalog(workspace?.capabilities, locale), [workspace?.capabilities, locale]);
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
  const modeLabel = t(`fcn.algorithms.${mode}`);
  const scaleLabel = t(`fcn.algorithms.${scale}`);

  return <section className="ifcn-algorithms" aria-label={t("fcn.algorithms.aria")}>
    <header className="ifcn-algorithms-header"><div><span className="ifcn-algorithms-eyebrow">{t("fcn.algorithms.eyebrow")}</span><h1>{t("fcn.algorithms.heading")}</h1><p>{t("fcn.algorithms.intro")}</p></div><button type="button" className="ifcn-algorithms-refresh" onClick={onRefresh}>↻ {t("fcn.algorithms.refresh")}</button></header>
    <div className="ifcn-design-mode" role="group" aria-label={t("fcn.algorithms.modeAria")}><button type="button" aria-pressed={mode === "combinational"} onClick={() => { setMode("combinational"); setExpanded(null); }}>{t("fcn.algorithms.combinational")}</button><button type="button" aria-pressed={mode === "sequential"} onClick={() => { setMode("sequential"); setExpanded(null); }}>{t("fcn.algorithms.sequential")}</button></div>
    <section className="ifcn-scope-step" aria-label={t("fcn.algorithms.sizeAria")}><h2><span>01</span> {t("fcn.algorithms.size")}</h2><div className="ifcn-scale-options">{SCALES.map((item) => <button type="button" key={item} aria-pressed={scale === item} onClick={() => { setScale(item); setExpanded(null); }}><strong>{t(`fcn.algorithms.${item}`)}</strong><span>{ifcnScaleLabel(item, catalog.scalePolicy, locale)}</span></button>)}</div><details className="ifcn-scale-definition"><summary>{t("fcn.algorithms.sizeDefinition")}</summary><p>{catalog.scalePolicy.note}</p><p>{t("fcn.algorithms.metric", { metric: catalog.scalePolicy.metric === "dag_gate_nodes" ? t("fcn.algorithms.gateNodes") : catalog.scalePolicy.metric })}</p></details></section>
    {!workspace ? <p className="ifcn-algorithms-notice" role="status">{t("fcn.algorithms.loading")}</p> : !workspace.capabilities ? <p className="ifcn-algorithms-notice" role="status">{locale === "zh-CN" && workspace.message || t("fcn.algorithms.unavailable")}</p> : <>
      {!catalog.complete && <p className="ifcn-algorithms-notice">{t("fcn.algorithms.incomplete")}</p>}
      <section className="ifcn-scope-step" aria-label={t("fcn.algorithms.clockAria")}><h2><span>02</span> {t("fcn.algorithms.clock")}</h2><div className="ifcn-clock-options" role="group" aria-label={t("fcn.algorithms.clockChoiceAria")}>{clocks.map((item) => <button type="button" key={item.id} aria-pressed={activeClock === item.id} onClick={() => { setClock(item.id); setExpanded(null); }}>{item.label}</button>)}</div><p className="ifcn-clock-note">{t("fcn.algorithms.clockNote")}</p></section>
      <section className="ifcn-scope-step" aria-label={t("fcn.algorithms.optionsAria")}><h2><span>03</span> {t("fcn.algorithms.options")}</h2><p className="ifcn-scope-path">{modeLabel} <span>／</span> {scaleLabel} <span>／</span> {clocks.find((item) => item.id === activeClock)?.label || t("fcn.algorithms.unclassifiedClock")}</p>
        <p className={`ifcn-scale-evidence${evidenceCount ? " has-samples" : ""}`} role="status">{evidenceCount ? t("fcn.algorithms.sampleEvidence", { count: evidenceCount }) : t("fcn.algorithms.noEvidence")}</p>
        {entries.length ? <div className="ifcn-implementation-table-wrap"><table className="ifcn-implementation-table"><thead><tr><th>{t("fcn.algorithms.implementation")}</th><th>{t("fcn.algorithms.integration")}</th><th>{t("fcn.algorithms.evidence")}</th></tr></thead><tbody>{entries.map((entry) => {
          const inMode = entry.designModes.includes(mode);
          const coverage = entry.scaleCoverage[scale];
          const status = inMode ? coverage.status : "unassessed";
          return <Fragment key={entry.id}><tr className={expanded === entry.id ? "is-expanded" : ""}><td><button type="button" className="ifcn-implementation-toggle" aria-expanded={expanded === entry.id} onClick={() => setExpanded((current) => current === entry.id ? null : entry.id)}><span aria-hidden>{expanded === entry.id ? "−" : "+"}</span>{entry.name}</button></td><td><span className="ifcn-integration-label" data-ready={inMode && entry.available}>{t(`fcn.algorithms.${!inMode ? "modeUnknown" : entry.available ? "integrated" : entry.integrated ? "integratedUnavailable" : "notIntegrated"}`)}</span></td><td><span className="ifcn-coverage-label" data-status={status}>{t(`fcn.algorithms.coverage.${status}`)}</span>{inMode && coverage.status === "validated_samples" && <small>{coverage.benchmarkCount !== null ? t("fcn.algorithms.sampleCount", { count: coverage.benchmarkCount }) : t("fcn.algorithms.samples")}{coverage.maxGateNodes !== null ? t("fcn.algorithms.maxGates", { count: coverage.maxGateNodes }) : ""}</small>}</td></tr>
            {expanded === entry.id && <tr className="ifcn-implementation-details"><td colSpan={3}><dl><div><dt>{t("fcn.algorithms.method")}</dt><dd>{entry.methodLabel}</dd></div><div><dt>{t("fcn.algorithms.clockDetail")}</dt><dd>{entry.clockLabel}</dd></div><div><dt>{t("fcn.algorithms.sizeEvidence")}</dt><dd>{inMode ? coverage.note : t("fcn.algorithms.modeNotDeclared")}</dd></div>{entry.scope && <div><dt>{t("fcn.algorithms.scope")}</dt><dd>{entry.scope}</dd></div>}</dl><p>{entry.description}</p>{entry.runAlgorithm && entry.integrated && <p>{t("fcn.algorithms.runAlgorithm")}<code>{entry.runAlgorithm}</code></p>}{(entry.sourceRepository || entry.sourcePaths.length > 0) && <details><summary>{t("fcn.algorithms.source")}</summary>{entry.sourceRepository && <p>{entry.sourceRepository}</p>}{entry.originBranch && <p>{t("fcn.algorithms.branch")}{entry.originBranch}{entry.originCommit ? ` · ${entry.originCommit.slice(0, 12)}` : ""}</p>}<ul>{entry.sourcePaths.map((path, index) => <li key={`${path}-${index}`}><code>{path}</code></li>)}</ul>{entry.evidenceSourcePaths.length > 0 && <><p>{t("fcn.algorithms.evidenceSource")}</p><ul>{entry.evidenceSourcePaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></>}</details>}{entry.originalReport && <details><summary>{t("fcn.algorithms.originalReport")}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.originalReport}</pre></details>}</td></tr>}
          </Fragment>;
        })}</tbody></table></div> : <p className="ifcn-algorithms-empty">{t("fcn.algorithms.empty")}</p>}
        {components.length > 0 && <details className="ifcn-support-components"><summary>{t("fcn.algorithms.components", { count: components.length })}</summary><p>{t("fcn.algorithms.componentsNote")}</p><ul>{components.map((entry) => <li key={entry.id}><strong>{entry.name}</strong><span>{entry.description}</span></li>)}</ul></details>}
      </section>
      {mode === "sequential" && <p className="ifcn-sequential-boundary">{t("fcn.algorithms.sequentialBoundary")}</p>}
      <p className="ifcn-algorithms-footer">{t("fcn.algorithms.autoNote")}</p>
    </>}
  </section>;
}
