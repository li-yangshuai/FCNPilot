import assert from "node:assert/strict";
import test from "node:test";
import { readIfcnCombinationalAcceptance } from "./ifcn-combinational-evidence.ts";

const certificates = {
  clock_arrival: "cycle_zero_at_template_phase_passed",
  physical_routes: "source_isolation_and_ordered_paths_passed",
};

test("old combinational results lack new acceptance evidence without changing their original status", () => {
  const validation = { physical_function: "verified", rtl_equivalence: "passed" };
  const checks = readIfcnCombinationalAcceptance("combinational", {}, validation);
  assert.deepEqual(checks.map(({ id, passed }) => [id, passed]), [["clock_arrival", false], ["physical_routes", false]]);
  assert.deepEqual(validation, { physical_function: "verified", rtl_equivalence: "passed" });
});

test("each new combinational check requires its own exact certificate value", () => {
  assert.deepEqual(readIfcnCombinationalAcceptance("combinational", {}, certificates).map((item) => item.passed), [true, true]);
  assert.deepEqual(readIfcnCombinationalAcceptance("combinational", {}, { ...certificates, clock_arrival: "passed" }).map((item) => item.passed), [false, true]);
  assert.deepEqual(readIfcnCombinationalAcceptance("combinational", {}, { ...certificates, physical_routes: true }).map((item) => item.passed), [true, false]);
});

test("sequential validation and records with unknown design mode do not acquire combinational cycle-zero requirements", () => {
  for (const [type, metrics] of [["sequential", {}], [null, { pnr: { mapping_mode: "sequential" } }], ["combinational", { sequential: { mapping_mode: "sequential" } }], [null, {}]]) {
    assert.equal(readIfcnCombinationalAcceptance(type, metrics, certificates), null);
  }
  assert.equal(readIfcnCombinationalAcceptance(null, { pnr: { mapping_mode: "combinational" } }, certificates).every((item) => item.passed), true);
});
