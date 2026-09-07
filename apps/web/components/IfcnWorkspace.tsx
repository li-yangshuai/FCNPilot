"use client";

import { useEffect, useState } from "react";
import { FcnPilotIcon } from "./FcnPilotIcon";

export interface IfcnWorkspaceInfo {
  configured: boolean;
  cwd: string | null;
  agentId: string;
  available: boolean;
  message?: string;
  requiresTrust?: boolean;
}

export function useIfcnWorkspace(refreshKey?: string | number | null) {
  const [workspace, setWorkspace] = useState<IfcnWorkspaceInfo | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ifcn/workspace", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok && !result.message) throw new Error(result.error || "无法检查 iFCN 引擎");
        setWorkspace(result);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setWorkspace({ configured: false, cwd: null, agentId: "project:ifcn", available: false, message: String(error.message || error) });
      });
    return () => controller.abort();
  }, [refreshKey]);
  return workspace;
}

export function IfcnMark({ size = 32 }: { size?: number }) {
  return <FcnPilotIcon size={size} />;
}

export function IfcnWorkspaceBar({ workspace }: { workspace: IfcnWorkspaceInfo | null }) {
  return <div className="ifcn-workspace-bar">
    <IfcnMark size={26} />
    <div className="ifcn-bar-title"><strong>FCNPilot</strong><span>场耦合纳米电路设计</span></div>
    <span className={`ifcn-engine-state${workspace?.available ? " ready" : ""}`} title={workspace?.message} role="status">
      <i />{!workspace ? "正在检查引擎" : workspace.available ? "设计引擎就绪" : workspace.requiresTrust ? "工程待授权" : "引擎待配置"}
    </span>
    {workspace?.cwd && <a className="ifcn-open-project" href={`/?cwd=${encodeURIComponent(workspace.cwd)}`}>新建 iFCN 设计 <span aria-hidden>↗</span></a>}
  </div>;
}

const STARTERS = [
  { title: "从 Verilog 开始", detail: "检查已有组合电路，生成 DAG 与 QCA 版图。", prompt: "请先检查 iFCN 的实际能力。我会提供一个 Verilog 文件，请确认它是否属于支持的标量组合电路，再解析为 DAG，完成门级布局布线和 QCA 器件映射。" },
  { title: "运行 XOR 示例", detail: "用工程内的冻结示例走通版图流程。", prompt: "请检查 iFCN 能力（deep=true），读取当前工程 tests/benchmarks_pi/v1/manifest.json 并定位冻结的 TOY XOR 示例。使用 auto 后端运行到 map，读取 result.json，报告门级 tile 面积、QCA 元胞数、逻辑等价检查和端子数量检查结果。" },
  { title: "比较布局方案", detail: "相同输入比较三种后端，保留失败结果。", prompt: "请用当前 iFCN 工程冻结的 TOY XOR 示例，在相同输入、seed 和预算下分别运行 Normal 2DDWave、Compact、June 到 map。保留所有失败，比较通过检查的门级面积和 QCA 元胞数，并解释时钟方案和验证范围。" },
] as const;

export function IfcnWelcome({ workspace, cwd, selected, onSelect, onPrepare }: {
  workspace: IfcnWorkspaceInfo | null;
  cwd: string | null;
  selected: boolean;
  onSelect: () => void;
  onPrepare: (prompt: string) => void;
}) {
  return <section className="ifcn-welcome" aria-label="iFCN 电路设计工作台">
    <div className="ifcn-eyebrow"><IfcnMark size={52} /><span>FCNPilot <span className="ifcn-powered">/ powered by Pi</span></span></div>
    <h1>从电路描述，到器件版图。</h1>
    <p className="ifcn-intro">用自然语言组织组合电路设计，检查每一步的结果。</p>
    <ol className="ifcn-pipeline" aria-label="iFCN 设计流程">
      {["Verilog", "逻辑 DAG", "布局布线", "QCA 版图", "仿真与能耗"].map((stage, i) => <li key={stage}><span>{String(i+1).padStart(2, "0")}</span><strong>{stage}</strong></li>)}
    </ol>
    <div className="ifcn-context">
      <div><span className="ifcn-context-label">主智能体</span><strong>{selected ? "iFCN · 已选择" : "尚未选择 iFCN"}</strong></div>
      {!selected && <button type="button" onClick={onSelect}>使用 iFCN 主智能体</button>}
      <div className="ifcn-project-path" title={cwd ?? undefined}><span className="ifcn-context-label">当前工程</span><span>{cwd || "正在打开工程…"}</span></div>
    </div>
    {workspace && !workspace.available && <p className="ifcn-connection-note" role="status">{workspace.message || "设计引擎尚未就绪，请先完成工程配置。"}</p>}
    <p className="ifcn-starters-label">选择一个起点，调整请求后发送</p>
    <div className="ifcn-starters">
      {STARTERS.map((item) => <button type="button" key={item.title} onClick={() => onPrepare(item.prompt)} disabled={!selected}>
        <strong>{item.title}<span aria-hidden>↗</span></strong><span>{item.detail}</span>
      </button>)}
    </div>
    <p className="ifcn-scope">当前支持标量组合电路 · 三种布局布线后端 · 逻辑与端子数量检查<br />器件仿真与能耗估计会单独报告验证范围；时序电路尚未启用。</p>
  </section>;
}
