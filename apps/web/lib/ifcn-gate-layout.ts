export const IFCN_GATE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 5000, MAX_ROUTES = 10000, MAX_POINTS = 100000, MAX_PHASES = 20000;
export interface IfcnPoint { x: number; y: number; }
export interface IfcnGate extends IfcnPoint { id: number; name: string; kind: string; }
export interface IfcnRoute { source: number; target: number; points: IfcnPoint[]; iterationDistance: number; }
export interface IfcnGateLayout {
  nodes: IfcnGate[]; routes: IfcnRoute[]; phases: (IfcnPoint & { phase: number })[];
  phaseCount: number; clockScheme: string | null; crossings: (IfcnPoint & { routeIndices: number[] })[];
  bounds: { x: number; y: number; width: number; height: number };
  physicalLayersRecorded: false;
}
const key = (p: IfcnPoint) => `${p.x},${p.y}`;
const integer = (value: string, label: string, max = 1_000_000) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || Math.abs(number) > max) throw new Error(`IFCN ${label}超出预览范围。`);
  return number;
};

/** Parse only the native IFCN node/path/phase records; do not infer missing geometry or physical Z layers. */
export function parseIfcnGateLayout(source: string): IfcnGateLayout {
  if (source.length > IFCN_GATE_MAX_BYTES || new TextEncoder().encode(source).length > IFCN_GATE_MAX_BYTES) throw new Error("IFCN 文件过大，请下载原文件查看。");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) throw new Error("IFCN 包含无效控制字符。");
  const nodes: IfcnGate[] = [], routes: IfcnRoute[] = [], phases: IfcnGateLayout["phases"] = [];
  const sections = ["#nodes info", "#paths info", "#phase map"];
  let active: number | null = null, completed = 0, phaseCount: number | null = null, clockScheme: string | null = null, iterationDistance = 0, totalPoints = 0;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const section = sections.indexOf(line);
    if (section >= 0) {
      if (active === section) { active = null; completed += 1; }
      else if (active === null && section === completed) active = section;
      else throw new Error("IFCN 数据段次序或边界无效。");
      continue;
    }
    if (line.startsWith("#")) {
      const phaseHeader = /^#phase count:\s*(\d+)$/.exec(line);
      if (phaseHeader) {
        if (phaseCount !== null) throw new Error("IFCN 相位数量重复声明。");
        phaseCount = integer(phaseHeader[1], "相位数量", 16);
        if (phaseCount < 2) throw new Error("IFCN 相位数量无效。");
      }
      if (line.startsWith("#clock scheme:")) { clockScheme = line.slice(14).trim(); if (!clockScheme || clockScheme.length > 128) throw new Error("IFCN 时钟名称无效。"); }
      if (line.startsWith("#iteration_distance=")) {
        const match = /^#iteration_distance=(\d+)$/.exec(line);
        if (active !== 1 || !match) throw new Error("IFCN 状态迭代距离无效。");
        iterationDistance = integer(match[1], "状态迭代距离", 4096);
      }
      continue;
    }
    if (active === 0) {
      const match = /^(\d+),\s*([^,]{1,160}),\s*([a-zA-Z_][a-zA-Z0-9_-]{0,31}),\s*\((-?\d+),\s*(-?\d+)\);$/.exec(line);
      if (!match || nodes.length >= MAX_NODES) throw new Error("IFCN 门节点格式无效或数量超过预览限制。");
      nodes.push({ id: integer(match[1], "节点编号"), name: match[2].trim(), kind: match[3], x: integer(match[4], "X 坐标"), y: integer(match[5], "Y 坐标") });
    } else if (active === 1) {
      const match = /^\((\d+),\s*(\d+)\):\s*(.+);$/.exec(line);
      if (!match || routes.length >= MAX_ROUTES) throw new Error("IFCN 路径格式无效或数量超过预览限制。");
      const sequence = match[3];
      if (!/^\(-?\d+,\s*-?\d+\)(?:,\s*\(-?\d+,\s*-?\d+\))*$/.test(sequence)) throw new Error("IFCN 路径点格式无效。");
      const points = Array.from(sequence.matchAll(/\((-?\d+),\s*(-?\d+)\)/g), (point) => ({ x: integer(point[1], "X 坐标"), y: integer(point[2], "Y 坐标") }));
      totalPoints += points.length;
      if (points.length < 2 || totalPoints > MAX_POINTS) throw new Error("IFCN 路径点不足或超过预览限制。");
      routes.push({ source: integer(match[1], "起点编号"), target: integer(match[2], "终点编号"), points, iterationDistance });
    } else if (active === 2) {
      // Normal writes one grid row per line; GA writes one phase record per line.
      // Validate the entire line before reading records, so no trailing text is ignored.
      if (!/^(?:\(-?\d+,\s*-?\d+\):\s*\d+;\s*)+$/.test(line)) throw new Error("IFCN 相位表格式无效或超过预览限制。");
      for (const match of line.matchAll(/\((-?\d+),\s*(-?\d+)\):\s*(\d+);/g)) {
        if (phases.length >= MAX_PHASES) throw new Error("IFCN 相位表格式无效或超过预览限制。");
        phases.push({ x: integer(match[1], "X 坐标"), y: integer(match[2], "Y 坐标"), phase: integer(match[3], "相位", 15) });
      }
    } else throw new Error("IFCN 包含无法识别的文本记录。");
  }
  if (active !== null || completed !== 3 || phaseCount === null || !nodes.length || !routes.length || !phases.length) throw new Error("IFCN 门节点、路径或相位数据不完整。");
  const nodeById = new Map<number, IfcnGate>(), occupied = new Set<string>();
  for (const node of nodes) {
    if (!node.name || nodeById.has(node.id) || occupied.has(key(node))) throw new Error("IFCN 节点编号或位置重复。");
    nodeById.set(node.id, node); occupied.add(key(node));
  }
  const phaseByPosition = new Map<string, number>();
  for (const point of phases) {
    if (phaseByPosition.has(key(point)) || point.phase >= phaseCount) throw new Error("IFCN 相位表重复或相位超出声明范围。");
    phaseByPosition.set(key(point), point.phase);
  }
  const edges = new Set<string>(), used = new Map<string, IfcnPoint>();
  const interior = new Map<string, { point: IfcnPoint; uses: { source: number; route: number; direction: "h" | "v" }[] }>();
  for (const node of nodes) used.set(key(node), node);
  routes.forEach((route, routeIndex) => {
    const from = nodeById.get(route.source), to = nodeById.get(route.target), edge = `${route.source}:${route.target}:${route.iterationDistance}`;
    if (!from || !to || key(from) !== key(route.points[0]) || key(to) !== key(route.points.at(-1)!)) throw new Error("IFCN 路径端点与门节点不一致。");
    if (edges.has(edge)) throw new Error("IFCN 路径重复。");
    edges.add(edge);
    const routePoints = new Set<string>();
    route.points.forEach((point, index) => {
      if (routePoints.has(key(point))) throw new Error("IFCN 路径含重复网格点。");
      routePoints.add(key(point)); used.set(key(point), point);
      const previous = route.points[index - 1], next = route.points[index + 1];
      if (previous && Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) !== 1) throw new Error("IFCN 路径包含不连续网格点。");
      if (previous && next && occupied.has(key(point))) throw new Error("IFCN 路径穿过其它门节点。");
      const direction = previous && next && previous.y === point.y && next.y === point.y ? "h" : previous && next && previous.x === point.x && next.x === point.x ? "v" : null;
      if (direction) {
        const site = interior.get(key(point)) || { point, uses: [] };
        site.uses.push({ source: route.source, route: routeIndex, direction }); interior.set(key(point), site);
      }
    });
  });
  for (const position of used.keys()) if (!phaseByPosition.has(position)) throw new Error("IFCN 存在未记录相位的门或路径点。");
  const crossings: IfcnGateLayout["crossings"] = [];
  for (const site of interior.values()) {
    const h = site.uses.filter((use) => use.direction === "h"), v = site.uses.filter((use) => use.direction === "v");
    if (h.length && v.length && (h.some((use) => use.source !== v[0].source) || v.some((use) => use.source !== h[0].source))) crossings.push({ ...site.point, routeIndices: [...new Set(site.uses.map((use) => use.route))] });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of used.values()) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  return { nodes, routes, phases, phaseCount, clockScheme, crossings, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, physicalLayersRecorded: false };
}
