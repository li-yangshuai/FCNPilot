// Match iFCN Qt src/config.h and src/ui/items/QCADCellItem.cpp::paint.
// Qt colours cells by role first, then clock phase; serialized QCA clr.* is not used.
export const IFCN_CLOCK_COLORS = ["#86e291", "#ffa5fa", "#00c8bc", "#f2f2f2"] as const;
// Qt src/ui/widgets/CircuitSchematicView.cpp::clockColor uses lighter gate-grid backgrounds.
export const IFCN_GATE_CLOCK_COLORS = ["#e1f6e2", "#f7e4fa", "#e0f5f9", "#fffae0"] as const;
export const IFCN_CELL_COLORS = { input: "#008dc8", output: "#e28686", fixed: "#000000", unknown: "#87929c" } as const;

export function ifcnClockColor(phase: number | null, count = 4): string {
  if (phase === null || !Number.isInteger(phase) || phase < 0 || phase >= count) return IFCN_CELL_COLORS.unknown;
  return count === 4 ? IFCN_CLOCK_COLORS[phase] : `hsl(${Math.round(phase * 360 / count)} 52% 46%)`;
}

export function ifcnCellColor(phase: number | null, role: string): string {
  if (role === "QCAD_CELL_INPUT") return IFCN_CELL_COLORS.input;
  if (role === "QCAD_CELL_OUTPUT") return IFCN_CELL_COLORS.output;
  if (role === "QCAD_CELL_FIXED") return IFCN_CELL_COLORS.fixed;
  return ifcnClockColor(phase);
}

export function ifcnGateClockColor(phase: number, count = 4): string {
  return count === 4 && Number.isInteger(phase) && phase >= 0 && phase < 4
    ? IFCN_GATE_CLOCK_COLORS[phase] : ifcnClockColor(phase, count);
}
