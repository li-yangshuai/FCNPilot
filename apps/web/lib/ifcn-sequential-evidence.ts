function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown) { return typeof value === "string" && value ? value : null; }
function count(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }

export function readIfcnStateTransition(metrics: unknown, validation: unknown) {
  const report = record(record(record(metrics).sequential).state_transition);
  const validations = record(validation), sequential = record(validations.sequential);
  const status = text(report.status) || text(sequential.state_transition) || text(validations.sequential_equivalence);
  const scope = text(report.scope) || text(sequential.scope);
  const knownScope = scope === "SeqIR_vs_cut_DAG_one_step_next_state";
  const labels: Record<string, string> = { equivalent: "一拍关系已匹配", not_performed: "尚未执行", invalid: "检查报告无效", mismatch: "一拍关系不匹配" };
  return {
    status, statusLabel: status ? labels[status] || `未识别状态：${status}` : "尚无检查记录",
    scope, scopeLabel: knownScope ? "SeqIR → 状态切分 DAG 一拍检查" : scope ? `状态转移检查范围：${scope}` : "状态转移检查（范围未记录）",
    knownScope, vectorsChecked: count(report.vectors_checked), stateBits: count(report.state_bits), inputBits: count(report.input_bits), gateNodes: count(report.gate_nodes),
    rtlEquivalence: text(sequential.rtl_equivalence), physicalStateSignoff: text(sequential.physical_state_signoff),
  };
}
