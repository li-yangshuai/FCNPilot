import type { IfcnRunDetail } from "./ifcn-results-types";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function ifcnOptimizationAvailability(run: IfcnRunDetail): { available: boolean; reason: string } {
  if (!/^[a-f0-9]{32}$/.test(run.id)) return { available: false, reason: "运行编号无效。" };
  if (run.designType !== "combinational") return { available: false, reason: "当前优化入口仅支持已认证的组合电路。" };
  const pnr = record(run.metrics.pnr);
  if (pnr.clock_scheme !== "irregular" || !["compact", "june_random"].includes(String(pnr.algorithm))) return { available: false, reason: "当前优化入口仅支持 Compact / June 的非规则时钟版图；规则时钟暂不开放。" };
  if (!["completed", "completed_with_warnings"].includes(run.status)) return { available: false, reason: "请等待当前电路流程完成；未通过或进行中的记录不能作为优化基线。" };
  if (run.validation.clock_arrival !== "cycle_zero_at_template_phase_passed" || run.validation.physical_routes !== "source_isolation_and_ordered_paths_passed" || run.validation.rtl_equivalence !== "exhaustive_scalar_source_vs_routed_dag") return { available: false, reason: "该记录缺少当前整周期到达、物理路径或源电路穷举等价证据，请先生成通过新增验收的基线。" };
  const names = new Set(run.artifacts.map((item) => item.name));
  if (!names.has("layout_candidate.json")) return { available: false, reason: "该记录缺少已登记的可编辑版图快照，请先生成包含快照的新基线。" };
  if (!["layout.ifcn", "normalized.v", "routed_dag.json", "source.v", "clock.json", "physical.json"].every((name) => names.has(name)) || (!names.has("device.qca") && !names.has("validated_device.qca"))) return { available: false, reason: "该记录的版图或验收产物不完整，暂不能开始优化。" };
  return { available: true, reason: "运行 3 轮 LLM 节点调整实验；每轮保留建议、实际移动、规则检查和指标。执行前再次校验基线文件。" };
}
export function buildIfcnOptimizationPrompt(run: IfcnRunDetail): string {
  const availability = ifcnOptimizationAvailability(run);
  if (!availability.available) throw new Error(availability.reason);
  return [
    "请由 iFCN 主智能体优化我在结果页选中的已认证组合电路版图。目标是减少门级面积和实际 QCA 元胞，并明确展示实际改了哪些节点。",
    "仅使用以下已登记运行作为基线，先通过 ifcn_status 复核状态及证据，再调用现有 ifcn_run：",
    JSON.stringify({ action: "optimize", run_id: run.id, optimization_policy: "llm", optimization_rounds: 3, timeout_s: 20, proposal_timeout_s: 60 }, null, 2),
    "保持基线算法、非规则时钟方案与原电路逻辑不变。禁止绕过 DRC、整周期到达、源间物理隔离或穷举等价检查；只接纳通过全部验证且面积与元胞数均不增加、至少一项严格减少的候选。",
    "LLM 必须真实提出节点移动或交换建议；若模型不可用或调用失败，请报告实际失败，不能用随机、无操作或贪心策略冒充 LLM。候选布线及相位修复由确定性执行器完成，总收益不能全部归因于 LLM。",
    "保留基线和每轮原始请求、模型响应、结构化建议、实际节点移动、重新布线、相位变化、拒绝理由和指标；包括未通过、超时及没有改善的候选。提供 campaign.json 和真实版图、日志供结果页对照下载，不覆盖原基线。",
    "完成后报告每轮结果及最终选择；没有严格改善时明确说明仍保留基线。",
  ].join("\n\n");
}


export async function reloadIfcnOptimizationSession(
  sessionId: string | null,
  getState: (sessionId: string) => Promise<unknown>,
  reload: () => Promise<{ handled: boolean; error?: string }>,
): Promise<void> {
  // A session created by the following prompt loads current resources at creation.
  if (!sessionId) return;
  const state = record(await getState(sessionId));
  if (state.isStreaming !== false || state.isCompacting !== false || state.isPromptRunning !== false || Number(state.pendingMessageCount || 0) > 0) {
    throw new Error("当前会话正在运行或无法确认空闲，请稍后再优化布局。");
  }
  const result = await reload();
  if (!result.handled || result.error) throw new Error(result.error || "主智能体能力刷新未完成，优化请求尚未发送。");
}
