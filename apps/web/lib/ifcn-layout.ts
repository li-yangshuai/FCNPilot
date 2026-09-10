export interface QcaDot {
  x: number;
  y: number;
  diameter: number;
}

export interface QcaCell {
  x: number;
  y: number;
  width: number;
  height: number;
  clock: number | null;
  role: string;
  label: string;
  layer: number;
  dots: QcaDot[];
}

export interface QcaLayout {
  cells: QcaCell[];
  layers: { id: number; name: string }[];
}

const MAX_TEXT_LENGTH = 8 * 1024 * 1024;
const MAX_CELLS = 10_000;

function coordinate(value: string | undefined, field: string) {
  const result = value?.trim() ? Number(value) : NaN;
  if (!Number.isFinite(result) || Math.abs(result) > 1e9) {
    throw new Error(`QCA 文件中的 ${field} 坐标或尺寸无效。请下载原文件检查。`);
  }
  return result;
}

/** Reads exported QCADesigner geometry, without reconstructing cells or routes. */
export function parseQcaLayout(source: string): QcaLayout {
  if (source.length > MAX_TEXT_LENGTH) throw new Error("QCA 文件过大，请下载后在版图工具中打开。");
  const cells: QcaCell[] = [];
  const layers: QcaLayout["layers"] = [];
  let layerIndex = -1;
  let layerName = "";
  let cellFields: Record<string, string> | null = null;
  let geometry: Record<string, string> | null = null;
  let dot: Record<string, string> | null = null;
  let dots: QcaDot[] = [];
  let label = "";
  const stack: string[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const opening = /^\[TYPE:([^\]]+)\]$/.exec(line);
    if (opening) {
      const type = opening[1];
      if (type === "QCADLayer") {
        if (cellFields) throw new Error("QCA 元胞结构不完整。");
        layerIndex += 1;
        layerName = `版图层 ${layerIndex + 1}`;
      }
      if (type === "QCADCell") {
        if (cellFields) throw new Error("QCA 元胞结构不完整。");
        cellFields = {};
        geometry = {};
        dots = [];
        label = "";
      }
      if (type === "CELL_DOT" && cellFields) dot = {};
      stack.push(type);
      continue;
    }
    const closing = /^\[#TYPE:([^\]]+)\]$/.exec(line);
    if (closing) {
      const type = closing[1];
      if (stack.pop() !== type) throw new Error("QCA 文件的版图结构不完整。");
      if (type === "CELL_DOT" && dot && cellFields) {
        const diameter = coordinate(dot.diameter, "量子点直径");
        if (diameter <= 0) throw new Error("QCA 量子点直径必须大于零。");
        dots.push({ x: coordinate(dot.x, "量子点 x"), y: coordinate(dot.y, "量子点 y"), diameter });
        if (dots.length > 16) throw new Error("该 QCA 元胞格式暂不支持预览，请下载原文件。");
        dot = null;
      }
      if (type === "QCADCell" && cellFields && geometry) {
        if (cells.length >= MAX_CELLS) throw new Error("版图超过 10,000 个元胞，请下载后在版图工具中打开。");
        const width = coordinate(cellFields["cell_options.cxCell"], "元胞宽度");
        const height = coordinate(cellFields["cell_options.cyCell"], "元胞高度");
        if (width <= 0 || height <= 0) throw new Error("QCA 元胞尺寸必须大于零。");
        const rawClock = cellFields["cell_options.clock"];
        const clock = rawClock?.trim() ? Number(rawClock) : NaN;
        cells.push({
          x: coordinate(geometry.x, "元胞 x"), y: coordinate(geometry.y, "元胞 y"), width, height,
          clock: Number.isInteger(clock) && clock >= 0 && clock <= 255 ? clock : null,
          role: cellFields.cell_function || "QCAD_CELL_NORMAL", label, layer: layerIndex, dots,
        });
        if (!layers.some((layer) => layer.id === layerIndex)) layers.push({ id: layerIndex, name: layerName || "元胞层" });
        cellFields = null;
        geometry = null;
      }
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    const parent = stack[stack.length - 1];
    if (!cellFields && parent === "QCADLayer" && key === "pszDescription") layerName = value.slice(0, 200);
    if (!cellFields) continue;
    if (parent === "QCADCell") cellFields[key] = value;
    if (parent === "QCADDesignObject" && stack[stack.length - 2] === "QCADCell" && geometry) geometry[key] = value;
    if (parent === "CELL_DOT" && dot) dot[key] = value;
    if (parent === "QCADLabel" && key === "psz") label = value.slice(0, 200);
  }
  if (cellFields || stack.length) throw new Error("QCA 文件的版图结构不完整。");
  if (!cells.length) throw new Error("文件中没有可显示的 QCA 元胞。");
  return { cells, layers };
}

export function qcaBounds(cells: QcaCell[]) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const cell of cells) {
    left = Math.min(left, cell.x - cell.width / 2);
    top = Math.min(top, cell.y - cell.height / 2);
    right = Math.max(right, cell.x + cell.width / 2);
    bottom = Math.max(bottom, cell.y + cell.height / 2);
    for (const dot of cell.dots) {
      left = Math.min(left, dot.x - dot.diameter / 2);
      top = Math.min(top, dot.y - dot.diameter / 2);
      right = Math.max(right, dot.x + dot.diameter / 2);
      bottom = Math.max(bottom, dot.y + dot.diameter / 2);
    }
  }
  if (!cells.length) return { x: 0, y: 0, width: 100, height: 100 };
  const pad = Math.max(12, Math.max(right - left, bottom - top) * 0.035);
  return { x: left - pad, y: top - pad, width: right - left + 2 * pad, height: bottom - top + 2 * pad };
}
