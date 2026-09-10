// Exact translations of audited metadata; unknown text never implies new capabilities.
const CATALOG_EN: Record<string, string> = {
  "固定时钟图压缩": "Fixed-clock graph compaction",
  "仅规则四相 2DDWave": "Regular four-phase 2DDWave only",
  "Graphviz 分层与 sifting 排序、右下单调寻路、失败驱动扩展和合法性约束压缩；相位由坐标模板确定。": "Graphviz layering and sifting, monotone right/down routing, failure-driven expansion, and constrained compaction. Coordinate templates determine the phases.",
  "图绘制 / 布线后时钟分配": "Graph drawing / post-route phase assignment",
  "非规则四相 / 布线后分配": "Irregular four-phase / post-route assignment",
  "紧凑分层初始布局、四方向 A*、容量压力驱动扩展和压缩，再按路径约束分配相位；未使用预采样随机时钟场。": "Compact layered placement, four-direction A*, capacity-driven expansion and compaction, followed by phase assignment under path constraints. No presampled random clock field is used.",
  "Graphviz 坐标量化、四方向 A* 与有界布线顺序重试，再分配和验证相位；历史名称中的 random-clock 指自由相位，不能等同于随机时钟场采样。": "Quantized Graphviz coordinates, four-direction A*, and bounded routing-order retries, followed by phase assignment and validation. The historical name random-clock means free phase assignment, not clock-field sampling.",
  "启发式布线 / 全局时钟约束": "Heuristic routing / global clock constraints",
  "反馈路径四相 / epoch 与启动间隔": "Four-phase feedback / epochs and initiation interval",
  "将显式状态边界接回物理反馈路径，搜索可行启动间隔并验证全局相位约束；输出候选布局与状态映射证据，不能等同于状态器件或时序波形签核。": "Reconnects explicit state boundaries through physical feedback paths, searches feasible initiation intervals, and checks global phase constraints. Produces layout candidates and state-mapping evidence, not physical signoff for state devices or sequential waveforms.",
  "规则时钟启发式布局布线": "Regular-clock heuristic P&R",
  "小规模规则时钟启发式": "Small-circuit regular-clock heuristic",
  "规则 2DDWave / USE / RES": "Regular 2DDWave / USE / RES",
  "在所选规则模板下做有种子的有限种群布局搜索。先检查完整连线、端口、交叉、器件映射、逐步相位与重汇合同步，再比较面积和器件数；初版最多50个源门节点，仅小型电路有回归证据。不支持未实现的任意模板。": "Seeded, bounded population search under a selected regular template. Checks complete routing, ports, crossings, device mapping, phase progression, and reconvergent timing before comparing area and cell count. Limited to 50 source gate nodes; regression evidence covers only small examples. Arbitrary unimplemented templates are unsupported.",
  "强化学习 / 策略搜索": "Reinforcement learning / policy search",
  "动态非规则相位": "Dynamic irregular phases",
  "原 iFCN 的在线布局训练与压缩策略，使用 GCN 初始表示、PPO 更新和 MapPhaseAStar 评估；默认动态相位与固定采样场是不同配置。训练代码和 GUI runner 保留在原仓库，尚未接入主智能体。": "Legacy iFCN online placement training and compaction using GCN representations, PPO updates, and MapPhaseAStar evaluation. Dynamic phases and fixed sampled fields are separate configurations. Training code and the GUI runner remain in the original repository and are not integrated with the main agent.",
  "采样因果时钟场 / axis / diagonal": "Sampled causal clock fields / axis / diagonal",
  "原 iFCN 的循环图策略结合检索记忆，在固定采样场上生成候选并做真实布线评估；支持 stochastic-bands、axis、diagonal 和三/四相。需要原工程依赖、checkpoint 与适配，当前未接入。": "Legacy iFCN recurrent graph policy with retrieval memory generates candidates on fixed sampled fields and evaluates actual routing. Supports stochastic-bands, axis, diagonal, and three/four phases. Requires the original dependencies, checkpoints, and adaptation; not currently integrated.",
  "SMT 约束求解": "SMT constraint solving",
  "固定布线几何上的相位 / epoch 约束": "Phase / epoch constraints on fixed routing geometry",
  "原 iFCN 的 Z3 脚本对已布线几何求解全局时钟问题，再由 C++ 验证。外部 Z3 包装脚本尚未接入主智能体；当前时序入口使用原生有界相位求解。该组件不独立完成布局布线。": "The original iFCN Z3 script solves global clocks on routed geometry, followed by C++ validation. The external wrapper is not integrated; the current sequential flow uses a native bounded phase solver. This component does not perform standalone placement and routing.",
  "启发式布局布线": "Heuristic placement and routing",
  "寻路时相位约束": "Phase constraints during routing",
  "CircuitGraph 中保留的相位感知路由及压缩变体，使用多种边排序和有界相位候选搜索；库代码已保留，但没有独立主智能体运行选项。": "Phase-aware routing and compaction variants retained in CircuitGraph, with multiple edge orders and bounded phase-candidate searches. Library code is retained, but no standalone main-agent run option is available.",
  "路径搜索组件": "Path-search components",
  "规则或动态相位 / 依调用者约束": "Regular or dynamic phases / caller constraints",
  "通用 A*、PhaseAwareAstar、MapPhaseAStar 和右下单调路由组件。现有后端会使用其中部分；RightDownAStar 也包含直连与动态规划快路径。这些组件不是额外端到端算法。": "General A*, PhaseAwareAstar, MapPhaseAStar, and monotone right/down routing components. Existing backends use some of them; RightDownAStar also has direct-connection and dynamic-programming fast paths. These are not additional end-to-end algorithms.",
  "拥塞协商路由组件": "Congestion-negotiation routing component",
  "固定 2DDWave": "Fixed 2DDWave",
  "原 iFCN 中基于有界单调 L/Z 候选与历史拥塞代价的全局协商路由器。version1.1 曾将其接入 NormalGraphDraw，后续主线仅保留库；不是网格 A* 或独立布局算法，未复制到 FCNPilot。": "Legacy iFCN global negotiated router using bounded monotone L/Z candidates and historical congestion costs. Integrated with NormalGraphDraw in version1.1, then retained only as a library. It is neither grid A* nor standalone placement, and has not been copied into FCNPilot.",
  "层内交叉优化组件": "Within-layer crossing optimization",
  "拓扑排序 / 不直接分配时钟": "Topological ordering / no direct clock assignment",
  "version1.1 的 Python 入口调用 OGDF 固定层交叉优化工具；后续主线改为 Graphviz 与 sifting，OGDF 工具源码仍保留在原仓库。只调整层内顺序，不是完整布局布线后端。": "The version1.1 Python entry called OGDF fixed-layer crossing optimization. Later versions switched to Graphviz and sifting; OGDF source remains in the original repository. Only adjusts within-layer order, not a complete placement and routing backend.",
  "器件仿真 / 物理相互作用图": "Device simulation / physical interaction graph",
  "沿用输入 QCA 版图的四相时钟": "Four-phase clocks from the input QCA layout",
  "从 version1.2 选择性合入的有序物理相互作用图、介电参数扫描复用、缓存与积分开关，以及完整内部轨迹比较。已用于物理仿真程序，不是新的布局布线选项；适用规模需按器件数、耦合数和采样长度另行评估。": "Selected version1.2 changes include ordered physical interaction graphs, reuse across dielectric-parameter sweeps, cache and integration options, and full internal-trajectory comparison. Used by the physical simulator, not a new placement option. Scale must be assessed separately by cell count, coupling count, and sample length.",
  "时钟模板 / 场生成组件": "Clock-template / field-generation components",
  "TDD / USE / RES / 原始随机场": "TDD / USE / RES / original random fields",
  "保留规则模板与 RandomClock 随机 4×4 块编码器。随机生成本身不保证可布线或因果合法；这些库策略不是可直接切换的完整设计流程。BANCS/CFE 仅有枚举，SplicingClock 仅为硬编码示例。": "Retained regular templates and a RandomClock encoder for random 4×4 blocks. Random generation alone guarantees neither routability nor causality. These library strategies are not selectable complete design flows. BANCS/CFE are enums only; SplicingClock is a hardcoded example.",
  "冻结生产记录中 1 个去重源电路通过布线逻辑等价与器件端口计数检查；不代表完整波形签核。": "One source-deduplicated circuit in frozen production records passed routed-logic equivalence and device-terminal count checks. This does not establish complete waveform signoff.",
  "冻结生产记录中 2 个去重源电路（4—26 个 DAG 门节点）通过布线逻辑等价与器件端口计数检查；不代表完整波形签核。": "Two source-deduplicated circuits (4–26 DAG gate nodes) in frozen production records passed routed-logic equivalence and device-terminal count checks. This does not establish complete waveform signoff.",
  "基础组件没有独立的门数覆盖范围。": "Components have no standalone gate-count coverage.",
  "尚无当前入口在该门数分档下的已验证样本。": "No validated samples for this entry are available in this gate-count tier.",
  "可作为该分档的候选实现；可调用不代表整个分档均能成功。": "A candidate implementation for this tier. Being callable does not establish success for every circuit in the tier.",
  "当前规则时钟启发式入口最多50个源门节点。": "The current regular-clock heuristic entry is limited to 50 source gate nodes.",
  "三种模板的AND、NOT、AND-OR小电路回归通过；不代表整个小规模档位都能布通，也不代替器件波形验证。": "AND, NOT, and AND-OR regression examples passed under all three templates. This does not establish routability across the entire small tier or replace device-waveform validation.",
  "同步复位 toggle、enable-hold 与 Johnson4 的 RTL→QCA 集成回归已通过，包含单状态及四状态反馈；尚未冻结规模覆盖产物，当前输出仍是未表征状态器件的布局候选。": "RTL-to-QCA integration regressions passed for synchronous-reset toggle, enable-hold, and Johnson4, including one-state and four-state feedback. Size-coverage artifacts are not yet frozen; outputs remain layout candidates with uncharacterized state devices.",
  "尚无当前入口的大规模成功证据。": "No evidence of large-circuit success is available for the current entry.",
  "按逻辑 DAG 的门节点数量划分工作台规模；分档不代表性能保证或对整档电路的支持承诺。": "Workspace size tiers count logic DAG gate nodes. Tiers provide no performance guarantee or claim of support for every circuit in a tier.",
  "目录缺少样本数量或门数记录，暂按未评估展示。": "The catalog lacks sample-count or gate-count records; coverage is shown as unassessed.",
  "验证结论限于已测样本及其约束。": "Validation conclusions apply only to the tested samples and their constraints.",
  "尚无本档电路的验证记录。": "No validation records are available for this size tier.",
  "非规则 / 自由时钟": "Irregular / free-phase clocks",
  "规则时钟模板": "Regular clock templates",
  "非规则相位分配": "Irregular phase assignment",
  "可配置 / 多种时钟": "Configurable / multiple clocks",
  "采样时钟场": "Sampled clock fields",
  "不涉及器件时钟": "No device clock",
  "时钟方案未分类": "Unclassified clock scheme",
  "时钟方案未记录": "Clock scheme not reported",
  "方法待分类": "Unclassified method",
  "当前能力目录尚未提供说明。": "No description is provided in the current capability catalog.",
  "启发式": "Heuristics",
  "学习方法": "Learning methods",
  "约束求解": "Constraint solving",
  "2DDWave 规则时钟": "Regular 2DDWave clocks",
  "随机采样时钟场": "Randomly sampled clock fields",
  "可配置时钟": "Configurable clocks",
  "USE / RES 规则时钟": "Regular USE / RES clocks",
  "由调用方指定时钟": "Caller-specified clocks"
};

const SCALE_POLICY_EN = "Workspace bins count non-input logic DAG nodes, not a capacity guarantee. Sequential size uses the state-cut DAG; state bits are reported separately.";
const SCALE_POLICY_ZH = "按非输入逻辑 DAG 节点数量划分工作台规模，不代表容量保证。时序电路使用状态切分 DAG 的门数，状态位另行报告。";

function localizedCatalogText(value: string, locale: string, fallback: string): string {
  if (locale === "zh-CN") return value === SCALE_POLICY_EN ? SCALE_POLICY_ZH : value;
  return CATALOG_EN[value] || (/\p{Script=Han}/u.test(value) ? fallback : value);
}

export type IfcnDesignMode = "combinational" | "sequential";
export type IfcnScale = "small" | "medium" | "large";
export interface IfcnScalePolicy {
  metric: string;
  smallMax: number;
  mediumMax: number;
  note: string;
}
export interface IfcnScaleCoverage {
  status: "validated_samples" | "candidate" | "unassessed" | "out_of_scope";
  benchmarkCount: number | null;
  maxGateNodes: number | null;
  note: string;
}

export interface IfcnAlgorithm {
  id: string;
  name: string;
  method: string;
  methodLabel: string;
  clockFamily: string;
  clockFamilyLabel: string;
  clockLabel: string;
  description: string;
  integrated: boolean;
  available: boolean;
  runAlgorithm: string | null;
  sourcePaths: string[];
  sourceRepository: string | null;
  evidenceSourcePaths: string[];
  originBranch: string | null;
  originCommit: string | null;
  entryKind: string;
  scope: string | null;
  designModes: IfcnDesignMode[];
  scaleCoverage: Record<IfcnScale, IfcnScaleCoverage>;
  originalReport: string | null;
}

export interface IfcnAlgorithmCatalog {
  entries: IfcnAlgorithm[];
  complete: boolean;
  autoPolicy: string | null;
  scalePolicy: IfcnScalePolicy;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function scalePolicy(value: unknown, locale: string): IfcnScalePolicy {
  const policy = record(value);
  const small = nonnegativeInteger(policy.small_max);
  const medium = nonnegativeInteger(policy.medium_max);
  const valid = small !== null && small > 0 && medium !== null && medium > small;
  return { metric: text(policy.metric) || "dag_gate_nodes", smallMax: valid ? small : 50, mediumMax: valid ? medium : 500,
    note: localizedCatalogText(text(policy.note) || "按逻辑 DAG 的门节点数量划分工作台规模；分档不代表性能保证或对整档电路的支持承诺。", locale, "The engine provides an untranslated size policy. Tier labels alone do not establish capacity or validated support.") };
}

function coverage(value: unknown, locale: string): IfcnScaleCoverage {
  const data = record(value);
  const benchmarkCount = nonnegativeInteger(data.benchmark_count), maxGateNodes = nonnegativeInteger(data.max_gate_nodes);
  const incompleteEvidence = data.status === "validated_samples" && (benchmarkCount === null || benchmarkCount === 0 || maxGateNodes === null);
  const status = !incompleteEvidence && (data.status === "validated_samples" || data.status === "candidate" || data.status === "out_of_scope") ? data.status : "unassessed";
  return { status, benchmarkCount, maxGateNodes,
    note: localizedCatalogText(incompleteEvidence ? "目录缺少样本数量或门数记录，暂按未评估展示。" : text(data.note) || (status === "validated_samples" ? "验证结论限于已测样本及其约束。" : "尚无本档电路的验证记录。"), locale, "See the original engine report for this evidence note. The displayed status and counts do not establish support for every circuit in the tier.") };
}

export function ifcnScaleLabel(scale: IfcnScale, policy: IfcnScalePolicy, locale = "zh-CN"): string {
  const unit = locale === "zh-CN" ? "门" : "gates";
  return scale === "small" ? `≤ ${policy.smallMax} ${unit}` : scale === "medium" ? `${policy.smallMax + 1}–${policy.mediumMax} ${unit}` : `> ${policy.mediumMax} ${unit}`;
}

export function clockSchemeLabel(value: unknown, locale = "zh-CN"): string | null {
  const scheme = text(value);
  if (!scheme) return null;
  return localizedCatalogText(scheme.toLowerCase() === "irregular" ? "非规则 / 自由时钟" : scheme, locale, "Untranslated clock scheme");
}

export function clockFamilyLabel(family: string, declaredLabel?: unknown, locale = "zh-CN"): string {
  const label = ({ rule_based: "规则时钟模板", irregular: "非规则相位分配", configurable: "可配置 / 多种时钟", sampled: "采样时钟场", not_applicable: "不涉及器件时钟", unclassified: "时钟方案未分类" } as Record<string, string>)[family] || text(declaredLabel) || family;
  return localizedCatalogText(label, locale, /\p{Script=Han}/u.test(family) ? "Unclassified clock family" : family);
}

/** Catalog labels come from the audited engine metadata, not a browser algorithm inventory. */
export function readIfcnAlgorithmCatalog(capabilities: unknown, locale = "zh-CN"): IfcnAlgorithmCatalog {
  const data = record(capabilities);
  const algorithms = Array.isArray(data.algorithms) ? data.algorithms.map(record).filter((item) => text(item.id) && item.id !== "auto") : [];
  const declared = Array.isArray(data.algorithm_catalog) ? data.algorithm_catalog : null;
  const seen = new Set<string>();
  const entries = (declared ?? algorithms).flatMap((value): IfcnAlgorithm[] => {
    const item = record(value);
    const id = text(item.id);
    if (!id || id === "auto" || seen.has(id)) return [];
    seen.add(id);
    const executable = algorithms.find((algorithm) => algorithm.id === (text(item.run_algorithm) || id));
    const integrated = declared ? item.integration === "integrated" : true;
    const runAlgorithm = integrated && text(item.run_algorithm) !== "auto"
      ? text(item.run_algorithm) || (executable ? text(executable.id) : null)
      : null;
    const legacyClock = text(item.clock_scheme);
    const legacyFamily = legacyClock === "2DDWave" ? "rule_based" : legacyClock === "irregular" ? "irregular" : "unclassified";
    const clockFamily = text(item.clock_family) || legacyFamily;
    const designModes: IfcnDesignMode[] = Array.isArray(item.design_modes) ? item.design_modes.filter((mode): mode is IfcnDesignMode => mode === "combinational" || mode === "sequential")
      : !declared && data.combinational && record(data.combinational).supported === true ? ["combinational"] : [];
    const modeAllowed = designModes.length === 0 || designModes.some((mode) => record(data[mode]).supported !== false);
    return [{
      id, name: localizedCatalogText(text(item.name) || id, locale, id),
      method: text(item.method) || "unclassified",
      methodLabel: localizedCatalogText(text(item.method_label) || text(item.method) || "方法待分类", locale, text(item.method) || "Unclassified method"),
      clockFamily,
      clockFamilyLabel: clockFamilyLabel(clockFamily, item.clock_family_label, locale),
      clockLabel: localizedCatalogText(text(item.clock_label) || clockSchemeLabel(legacyClock) || (text(item.clock_family) === "not_applicable" ? "不涉及器件时钟" : text(item.clock_family) || "时钟方案未记录"), locale, "See the original report for clock constraints"),
      description: localizedCatalogText(text(item.description) || "当前能力目录尚未提供说明。", locale, "An untranslated description is available in the original engine report."),
      integrated,
      available: modeAllowed && integrated && !!runAlgorithm && item.available === true && executable?.available === true,
      runAlgorithm,
      sourcePaths: Array.isArray(item.source_paths) ? item.source_paths.flatMap((path) => text(path) ? [text(path)!] : []) : [],
      sourceRepository: text(item.source_repository) || text(item.origin),
      evidenceSourcePaths: Array.isArray(item.evidence_source_paths) ? item.evidence_source_paths.flatMap((path) => text(path) ? [text(path)!] : []) : [],
      originBranch: text(item.origin_branch), originCommit: text(item.origin_commit),
      entryKind: text(item.entry_kind) || (declared ? "unspecified" : "backend"),
      scope: text(item.scope) ? localizedCatalogText(text(item.scope)!, locale, "See the original engine report for the declared scope.") : null,
      designModes,
      originalReport: locale !== "zh-CN" && /\p{Script=Han}/u.test(JSON.stringify(item)) ? JSON.stringify(item, null, 2) : null,
      scaleCoverage: { small: coverage(record(item.scale_coverage).small, locale), medium: coverage(record(item.scale_coverage).medium, locale), large: coverage(record(item.scale_coverage).large, locale) },
    }];
  });
  return { entries, complete: declared !== null, autoPolicy: text(data.auto_policy), scalePolicy: scalePolicy(data.scale_policy, locale) };
}

export function filterIfcnAlgorithms(entries: IfcnAlgorithm[], filters: { method?: string; clock?: string; integration?: string; query?: string }) {
  const query = (filters.query || "").trim().toLocaleLowerCase();
  return entries.filter((entry) => (!filters.method || entry.method === filters.method)
    && (!filters.clock || entry.clockFamily === filters.clock)
    && (!filters.integration || (filters.integration === "integrated" ? entry.integrated : !entry.integrated))
    && (!query || [entry.name, entry.id, entry.description, entry.methodLabel, entry.clockLabel, entry.sourceRepository, ...entry.sourcePaths].join(" ").toLocaleLowerCase().includes(query)));
}
