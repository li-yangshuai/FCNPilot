import type { Locale } from "./i18n/types";
import { fcnResultsEn, fcnResultsZh } from "./i18n/messages/fcn-results";
import type { IfcnRunDetail } from "./ifcn-results-types";

const optimizationText = (locale: Locale, key: string) => (locale === "en" ? fcnResultsEn : fcnResultsZh)[`fcn.results.optimization.${key}`];

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function ifcnOptimizationAvailability(run: IfcnRunDetail, locale: Locale = "zh-CN"): { available: boolean; reason: string } {
  if (!/^[a-f0-9]{32}$/.test(run.id)) return { available: false, reason: optimizationText(locale, "invalidRun") };
  if (run.designType !== "combinational") return { available: false, reason: optimizationText(locale, "combinationalOnly") };
  const pnr = record(run.metrics.pnr);
  if (pnr.clock_scheme !== "irregular" || !["compact", "june_random"].includes(String(pnr.algorithm))) return { available: false, reason: optimizationText(locale, "irregularOnly") };
  if (!["completed", "completed_with_warnings"].includes(run.status)) return { available: false, reason: optimizationText(locale, "awaitComplete") };
  if (run.validation.clock_arrival !== "cycle_zero_at_template_phase_passed" || run.validation.physical_routes !== "source_isolation_and_ordered_paths_passed" || run.validation.rtl_equivalence !== "exhaustive_scalar_source_vs_routed_dag") return { available: false, reason: optimizationText(locale, "missingEvidence") };
  const names = new Set(run.artifacts.map((item) => item.name));
  if (!names.has("layout_candidate.json")) return { available: false, reason: optimizationText(locale, "missingSnapshot") };
  if (!["layout.ifcn", "normalized.v", "routed_dag.json", "source.v", "clock.json", "physical.json"].every((name) => names.has(name)) || (!names.has("device.qca") && !names.has("validated_device.qca"))) return { available: false, reason: optimizationText(locale, "incompleteArtifacts") };
  return { available: true, reason: optimizationText(locale, "ready") };
}
export function buildIfcnOptimizationPrompt(run: IfcnRunDetail, locale: Locale = "zh-CN"): string {
  const availability = ifcnOptimizationAvailability(run, locale);
  if (!availability.available) throw new Error(availability.reason);
  return [
    optimizationText(locale, "promptIntro"),
    optimizationText(locale, "promptBaseline"),
    JSON.stringify({ action: "optimize", run_id: run.id, optimization_policy: "llm", optimization_rounds: 3, timeout_s: 20, proposal_timeout_s: 60 }, null, 2),
    optimizationText(locale, "promptConstraints"),
    optimizationText(locale, "promptProposals"),
    optimizationText(locale, "promptRecords"),
    optimizationText(locale, "promptFinish"),
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
