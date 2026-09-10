function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Missing new certificates do not retroactively turn an old run into a failed run. */
export function readIfcnCombinationalAcceptance(designType: unknown, metrics: unknown, validation: unknown) {
  const data = record(metrics), pnr = record(data.pnr), sequential = record(data.sequential);
  if (designType === "sequential" || pnr.mapping_mode === "sequential" || sequential.mapping_mode === "sequential") return null;
  if (designType !== "combinational" && pnr.mapping_mode !== "combinational") return null;
  const checks = record(validation);
  return [
    { id: "clock_arrival", label: "整周期到达检查", passed: checks.clock_arrival === "cycle_zero_at_template_phase_passed" },
    { id: "physical_routes", label: "跨源 XYZ 隔离与有序路径检查", passed: checks.physical_routes === "source_isolation_and_ordered_paths_passed" },
  ];
}
