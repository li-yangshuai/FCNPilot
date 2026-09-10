import assert from "node:assert/strict";
import test from "node:test";
import { parseQcaLayout, qcaBounds } from "./ifcn-layout.ts";

function cell({ x = 20, y = 40, clock = 0, label = "a", role = "INPUT" } = {}) {
  return `[TYPE:QCADCell]\n[TYPE:QCADDesignObject]\nx=${x}\ny=${y}\n[#TYPE:QCADDesignObject]\ncell_options.cxCell=18\ncell_options.cyCell=18\ncell_options.clock=${clock}\ncell_function=QCAD_CELL_${role}\n[TYPE:CELL_DOT]\nx=${x + 4.5}\ny=${y - 4.5}\ndiameter=5\n[#TYPE:CELL_DOT]\n[TYPE:QCADLabel]\n[TYPE:QCADStretchyObject]\n[TYPE:QCADDesignObject]\nx=999\ny=888\n[#TYPE:QCADDesignObject]\n[#TYPE:QCADStretchyObject]\npsz=${label}\n[#TYPE:QCADLabel]\n[#TYPE:QCADCell]`;
}
function layer(content, name = "Main Cell Layer") {
  return `[TYPE:QCADLayer]\ntype=1\npszDescription=${name}\n${content}\n[#TYPE:QCADLayer]`;
}

test("QCA preview preserves cell coordinates independently of nested dot and label coordinates", () => {
  const layout = parseQcaLayout(layer(cell()));
  assert.equal(layout.cells.length, 1);
  assert.deepEqual(layout.cells[0], {
    x: 20, y: 40, width: 18, height: 18, clock: 0, role: "QCAD_CELL_INPUT", label: "a", layer: 0,
    dots: [{ x: 24.5, y: 35.5, diameter: 5 }],
  });
  assert.deepEqual(layout.layers, [{ id: 0, name: "Main Cell Layer" }]);
  assert.deepEqual(qcaBounds(layout.cells), { x: -1, y: 19, width: 42, height: 42 });
});

test("QCA preview retains stacked cells and their source layers", () => {
  const layout = parseQcaLayout(layer(cell()) + "\n" + layer(cell({ clock: 3, role: "OUTPUT", label: "y" }), "Crossing Layer"));
  assert.equal(layout.cells.length, 2);
  assert.deepEqual(layout.cells.map(({ x, y, clock, layer }) => [x, y, clock, layer]), [[20, 40, 0, 0], [20, 40, 3, 1]]);
  assert.equal(layout.layers[1].name, "Crossing Layer");
});

test("QCA preview refuses partial and invalid geometry instead of inventing cells", () => {
  assert.throws(() => parseQcaLayout(layer(cell({ x: NaN }))), /无效/);
  assert.throws(() => parseQcaLayout(layer(cell()).replace("cell_options.cxCell=18", "cell_options.cxCell=0")), /大于零/);
  assert.throws(() => parseQcaLayout(layer(cell()).replace("[#TYPE:QCADCell]", "")), /不完整/);
  assert.throws(() => parseQcaLayout("[TYPE:DESIGN]\n[#TYPE:DESIGN]"), /没有/);
});

test("QCA preview bounds parser work for oversized files and cell counts", () => {
  assert.throws(() => parseQcaLayout(" ".repeat(8 * 1024 * 1024 + 1)), /过大/);
  const minimal = cell().replace(/\[TYPE:CELL_DOT\][\s\S]*?\[#TYPE:CELL_DOT\]/, "").replace(/\[TYPE:QCADLabel\][\s\S]*?\[#TYPE:QCADLabel\]/, "");
  assert.throws(() => parseQcaLayout(layer(Array(10_001).fill(minimal).join("\n"))), /10,000/);
});
