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

function scalePolicy(value: unknown): IfcnScalePolicy {
  const policy = record(value);
  const small = nonnegativeInteger(policy.small_max);
  const medium = nonnegativeInteger(policy.medium_max);
  const valid = small !== null && small > 0 && medium !== null && medium > small;
  return { metric: text(policy.metric) || "dag_gate_nodes", smallMax: valid ? small : 50, mediumMax: valid ? medium : 500,
    note: text(policy.note) || "按逻辑 DAG 的门节点数量划分工作台规模；分档不代表性能保证或对整档电路的支持承诺。" };
}

function coverage(value: unknown): IfcnScaleCoverage {
  const data = record(value);
  const benchmarkCount = nonnegativeInteger(data.benchmark_count), maxGateNodes = nonnegativeInteger(data.max_gate_nodes);
  const incompleteEvidence = data.status === "validated_samples" && (benchmarkCount === null || benchmarkCount === 0 || maxGateNodes === null);
  const status = !incompleteEvidence && (data.status === "validated_samples" || data.status === "candidate" || data.status === "out_of_scope") ? data.status : "unassessed";
  return { status, benchmarkCount, maxGateNodes,
    note: incompleteEvidence ? "目录缺少样本数量或门数记录，暂按未评估展示。" : text(data.note) || (status === "validated_samples" ? "验证结论限于已测样本及其约束。" : "尚无本档电路的验证记录。") };
}

export function ifcnScaleLabel(scale: IfcnScale, policy: IfcnScalePolicy): string {
  return scale === "small" ? `≤ ${policy.smallMax} 门` : scale === "medium" ? `${policy.smallMax + 1}–${policy.mediumMax} 门` : `> ${policy.mediumMax} 门`;
}

export function clockSchemeLabel(value: unknown): string | null {
  const scheme = text(value);
  if (!scheme) return null;
  return scheme.toLowerCase() === "irregular" ? "非规则 / 自由时钟" : scheme;
}

export function clockFamilyLabel(family: string, declaredLabel?: unknown): string {
  return ({ rule_based: "规则时钟模板", irregular: "非规则相位分配", configurable: "可配置 / 多种时钟", sampled: "采样时钟场", not_applicable: "不涉及器件时钟", unclassified: "时钟方案未分类" } as Record<string, string>)[family] || text(declaredLabel) || family;
}

/** Catalog labels come from the audited engine metadata, not a browser algorithm inventory. */
export function readIfcnAlgorithmCatalog(capabilities: unknown): IfcnAlgorithmCatalog {
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
      id, name: text(item.name) || id,
      method: text(item.method) || "unclassified",
      methodLabel: text(item.method_label) || text(item.method) || "方法待分类",
      clockFamily,
      clockFamilyLabel: clockFamilyLabel(clockFamily, item.clock_family_label),
      clockLabel: text(item.clock_label) || clockSchemeLabel(legacyClock) || (text(item.clock_family) === "not_applicable" ? "不涉及器件时钟" : text(item.clock_family) || "时钟方案未记录"),
      description: text(item.description) || "当前能力目录尚未提供说明。",
      integrated,
      available: modeAllowed && integrated && !!runAlgorithm && item.available === true && executable?.available === true,
      runAlgorithm,
      sourcePaths: Array.isArray(item.source_paths) ? item.source_paths.flatMap((path) => text(path) ? [text(path)!] : []) : [],
      sourceRepository: text(item.source_repository) || text(item.origin),
      evidenceSourcePaths: Array.isArray(item.evidence_source_paths) ? item.evidence_source_paths.flatMap((path) => text(path) ? [text(path)!] : []) : [],
      originBranch: text(item.origin_branch), originCommit: text(item.origin_commit),
      entryKind: text(item.entry_kind) || (declared ? "unspecified" : "backend"),
      scope: text(item.scope),
      designModes,
      scaleCoverage: { small: coverage(record(item.scale_coverage).small), medium: coverage(record(item.scale_coverage).medium), large: coverage(record(item.scale_coverage).large) },
    }];
  });
  return { entries, complete: declared !== null, autoPolicy: text(data.auto_policy), scalePolicy: scalePolicy(data.scale_policy) };
}

export function filterIfcnAlgorithms(entries: IfcnAlgorithm[], filters: { method?: string; clock?: string; integration?: string; query?: string }) {
  const query = (filters.query || "").trim().toLocaleLowerCase();
  return entries.filter((entry) => (!filters.method || entry.method === filters.method)
    && (!filters.clock || entry.clockFamily === filters.clock)
    && (!filters.integration || (filters.integration === "integrated" ? entry.integrated : !entry.integrated))
    && (!query || [entry.name, entry.id, entry.description, entry.methodLabel, entry.clockLabel, entry.sourceRepository, ...entry.sourcePaths].join(" ").toLocaleLowerCase().includes(query)));
}
