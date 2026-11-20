import assert from "node:assert/strict";
import test from "node:test";
import { IFCN_GATE_MAX_BYTES, parseIfcnGateLayout } from "./ifcn-gate-layout.ts";

// Exact native GA exporter records from a small AND/OR circuit; phases are zero-based.
const native = `#circuit name: layout
#algorithm: regular_clock_ga
#mapping mode: combinational
#phase count: 4
#clock scheme: 2DDWave
#clock template origin: (-1,-3)
#clock scheme consistency: success
#layout area: width: 3, height: 2, area: 6
#nodes info
### nodeIndex, nodeName, nodeType, nodePosition ###
0, a, input, (1,0);
1, b, input, (0,0);
2, c, input, (2,0);
3, y, or, (2,1);
4, n, and, (1,1);
#nodes info
#paths info
### {node1, node2} : path ###
(0,4): (1,0),(1,1);
(1,4): (0,0),(0,1),(1,1);
(2,3): (2,0),(2,1);
(4,3): (1,1),(2,1);
#paths info
#phase map
### (x,y) : phase ###
(0,0):0;
(1,0):1;
(2,0):2;
(0,1):1;
(1,1):2;
(2,1):3;
#phase map
`;

// Exact geometry from the Normal XOR demonstration, run c104c79ff457456191296d9319dcafad.
// This exporter packs each grid row's phase records onto one line.
const nativeNormal = `#phase count: 4
#clock scheme: 2DDWave
#nodes info
0, a, input, (0,0);
1, b, input, (1,0);
2, y, and, (2,3);
3, ps1, or, (1,2);
4, ps2, and, (2,1);
5, ~ps2, not, (2,2);
#nodes info
#paths info
(5,2): (2,2),(2,3);
(4,5): (2,1),(2,2);
(0,3): (0,0),(0,1),(0,2),(1,2);
(1,4): (1,0),(2,0),(2,1);
(3,2): (1,2),(1,3),(2,3);
(1,3): (1,0),(1,1),(1,2);
(0,4): (0,0),(0,1),(1,1),(2,1);
#paths info
#phase map
### (x,y) : phase ###
(0,0):0; (1,0):1; (2,0):2;
(0,1):1; (1,1):2; (2,1):3;
(0,2):2; (1,2):3; (2,2):0;
(0,3):3; (1,3):0; (2,3):1;
#phase map
`;
function fixture(nodes, routes, phases) {
  return `#phase count: 4
#nodes info
${nodes}
#nodes info
#paths info
${routes}
#paths info
#phase map
${phases}
#phase map
`;
}

test("native IFCN preview preserves exact nodes, every routed point, and recorded phases", () => {
  const layout = parseIfcnGateLayout(native);
  assert.equal(layout.clockScheme, "2DDWave");
  assert.equal(layout.phaseCount, 4);
  assert.deepEqual(layout.bounds, { x: 0, y: 0, width: 3, height: 2 });
  assert.equal(layout.nodes.length, 5);
  assert.deepEqual(layout.nodes[3], { id: 3, name: "y", kind: "or", x: 2, y: 1 }, "do not invent output roles missing from IFCN");
  assert.deepEqual(layout.routes[1], { source: 1, target: 4, iterationDistance: 0, points: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] });
  assert.deepEqual(layout.phases.map(({ phase }) => phase), [0, 1, 2, 1, 2, 3]);
  assert.deepEqual(layout.crossings, []);
  assert.equal(layout.physicalLayersRecorded, false);
});

test("Normal XOR export preserves packed phase rows and actual crossing geometry", () => {
  const layout = parseIfcnGateLayout(nativeNormal);
  assert.equal(layout.clockScheme, "2DDWave");
  assert.equal(layout.phaseCount, 4);
  assert.equal(layout.nodes.length, 6);
  assert.equal(layout.routes.length, 7);
  assert.equal(layout.phases.length, 12);
  assert.deepEqual(layout.bounds, { x: 0, y: 0, width: 3, height: 4 });
  assert.deepEqual(layout.phases.slice(0, 3), [{ x: 0, y: 0, phase: 0 }, { x: 1, y: 0, phase: 1 }, { x: 2, y: 0, phase: 2 }]);
  assert.deepEqual(layout.phases.at(-1), { x: 2, y: 3, phase: 1 });
  assert.deepEqual(layout.crossings, [{ x: 1, y: 1, routeIndices: [5, 6] }]);
  assert.deepEqual(layout, parseIfcnGateLayout(nativeNormal.replaceAll("; (", ";\n(")), "line packing must not alter parsed geometry");
});

const packed = fixture(
  "0, a, input, (0,0);\n1, y, output, (4,3);",
  "(0,1): (0,0),(1,0),(2,0),(3,0),(3,1),(3,2),(3,3),(4,3);",
  "#phase codec: phase_count=4, block_size=4, encoding=packed_hex_2bit_row_major\ntile(0,0):0xe4004080;\ntile(1,0):0x00000003;",
);

test("native packed hex blocks preserve occupied phases across rows and block boundaries", () => {
  const layout = parseIfcnGateLayout(packed);
  const phaseAt = new Map(layout.phases.map(({ x, y, phase }) => [`${x},${y}`, phase]));
  assert.deepEqual(layout.routes[0].points.map(({ x, y }) => phaseAt.get(`${x},${y}`)), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.equal(layout.phases.length, 8, "zero padding is not displayed as an occupied phase tile");
  assert.deepEqual(layout.bounds, { x: 0, y: 0, width: 5, height: 4 });
});

test("packed hex phase maps reject missing blocks, duplicates and inconsistent declarations", () => {
  assert.throws(() => parseIfcnGateLayout(packed.replace("tile(1,0):0x00000003;", "")), /未记录相位/);
  assert.throws(() => parseIfcnGateLayout(packed.replace("tile(1,0):0x00000003;", "tile(0,0):0x00000003;")), /相位块重复/);
  assert.throws(() => parseIfcnGateLayout(packed.replace("phase_count=4", "phase_count=3")), /相位数量不一致/);
  assert.throws(() => parseIfcnGateLayout(packed.replace("#phase count: 4", "#phase count: 3").replace("phase_count=4", "phase_count=3")), /相位超出/);
  assert.throws(() => parseIfcnGateLayout(packed.replace("tile(1,0):0x00000003;", "(4,3):3;")), /相位表格式/);
});

test("packed phase rows still reject incomplete, duplicate, out-of-range and excessive records", () => {
  for (const row of [
    "(0,0):0; (1,0):1; (2,0):2", // missing final separator
    "(0,0):0; (1,0):1; (2,0):2; ignored text",
    "(0,0):0; <script/>; (1,0):1; (2,0):2;",
    "(0,0):0;; (1,0):1; (2,0):2;",
    "(0,0):0; (0,0):1; (2,0):2;", // duplicate within a packed row
    "(0,0):0; (1,0):1; (2,0):4;", // outside declared phase count
    "(0,0):0; (1,0):1; (1000001,0):2;",
  ]) assert.throws(() => parseIfcnGateLayout(nativeNormal.replace("(0,0):0; (1,0):1; (2,0):2;", row)));
  const excessive = Array.from({ length: 20001 }, (_, x) => `(${x},0):0;`).join(" ");
  assert.throws(() => parseIfcnGateLayout(nativeNormal.replace("(0,0):0; (1,0):1; (2,0):2;", excessive)), /相位表.*限制/);
});

test("independent straight wires identify XY crossings without fabricating Z or a connection", () => {
  const layout = parseIfcnGateLayout(fixture(
    "0, a, input, (-1,0);\n1, y, output, (1,0);\n2, b, input, (0,-1);\n3, z, output, (0,1);",
    "(0,1): (-1,0),(0,0),(1,0);\n(2,3): (0,-1),(0,0),(0,1);",
    "(-1,0):0;\n(0,0):1;\n(1,0):2;\n(0,-1):0;\n(0,1):2;",
  ));
  assert.deepEqual(layout.crossings, [{ x: 0, y: 0, routeIndices: [0, 1] }]);
  assert.equal(layout.routes.length, 2);
  assert.equal(layout.physicalLayersRecorded, false);
  assert.deepEqual(layout.bounds, { x: -1, y: -1, width: 3, height: 3 });
});

test("shared-source fanout geometry is not labelled an independent-net crossing", () => {
  const layout = parseIfcnGateLayout(fixture(
    "0, a, input, (-1,-1);\n1, y, output, (1,0);\n2, z, output, (0,1);",
    "(0,1): (-1,-1),(-1,0),(0,0),(1,0);\n(0,2): (-1,-1),(0,-1),(0,0),(0,1);",
    "(-1,-1):0;\n(-1,0):1;\n(0,-1):1;\n(0,0):2;\n(1,0):3;\n(0,1):3;",
  ));
  assert.deepEqual(layout.crossings, []);
});

test("feedback iteration distances and same-phase tiles are preserved without performing new DRC", () => {
  const layout = parseIfcnGateLayout(native.replace("(0,4):", "#iteration_distance=1\n(0,4):").replace("(1,4):", "#iteration_distance=0\n(1,4):").replace("(1,1):2;", "(1,1):1;"));
  assert.deepEqual(layout.routes.map(({ iterationDistance }) => iterationDistance), [1, 0, 0, 0]);
  assert.equal(layout.phases.find((point) => point.x === 1 && point.y === 1).phase, 1);
});

test("incomplete sections, missing phases, and malformed node/path records are rejected", () => {
  for (const source of [
    native.replace(/#phase map\n$/, ""),
    native.replace("(1,1):2;", ""),
    native.replace("0, a, input, (1,0);", "<svg onload='alert(1)'/>"),
    native.replace("(0,4): (1,0),(1,1);", "(0,4): (1,0),<script/>;"),
    native.replace("#paths info", "#phase map"),
    native + "<script>alert(1)</script>",
  ]) assert.throws(() => parseIfcnGateLayout(source));
  const plainLabel = parseIfcnGateLayout(native.replace("0, a,", "0, <img src=x onerror=alert(1)>,"));
  assert.equal(plainLabel.nodes[0].name, "<img src=x onerror=alert(1)>", "labels remain plain text for React, never markup");
});

test("ambiguous IDs, duplicate phase cells, endpoint mismatches and non-grid routes are rejected", () => {
  for (const source of [
    native.replace("1, b, input", "0, b, input"),
    native.replace("1, b, input, (0,0);", "1, b, input, (1,0);"),
    native.replace("(0,0):0;", "(0,0):0;\n(0,0):1;"),
    native.replace("(2,1):3;", "(2,1):4;"),
    native.replace("(0,4): (1,0),(1,1);", "(0,4): (0,0),(1,1);"),
    native.replace("(1,4): (0,0),(0,1),(1,1);", "(1,4): (0,0),(1,1);"),
    native.replace("(1,4): (0,0),(0,1),(1,1);", "(1,4): (0,0),(0,1),(0,0),(1,1);"),
    native.replace("(0,4): (1,0),(1,1);", "(0,4): (1,0),(1,1);\n(0,4): (1,0),(1,1);"),
    native.replace("(0,4): (1,0),(1,1);", "(0,4): (1,0),(2,0),(2,1),(1,1);"),
  ]) assert.throws(() => parseIfcnGateLayout(source));
});

test("preview bounds file bytes, UTF-8 size, coordinates, and graph record counts", () => {
  assert.throws(() => parseIfcnGateLayout(" ".repeat(IFCN_GATE_MAX_BYTES + 1)), /过大/);
  assert.throws(() => parseIfcnGateLayout("电".repeat(Math.floor(IFCN_GATE_MAX_BYTES / 3) + 1)), /过大/);
  assert.throws(() => parseIfcnGateLayout(native.replace("(1,0);", "(1000001,0);")), /范围/);
  assert.throws(() => parseIfcnGateLayout(native.replace("0, a, input, (1,0);", Array(5001).fill("0, a, input, (1,0);").join("\n"))), /数量/);
  const excessivePoints = Array.from({ length: 100001 }, (_, x) => `(${x},0)`).join(",");
  assert.throws(() => parseIfcnGateLayout(native.replace("(0,4): (1,0),(1,1);", `(0,4): ${excessivePoints};`)), /路径点/);
});
