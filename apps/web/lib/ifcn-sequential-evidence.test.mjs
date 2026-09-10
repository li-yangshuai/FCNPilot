import assert from "node:assert/strict";
import test from "node:test";
import { readIfcnStateTransition } from "./ifcn-sequential-evidence.ts";

test("one-step SeqIR consistency remains separate from RTL equivalence and state-device signoff", () => {
  const result = readIfcnStateTransition({ sequential: { state_transition: { status: "equivalent", vectors_checked: 4, state_bits: 1, input_bits: 1, gate_nodes: 3, scope: "SeqIR_vs_cut_DAG_one_step_next_state" } } }, { sequential: { rtl_equivalence: "not_independently_proven", physical_state_signoff: "not_characterized" } });
  assert.equal(result.statusLabel, "一拍关系已匹配");
  assert.equal(result.scopeLabel, "SeqIR → 状态切分 DAG 一拍检查");
  assert.equal(result.vectorsChecked, 4);
  assert.equal(result.rtlEquivalence, "not_independently_proven");
  assert.equal(result.physicalStateSignoff, "not_characterized");
});

test("missing and unsuccessful state checks are never promoted by unrelated completed stages", () => {
  for (const [status, expected] of [["not_performed", "尚未执行"], ["invalid", "检查报告无效"], ["mismatch", "一拍关系不匹配"]]) {
    assert.equal(readIfcnStateTransition({}, { sequential: { state_transition: status } }).statusLabel, expected);
  }
  const absent = readIfcnStateTransition({ logic: { status: "equivalent" }, pnr: { status: "completed", tile_phase_drc: true } }, {});
  assert.equal(absent.status, null);
  assert.equal(absent.knownScope, false);
  assert.equal(absent.vectorsChecked, null);
});

test("validation fallback preserves its actual scope and rejects invalid counters", () => {
  const result = readIfcnStateTransition({ sequential: { state_transition: { vectors_checked: -1, state_bits: "1" } } }, { sequential_equivalence: "equivalent", sequential: { scope: "different_scope" } });
  assert.equal(result.status, "equivalent");
  assert.equal(result.scopeLabel, "状态转移检查范围：different_scope");
  assert.equal(result.knownScope, false);
  assert.equal(result.vectorsChecked, null);
  assert.equal(result.stateBits, null);
});
