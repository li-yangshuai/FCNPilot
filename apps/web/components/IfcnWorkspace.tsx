"use client";

import { useEffect, useState } from "react";
import { FcnPilotIcon } from "./FcnPilotIcon";
import { readIfcnAlgorithmCatalog, type IfcnDesignMode } from "../lib/ifcn-algorithms";

export interface IfcnWorkspaceInfo {
  configured: boolean;
  cwd: string | null;
  agentId: string;
  available: boolean;
  message?: string;
  requiresTrust?: boolean;
  trusted?: boolean;
  capabilities?: Record<string, unknown>;
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

export function IfcnWorkspaceBar({ workspace, onNewDesign }: { workspace: IfcnWorkspaceInfo | null; onNewDesign?: () => void }) {
  return <div className="ifcn-workspace-bar">
    <IfcnMark size={26} />
    <div className="ifcn-bar-title"><strong>FCNPilot</strong><span>场耦合纳米电路设计</span></div>
    <span className={`ifcn-engine-state${workspace?.available ? " ready" : ""}`} title={workspace?.message} role="status">
      <i />{!workspace ? "正在检查引擎" : workspace.available ? "设计引擎就绪" : workspace.requiresTrust ? "工程待授权" : "引擎待配置"}
    </span>
    {workspace?.cwd && <button type="button" className="ifcn-open-project" onClick={onNewDesign}>新建设计 <span aria-hidden>＋</span></button>}
  </div>;
}

const STARTERS = [
  { title: "从 Verilog 开始", detail: "检查已有组合电路，生成 DAG 与 QCA 版图。", prompt: "请先检查 iFCN 的实际能力。我会提供一个 Verilog 文件，请确认它是否属于支持的标量组合电路，再解析为 DAG，完成门级布局布线和 QCA 器件映射。" },
  { title: "运行 XOR 示例", detail: "用工程内的冻结示例走通版图流程。", prompt: "请检查 iFCN 能力（deep=true），读取当前工程 tests/benchmarks_pi/v1/manifest.json 并定位冻结的 TOY XOR 示例。以 combinational 模式使用 auto 后端运行到 map，读取 result.json，报告门级 tile 面积、QCA 元胞数、逻辑等价检查和端子数量检查结果。" },
  { title: "比较布局方案", detail: "相同输入比较已接入的后端，保留失败结果。", prompt: "请先读取当前 iFCN 的实际能力，列出支持组合电路、已接入且可用的布局布线后端。用工程冻结的 TOY XOR 示例，在相同输入、seed 和预算下分别运行这些后端到 map。保留所有失败，比较通过检查的门级面积和 QCA 元胞数，并分别说明求解方法、时钟方案和验证范围。" },
] as const;

const SEQUENTIAL_STARTERS = [
  { title: "从时序 Verilog 开始", detail: "识别状态边界，检查下一状态逻辑，生成反馈版图候选。", prompt: "请先检查 iFCN 的时序能力。我会提供一个时序 Verilog 文件，请确认触发器、时钟与复位语义是否受支持，以 sequential 模式运行到 map。检查 SequentialIR 和状态转移，生成反馈门级版图与 QCA 候选；分别报告状态检查、时钟约束和未完成的状态器件物理验证。" },
  { title: "运行反馈示例", detail: "使用工程内受支持的触发器示例，保留状态检查报告。", prompt: "请先读取 iFCN 实际能力并检查当前工程的时序测试样例，选取受支持的单状态反馈翻转电路，使用 sequential_cyclic 以 sequential 模式运行到 map。读取 seqir.json、sequential_validation.json 和完整结果，报告状态边界、反馈路径与验证范围；把器件输出明确称为候选版图。" },
  { title: "检查状态与时钟", detail: "分别核对状态转移、反馈路径和相位约束。", prompt: "请检查我指定的时序 FCN 电路或运行结果。先确认受支持的 RTL 语义，再核对状态转移检查、反馈路径、相位与 epoch 约束、启动间隔。给出真实报告和版图文件，并明确状态器件是否经过物理表征，不以布线完成代替时序功能验证。" },
] as const;

const SEQUENTIAL_QUESTIONS = [
  { label: "状态边界", prompt: "请解释当前时序电路的 D/Q 状态边界，并从实际 SequentialIR 与状态清单中列出寄存器和下一状态逻辑。" },
  { label: "反馈路径", prompt: "请根据当前时序运行的实际门级版图和报告，检查反馈路径与有向环，并解释启动间隔及相位约束。" },
  { label: "状态转移检查", prompt: "请读取当前时序运行的 sequential_validation.json，说明已检查的状态与输入组合、检查对象及局限；不要把下一状态逻辑检查称为器件时序签核。" },
  { label: "QCA 候选版图", prompt: "请显示当前时序运行输出的 QCA 候选版图并提供下载，结合状态边界说明哪些状态器件性质尚未经过物理表征。" },
] as const;

const CIRCUIT_QUESTIONS = [
  { label: "MAJ 多数门", prompt: "请从当前工程的冻结 MAJ 基准中选择一个受支持的组合电路，先解释其多数逻辑，再运行到 QCA 器件映射，给出门级图和器件版图的结果文件。" },
  { label: "四相时钟布线", prompt: "请以当前工程的 TOY XOR 示例解释四相 2DDWave 时钟约束，再用 normal_2ddwave 生成布局布线结果，读取实际图和检查报告。" },
  { label: "仿真与耗散能量", prompt: "请从当前工程的冻结 TOY XOR 示例出发，先检查组合电路能力，再以 combinational 模式运行到 energy，使用 both 仿真模型和 standard 能耗配置。报告数值一致性、能量与耗散功率估计及验证范围，并提供真实结果文件。" },
  { label: "检查已有设计", prompt: "请检查我指定的 FCN 运行结果。先读取 result.json，再核对逻辑等价、时钟合法性和 QCA 端子数量；区分已经通过、失败和未执行的检查，不用残留文件宣称成功。" },
] as const;

export function IfcnWelcome({ workspace, cwd, selected, onSelect, onPrepare }: {
  workspace: IfcnWorkspaceInfo | null;
  cwd: string | null;
  selected: boolean;
  onSelect: () => void;
  onPrepare: (prompt: string) => void;
}) {
  const [mode, setMode] = useState<IfcnDesignMode>("combinational");
  const isSequential = mode === "sequential";
  const catalog = readIfcnAlgorithmCatalog(workspace?.capabilities);
  const sequentialCapability = workspace?.capabilities?.sequential;
  const sequentialSupported = sequentialCapability !== null && typeof sequentialCapability === "object" && "supported" in sequentialCapability && sequentialCapability.supported === true;
  const sequentialReady = sequentialSupported && catalog.entries.some((entry) => entry.designModes.includes("sequential") && entry.available);
  const pipeline = isSequential ? ["Verilog", "状态与下一状态逻辑", "反馈布局布线", "QCA 候选版图", "分项验证"] : ["Verilog", "逻辑 DAG", "布局布线", "QCA 版图", "仿真与能耗"];
  return <section className="ifcn-welcome" aria-label="iFCN 电路设计工作台">
    <div className="ifcn-eyebrow"><IfcnMark size={52} /><span>FCNPilot <span className="ifcn-powered">/ FCN circuit design</span></span></div>
    <h1>从电路描述，到器件版图。</h1>
    <p className="ifcn-intro">描述逻辑，生成版图，核对电路。由 iFCN 主智能体贯穿设计全流程。</p>
    <div className="ifcn-design-mode" role="group" aria-label="电路设计模式"><button type="button" aria-pressed={!isSequential} onClick={() => setMode("combinational")}>组合电路</button><button type="button" aria-pressed={isSequential} onClick={() => setMode("sequential")}>时序电路</button></div>
    <ol className="ifcn-pipeline" aria-label="iFCN 设计流程">
      {pipeline.map((stage, i) => <li key={stage}><span>{String(i+1).padStart(2, "0")}</span><strong>{stage}</strong></li>)}
    </ol>
    <div className="ifcn-context">
      <div><span className="ifcn-context-label">主智能体</span><strong>{selected ? "iFCN · 已选择" : "尚未选择 iFCN"}</strong></div>
      {!selected && <button type="button" onClick={onSelect}>使用 iFCN 主智能体</button>}
      <div className="ifcn-project-path" title={cwd ?? undefined}><span className="ifcn-context-label">当前工程</span><span>{cwd || "正在打开工程…"}</span></div>
    </div>
    {workspace && !workspace.available && <p className="ifcn-connection-note" role="status">{workspace.message || "设计引擎尚未就绪，请先完成工程配置。"}</p>}
    <p className="ifcn-starters-label">选择一个起点，调整请求后发送</p>
    <div className="ifcn-starters">
      {(isSequential ? SEQUENTIAL_STARTERS : STARTERS).map((item) => <button type="button" key={item.title} onClick={() => onPrepare(item.prompt)} disabled={!selected}>
        <strong>{item.title}<span aria-hidden>↗</span></strong><span>{item.detail}</span>
      </button>)}
    </div>
    <div className="ifcn-question-clouds" aria-label="FCN 电路问题云朵">
      {(isSequential ? SEQUENTIAL_QUESTIONS : CIRCUIT_QUESTIONS).map((item) => <button type="button" key={item.label} onClick={() => onPrepare(item.prompt)} disabled={!selected} title={item.prompt}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M2 5h6v7h8v7h6M2 19h6v-7M16 5v7"/><rect x="5" y="9" width="6" height="6" rx="1"/><rect x="13" y="9" width="6" height="6" rx="1"/></svg>
        <span>{item.label}</span>
      </button>)}
    </div>
    <p className="ifcn-output-note">生成的 SVG 门级图、QCA 版图、波形与 JSON 报告可在「版图与结果」中查看和下载。</p>
    <p className="ifcn-scope">{isSequential ? `${sequentialReady ? "时序反馈流程已接入" : "时序入口需以当前引擎能力确认"}；默认生成门级与 QCA 候选，状态器件尚未完成物理签核。仿真与能耗探索须单独请求。` : "组合流程支持标量逻辑解析、布局布线与器件映射；器件仿真和能耗估计单独报告验证范围。"}<br />在「规模与时钟」中按电路大小选择时钟类型，并核对具体实现的样本验证范围。</p>
  </section>;
}
