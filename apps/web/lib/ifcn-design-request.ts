export type IfcnInputMode = "auto" | "combinational" | "sequential";
export type IfcnClockChoice = "2DDWave" | "USE" | "RES" | "irregular";
export type IfcnDesignTarget = "map" | "simulate" | "energy";
export const IFCN_SOURCE_MAX_BYTES = 256 * 1024;
export interface IfcnDesignRequest { mode: IfcnInputMode; clock: IfcnClockChoice; algorithm: string; until: IfcnDesignTarget; note: string; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const NAMES: Record<string,string> = { normal_2ddwave: "图布局与压缩 · 2DDWave", regular_clock_ga: "规则时钟布局搜索", compact: "图绘制 · Compact 实现", june_random: "图绘制 · June 实现", sequential_cyclic: "时序反馈布局" };
const ENGLISH_NAMES: Record<string, string> = { normal_2ddwave: "Graph layout & compaction · 2DDWave", regular_clock_ga: "Regular clock layout search", compact: "Graph drawing · Compact", june_random: "Graph drawing · June", sequential_cyclic: "Sequential feedback layout" };

export function ifcnDesignAlgorithms(capabilities: unknown, mode: IfcnInputMode, clock: IfcnClockChoice, locale = "zh-CN") {
  const data = record(capabilities);
  if (mode === "sequential" && clock !== "irregular") return [];
  return (Array.isArray(data.algorithms) ? data.algorithms : []).map(record).filter((entry) => {
    if (entry.available !== true || typeof entry.id !== "string" || !NAMES[entry.id]) return false;
    const sequential = entry.design_type === "sequential" || entry.id === "sequential_cyclic";
    if (record(data[sequential ? "sequential" : "combinational"]).supported === false) return false;
    if (mode !== "auto" && sequential !== (mode === "sequential")) return false;
    const schemes = Array.isArray(entry.clock_schemes) ? entry.clock_schemes : [entry.clock_scheme];
    return schemes.includes(clock);
  }).map((entry) => ({ id: entry.id as string, name: (locale === "en" ? ENGLISH_NAMES : NAMES)[entry.id as string] }));
}
export function validateIfcnSource(source: string, locale = "zh-CN") {
  if (!source.trim()) throw new Error(locale === "en" ? "Choose or enter a Verilog circuit first." : "请先选择或输入 Verilog 电路。");
  if (new TextEncoder().encode(source).length > IFCN_SOURCE_MAX_BYTES) throw new Error(locale === "en" ? "Circuit input must not exceed 256 KB." : "电路输入不能超过 256 KB。");
}
export function ifcnSnapshotName(name: string, unique: string) {
  const stem = name.replace(/\.(?:s?v)$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "circuit";
  if (!/^[a-zA-Z0-9_-]+$/.test(unique)) throw new Error("快照编号无效。");
  return `designs/${stem}-${unique}.v`;
}
export function buildIfcnDesignPrompt(input: string, request: IfcnDesignRequest, locale = "zh-CN") {
  if (!input.startsWith("/") || /[\r\n\0]/.test(input)) throw new Error(locale === "en" ? "Circuit input must be a valid absolute WSL path." : "电路输入必须是有效的 WSL 绝对路径。");
  if (request.mode === "sequential" && request.clock !== "irregular") throw new Error(locale === "en" ? "The sequential flow only supports phase assignment after routing." : "当前时序流程仅支持布线后分配相位。");
  const parameters = { action: "start", input, ...(request.mode !== "auto" ? { design_type: request.mode } : {}), clock_scheme: request.clock, algorithm: request.algorithm, until: request.until };
  if (locale === "en") return [
    "Use the iFCN main agent to complete this circuit design. Respond in English. The input is saved as a separate snapshot; use this file and do not overwrite the original circuit.",
    request.mode === "auto" ? "Read the circuit and ifcn_capabilities first, identify combinational or sequential semantics, then explicitly set combinational or sequential in ifcn_run. Auto is only a classification request, never a valid design_type value." : `The circuit mode is ${request.mode}; first verify the RTL semantics against actual capabilities.`,
    "Design parameters:\n" + JSON.stringify(parameters, null, 2),
    "clock_scheme is a hard user constraint, including during automatic algorithm selection. Do not change the clock, disable DRC, or bypass DRC. Report incompatibilities or validation failures and retain failed results. Every accepted candidate must pass existing routing, clock, port, and mapping checks.",
    "Parse and report the actual DAG gate count and supported scale first. The regular heuristic currently targets small circuits (at most 50 logic gates); medium and large circuits are unverified for graph algorithms. Sample success does not establish support for an entire size category.",
    "For combinational circuits, separately report source versus routed DAG logic checks and actual QCA cell and port checks. For sequential circuits, preserve state boundaries and feedback; distinguish one-step SeqIR-to-state-cut-DAG checks from unfinished independent RTL equivalence and physical state-device signoff.",
    request.until === "map" ? "Run through device mapping. Provide actual SVG, QCA, and validation reports for preview and download in Layout & results." : "The user explicitly requests numerical simulation exploration. Simulation and energy are model results, not device-function or sequential-storage signoff. Report numerical anomalies and provide actual result files.",
    ...(request.note.trim() ? ["Additional design requirements:\n" + request.note.trim()] : []),
  ].join("\n\n");
  return [
    "请由 iFCN 主智能体完成这次电路设计。输入已经保存为独立快照，请使用此文件，不要覆盖原电路。",
    request.mode === "auto" ? "请先读取电路与 ifcn_capabilities，识别组合或时序语义，再为 ifcn_run 明确填写 combinational 或 sequential。auto 仅是本次识别要求，绝不是 design_type 的合法参数。" : `电路模式已指定为 ${request.mode}；先确认实际 RTL 语义与能力是否一致。`,
    "本次设计参数：\n" + JSON.stringify(parameters, null, 2),
    "clock_scheme 是用户的硬约束，算法自动选择也必须受它限制。禁止更换时钟、禁用或绕过 DRC；不兼容或验证失败时报告原因并保留失败结果。所有被接受的候选必须通过现有布线、时钟、端口和映射检查。",
    "先解析并报告实际 DAG 门数及适用规模；规则启发式当前限小规模（不超过 50 个逻辑门），图算法的中大规模尚未验证，不得把样本成功称为整档支持。",
    "组合电路分别报告源电路与布线 DAG 逻辑检查、实际 QCA 元胞与端口检查；时序保留状态边界和反馈，区分 SeqIR→状态切分 DAG 的一拍检查与未完成的原 RTL 独立等价和状态器件物理签核。",
    request.until === "map" ? "本次运行到器件映射；请提供真实 SVG、QCA 与检查报告，供版图与结果页面预览下载。" : "用户明确请求数值仿真探索。仿真或能耗是模型结果，不能替代器件功能或时序存储签核；报告数值异常并提供真实结果文件。",
    ...(request.note.trim() ? ["用户补充设计要求：\n" + request.note.trim()] : []),
  ].join("\n\n");
}

export function loadIfcnSourceDraft<T extends IfcnDesignRequest & { source: string; path: string; name: string }>(current: T, source: { source: string; path: string; name: string }): T {
  return { ...current, ...source, mode: "auto", algorithm: "auto" };
}
