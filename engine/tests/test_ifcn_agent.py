import ast
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from ifcn_agent_frontend import normalize_verilog
from ifcn_agent import (ALGORITHMS, DEFAULT_AUTO_ALGORITHMS, check_pnr, doctor, energy_summary,
                        execute, pnr_candidates, qca_interface_report, resolve_design_selection, run_pnr)
from ifcn_algorithm_catalog import algorithm_catalog


def evaluate(node, values):
    if isinstance(node, ast.Name):
        return values[node.id]
    if isinstance(node, ast.UnaryOp):
        return 1 - evaluate(node.operand, values)
    a, b = evaluate(node.left, values), evaluate(node.right, values)
    return a & b if isinstance(node.op, ast.BitAnd) else a | b if isinstance(node.op, ast.BitOr) else a ^ b


class FrontendTests(unittest.TestCase):
    def test_source_order_is_opt_in_and_keeps_the_legacy_default(self):
        source = "module m(input a,b,c, output y,z); wire n; assign n=~a; assign y=n&b; assign z=~c; endmodule"
        original, metadata = normalize_verilog(source)
        explicit_default, _ = normalize_verilog(source, source_order=False)
        reordered, reordered_metadata = normalize_verilog(source, source_order=True)
        self.assertEqual(original, explicit_default)
        self.assertEqual(original, "module m(a, b, c, y, z);\ninput a, b, c;\noutput y, z;\nwire n;\n"
                         "assign n = ~a;\nassign z = ~c;\nassign y = n & b;\nendmodule\n")
        self.assertEqual(re.findall(r"assign (\w+) =", reordered), ["n", "y", "z"])
        self.assertEqual(metadata, reordered_metadata)

    def test_source_order_normalization_preserves_truth_and_dependency_order(self):
        for body in ("assign n=~a; assign y=n&b; assign z=~c;",
                     "assign y=n&b; assign z=~c; assign n=~a;",
                     "assign y=n&b; assign n=~(a^c); assign z=~c;"):
            source = "module m(input a,b,c, output y,z); wire n; "+body+" endmodule"
            baseline, _ = normalize_verilog(source)
            ordered, _ = normalize_verilog(source, source_order=True)
            for bits in itertools.product((0, 1), repeat=3):
                outputs = []
                for normalized in (baseline, ordered):
                    values = dict(zip(("a", "b", "c"), bits))
                    for name, expression in re.findall(r"assign (\w+) = (.*);", normalized):
                        expression = ast.parse(expression, mode="eval").body
                        self.assertLessEqual({node.id for node in ast.walk(expression) if isinstance(node, ast.Name)}, values.keys())
                        values[name] = evaluate(expression, values)
                    outputs.append((values["y"], values["z"]))
                self.assertEqual(outputs[0], outputs[1])
        with self.assertRaisesRegex(ValueError, "cycle"):
            normalize_verilog("module m(input a, output y); wire n; assign y=n&a; assign n=~y; endmodule", source_order=True)

    def test_lowering_preserves_truth_tables(self):
        expressions = ["a ^ b", "~(a | b) & c", "(a & b) | (a & c) | (b & c)",
                       "a | b & c", "~a ^ (b & ~c)", "a"]
        for expression in expressions:
            normalized, _ = normalize_verilog(f"module m(input a, b, c, output y); assign y={expression}; endmodule")
            for bits in itertools.product((0, 1), repeat=3):
                values = dict(zip(("a", "b", "c"), bits))
                expected = evaluate(ast.parse(expression, mode="eval").body, values)
                for name, expr in re.findall(r"assign (\w+) = (.*);", normalized):
                    values[name] = evaluate(ast.parse(expr, mode="eval").body, values)
                self.assertEqual(expected, values["y"], (expression, bits))

    def test_rejects_unsupported_or_invalid_rtl(self):
        for source in [
            "module m(input a, output y); always @* y=a; endmodule",
            "module m(input [3:0] a, output y); assign y=a; endmodule",
            "module m(input a, output y); assign y=missing; endmodule",
            "module m(input a, output y); assign y=1; endmodule",
            "module m(input a, output y); assign y=y & a; endmodule",
            "module m(input a, output y); assign y=a; assign y=~a; endmodule",
            "module m(input a, output y); wire w; assign y=w; endmodule",
            "module m(input a, output y); assign y=a && a; endmodule",
        ]:
            with self.subTest(source=source), self.assertRaises((ValueError, SyntaxError)):
                normalize_verilog(source)

    def test_topological_order_and_comments(self):
        normalized, metadata = normalize_verilog("""// example
module m(a,y); input a; output y; wire w;
assign y=~w; /* order is intentionally reversed */ assign w=~a;
endmodule""")
        self.assertLess(normalized.index("assign w"), normalized.index("assign y"))
        self.assertEqual(metadata["inputs"], ["a"])

    def test_partial_pnr_is_never_accepted(self):
        for record in [{}, {"layout_legal": True, "failed_edge_count": 1, "clock_template_ok": True},
                       {"layout_legal": True, "failed_edge_count": 0, "clock_template_ok": False},
                       {"layout_legal": True, "failed_edge_count": 0, "clock_legal": True,
                        "validation": {"passed": False}, "clock_template_ok": True}]:
            with self.assertRaises(ValueError):
                check_pnr(record)

    def test_irregular_clock_does_not_require_regular_template(self):
        check_pnr({"layout_legal": True, "failed_edge_count": 0, "clock_legal": True,
                   "clock_template_ok": None, "validation": {"passed": True}})

    def test_missing_device_output_cannot_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            qca = root / "device.qca"
            qca.write_text("[TYPE:QCADCell]\ncell_function=QCAD_CELL_INPUT\n"
                           "[TYPE:QCADCell]\ncell_function=QCAD_CELL_OUTPUT\n")
            with self.assertRaisesRegex(ValueError, "expected 1 inputs/2 outputs, got 1 inputs/1 outputs"):
                qca_interface_report(qca, {"inputs": ["a"], "outputs": ["x", "y"]}, root / "interface.json")
            report = json.loads((root / "interface.json").read_text())
            self.assertFalse(report["passed"])

    def test_negative_energy_is_diagnostic_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "energy.txt"
            report.write_text("""[ENERGY_ANALYSIS]
available=TRUE
cycle_count=1
total_bath_eV=-1
average_bath_eV=-1
total_bath_clock_eV=-2
average_bath_clock_eV=-2
total_error_eV=3
[PER_CYCLE]
cycle,E_bath_eV
2,-1
[#PER_CYCLE]
[#ENERGY_ANALYSIS]
""")
            data = energy_summary(report, 1e-11)
            self.assertEqual(data["numerical_status"], "invalid_negative_bath_energy")
            self.assertIsNone(data["average_dissipated_power_W"])


class AlgorithmCatalogTests(unittest.TestCase):
    def test_sequential_entry_and_scale_evidence_remain_separate(self):
        evidence = {"normal_2ddwave": {
            "small": {"status": "validated_samples", "benchmark_count": 2, "max_gate_nodes": 7,
                      "note": "fixture evidence for individual P&R samples"},
            "evidence_source_paths": ["fixture.json"],
        }}
        entries = {entry["id"]: entry for entry in algorithm_catalog([], True, evidence)}
        self.assertTrue(entries["sequential_cyclic"]["available"])
        self.assertEqual(entries["sequential_cyclic"]["design_modes"], ["sequential"])
        self.assertFalse(entries["normal_2ddwave"]["available"])
        self.assertEqual(entries["normal_2ddwave"]["scale_coverage"]["small"]["status"], "validated_samples")
        self.assertEqual(entries["normal_2ddwave"]["scale_coverage"]["medium"]["status"], "unassessed")
        self.assertEqual(entries["normal_2ddwave"]["scale_coverage"]["large"]["status"], "unassessed")
        entries["normal_2ddwave"]["scale_coverage"]["small"]["benchmark_count"] = 999
        self.assertEqual(evidence["normal_2ddwave"]["small"]["benchmark_count"], 2)

    def test_missing_evidence_does_not_claim_a_validated_size_tier(self):
        for entry in algorithm_catalog([], scale_evidence={}):
            with self.subTest(entry=entry["id"]):
                self.assertTrue(entry["design_modes"])
                for coverage in entry["scale_coverage"].values():
                    self.assertNotEqual(coverage["status"], "validated_samples")
                    self.assertNotIn("benchmark_count", coverage)
                self.assertRegex(entry["origin_commit"], r"^[0-9a-f]{40}$")

    def test_frozen_size_claims_have_repository_evidence_and_stay_small(self):
        entries = {entry["id"]: entry for entry in algorithm_catalog([])}
        for name, count, maximum in (("normal_2ddwave", 1, 4), ("compact", 1, 4), ("june_random", 2, 26)):
            with self.subTest(entry=name):
                coverage = entries[name]["scale_coverage"]
                self.assertEqual(coverage["small"]["status"], "validated_samples")
                self.assertEqual(coverage["small"]["benchmark_count"], count)
                self.assertEqual(coverage["small"]["max_gate_nodes"], maximum)
                for size in ("medium", "large"):
                    self.assertEqual(coverage[size]["status"], "unassessed")
                for source in entries[name]["evidence_source_paths"]:
                    self.assertTrue((ROOT.parent / source).is_file(), source)

    def test_catalog_does_not_expand_runnable_algorithms(self):
        capabilities = [{"id": name, "available": index != 1}
                        for index, name in enumerate(ALGORITHMS)]
        catalog = algorithm_catalog(capabilities)
        self.assertEqual(len({entry["id"] for entry in catalog}), len(catalog))
        runnable = [entry for entry in catalog if entry.get("run_algorithm") and "combinational" in entry["design_modes"]]
        self.assertEqual({entry["run_algorithm"] for entry in runnable}, set(ALGORITHMS))
        availability = {item["id"]: item["available"] for item in capabilities}
        self.assertEqual({entry["run_algorithm"]: entry["available"] for entry in runnable}, availability)
        for entry in catalog:
            with self.subTest(entry=entry["id"]):
                self.assertIn(entry["entry_kind"], ("backend", "research_method", "component"))
                self.assertIn(entry["clock_family"], ("rule_based", "irregular", "configurable", "not_applicable"))
                if not entry.get("run_algorithm"):
                    self.assertEqual(entry["integration"], "not_integrated")
                    self.assertFalse(entry["available"])
                else:
                    self.assertEqual(entry["entry_kind"], "backend")
                    self.assertEqual(entry["integration"], "integrated")

    def test_search_method_and_clock_family_are_independent(self):
        entries = {entry["id"]: entry for entry in algorithm_catalog([])}
        self.assertEqual(entries["normal_2ddwave"]["method"], "graph_compaction")
        for name in ("compact", "june_random"):
            self.assertEqual(entries[name]["method"], "graph_drawing")
        self.assertEqual(entries["regular_clock_ga"]["method"], "genetic")
        self.assertEqual(entries["normal_2ddwave"]["clock_family"], "rule_based")
        self.assertEqual(entries["compact"]["clock_family"], "irregular")
        self.assertEqual(entries["regular_clock_ga"]["clock_family"], "rule_based")
        self.assertEqual(entries["regular_clock_ga"]["clock_schemes"], ["2DDWave", "USE", "RES"])
        self.assertEqual(entries["compact"]["design_route"], entries["june_random"]["design_route"])
        self.assertEqual(len({entries[name]["design_route"] for name in ALGORITHMS}), 3)
        self.assertEqual(entries["global_clock_smt"]["entry_kind"], "component")
        self.assertNotIn("run_algorithm", entries["global_clock_smt"])
        for name in ("astar_components", "negotiated_2ddwave", "clock_strategy_components"):
            self.assertEqual(entries[name]["entry_kind"], "component")

    def test_source_origins_do_not_present_original_only_code_as_copied(self):
        original_only = {"gcn_ppo", "memory_policy", "global_clock_smt", "negotiated_2ddwave", "ogdf_layer_ordering"}
        for entry in algorithm_catalog([]):
            with self.subTest(entry=entry["id"]):
                expected = "iFCN" if entry["id"] in original_only else "FCNPilot"
                self.assertEqual(entry["source_repository"], expected)
                self.assertTrue(entry["source_paths"])
                for source in entry["source_paths"]:
                    path = Path(source)
                    self.assertFalse(path.is_absolute())
                    self.assertNotIn("..", path.parts)
                    if expected == "FCNPilot":
                        self.assertTrue((ROOT.parent / path).is_file(), source)

    def test_doctor_exposes_catalog_without_changing_auto_policy(self):
        with patch("ifcn_agent.configuration", return_value={
            "python": sys.executable, "energy_binary": sys.executable,
            "simulation_binary": sys.executable, "mapping_binary": sys.executable,
            "native_pnr_binary": "", "backend": "unused", "build_dir": "/unavailable-ifcn-build",
        }):
            report = doctor()
        self.assertFalse(report["layout_optimization"]["available"])
        self.assertEqual(report["auto_policy"]["order"], list(DEFAULT_AUTO_ALGORITHMS))
        self.assertTrue(report["auto_policy"]["respects_clock_scheme"])
        self.assertEqual(report["auto_policy"]["optimizes_area"], "bounded_within_backend_nonregressing_area_and_qca_cells")
        self.assertEqual(report["algorithm_catalog"], algorithm_catalog(report["algorithms"]))
        self.assertEqual([entry["id"] for entry in report["algorithm_catalog"] if entry["available"]],
                         ["normal_2ddwave"])


class AlgorithmPolicyTests(unittest.TestCase):
    def test_exited_backend_cannot_leave_ignoring_grandchild(self):
        with tempfile.TemporaryDirectory(prefix="ifcn-descendant-test-") as tmp:
            root = Path(tmp)
            pidfile = root / "grandchild.pid"
            script = root / "parent.py"
            script.write_text("""import pathlib, subprocess, sys, time
p=pathlib.Path(sys.argv[1])
subprocess.Popen([sys.executable,'-c',
 'import os,pathlib,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)',str(p)])
for i in range(100):
 if p.exists(): break
 time.sleep(.01)
""")
            manifest = {"configuration": {}, "parameters": {"timeout_s": 5},
                        "stages": {"pnr": {"log": "stage.log"}}}
            try:
                execute([sys.executable, script, pidfile], root, "pnr", manifest)
                pid = int(pidfile.read_text())
                for _ in range(30):
                    stat = Path(f"/proc/{pid}/stat")
                    if not stat.exists() or stat.read_text().split()[2] == "Z":
                        break
                    time.sleep(.01)
                else:
                    self.fail("Backend descendant survived process-group cleanup")
            finally:
                if pidfile.exists():
                    try:
                        os.kill(int(pidfile.read_text()), 9)
                    except ProcessLookupError:
                        pass

    def run_policy(self, algorithm, failure, expect_error=False):
        with tempfile.TemporaryDirectory(prefix="ifcn-policy-test-") as tmp:
            root = Path(tmp)
            out = root / "02_pnr_1"
            out.mkdir()
            source = "module m(input a, output y); assign y=~a; endmodule"
            (root / "normalized.v").write_text(source)
            (root / "source.v").write_text(source)
            manifest = {"configuration": {"python": sys.executable, "native_pnr_binary": sys.executable,
                                          "backend": "unused", "energy_binary": "fixture-energy"},
                        "parameters": {"algorithm": algorithm, "timeout_s": 30, "seed": 1},
                        "artifacts": {"normalized.v": {"path": "normalized.v"}, "source.v": {"path": "source.v"}},
                        "frontend": {"inputs": ["a"], "outputs": ["y"]}, "metrics": {}, "validation": {}}
            calls = []
            def backend(command, path, step, state, timeout_s):
                if command[0] == "fixture-energy":
                    Path(str(command[2]) + "_energy_input.qca").write_text(
                        "[TYPE:QCADCell]\ncell_function=QCAD_CELL_INPUT\n"
                        "[TYPE:QCADCell]\ncell_function=QCAD_CELL_OUTPUT\n")
                    Path(str(command[2])+"_physical_validation.json").write_text(json.dumps({"schema":"ifcn.qca.physical_routes.v1", "passed":True, "checks":["ordered_route_continuity","source_site_isolation","layer_transition_columns","route_site_coverage","gate_connection_ports"], "net_count":1,"route_count":1,"cell_count":2}))
                    return
                selected = command[command.index("--algorithm") + 1]
                calls.append(selected)
                if selected == "normal_2ddwave":
                    raise failure("first backend failed")
                target = Path(command[command.index("--output") + 1])
                (target / "layout.ifcn").write_text('#nodes info\n0, a, input, (0,0);\n1, y, not, (1,0);\n#nodes info\n#paths info\n(0,1): (0,0),(1,0);\n#paths info\n#phase map\n(0,0):0; (1,0):1;\n#phase map\n')
                (target / "routed_dag.json").write_text(json.dumps({"schema": "ifcn.dag.v1",
                    "nodes": [{"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False},
                              {"id": 1, "name": "y", "type": "not", "is_input": False, "is_output": True}],
                    "edges": [[0, 1]], "input_count": 1, "output_count": 1}))
                (target / "pnr.json").write_text(json.dumps({"algorithm": selected, "layout_legal": True,
                    "failed_edge_count": 0, "clock_legal": True, "clock_template_ok": None,
                    "validation": {"passed": True}, "area_tiles": 9, "ifcn": str(target / "layout.ifcn")}))
            with patch("ifcn_agent.execute", backend):
                if expect_error:
                    with self.assertRaises(failure):
                        run_pnr(out, root, manifest)
                else:
                    run_pnr(out, root, manifest)
            report = json.loads((out / "pnr_attempts.json").read_text())
            return calls, report, manifest

    def test_auto_preserves_failure_and_stops_at_first_valid_result(self):
        calls, report, manifest = self.run_policy("auto", RuntimeError)
        self.assertEqual(calls, ["normal_2ddwave", "normal_2ddwave", "compact"])
        self.assertEqual(report["selected_algorithm"], "compact")
        self.assertEqual([item["status"] for item in report["attempts"]], ["failed", "failed", "completed"])
        self.assertIn("first backend failed", report["attempts"][0]["error"])
        self.assertIn("layout.ifcn", manifest["artifacts"])

    def test_explicit_algorithm_failure_never_switches(self):
        calls, report, _ = self.run_policy("normal_2ddwave", RuntimeError, expect_error=True)
        self.assertEqual(calls, ["normal_2ddwave", "normal_2ddwave"])
        self.assertIsNone(report["selected_algorithm"])

    def test_cancel_never_falls_back(self):
        calls, report, _ = self.run_policy("auto", InterruptedError, expect_error=True)
        self.assertEqual(calls, ["normal_2ddwave"])
        self.assertEqual(report["attempts"][0]["status"], "cancelled")


class VariantSelectionTests(unittest.TestCase):
    def run_variants(self, plans, algorithm="normal_2ddwave", clock=None, legacy=False):
        """Exercise real legality, Boolean and QCA-interface gates; replace only processes/time."""
        with tempfile.TemporaryDirectory(prefix="ifcn-variant-policy-") as temporary:
            root = Path(temporary)
            out = root / "02_pnr_1"
            out.mkdir()
            source = "module m(input a, output y); assign y=~a; endmodule"
            for name in ("source.v", "normalized.v"):
                (root / name).write_text(source)
            parameters = {"timeout_s": 30, "seed": 7}
            if not legacy:
                parameters["algorithm"] = algorithm
            if clock is not None:
                parameters["clock_scheme"] = clock
            manifest = {
                "configuration": {"python": sys.executable, "native_pnr_binary": sys.executable,
                                  "regular_pnr_binary": sys.executable, "backend": "fixture-backend",
                                  "energy_binary": "fixture-energy"},
                "parameters": parameters,
                "artifacts": {name: {"path": name} for name in ("source.v", "normalized.v")},
                "frontend": {"inputs": ["a"], "outputs": ["y"]}, "metrics": {}, "validation": {},
            }
            elapsed = [0.0]
            calls, targets = [], {}

            def backend(command, path, step, state, timeout_s):
                if command[0] == "fixture-energy":
                    target = Path(command[2]).parent
                    plan = targets[target]
                    cells = plan.get("cells", 4)
                    functions = ["QCAD_CELL_INPUT", "QCAD_CELL_OUTPUT"] + ["QCAD_CELL_NORMAL"] * (cells-2)
                    if plan.get("missing_output"):
                        functions[1] = "QCAD_CELL_NORMAL"
                    Path(str(command[2])+"_energy_input.qca").write_text("".join(
                        "[TYPE:QCADCell]\ncell_function="+function+"\n" for function in functions))
                    if not plan.get("missing_physical_certificate"):
                        Path(str(command[2])+"_physical_validation.json").write_text(json.dumps({"schema":"ifcn.qca.physical_routes.v1", "passed":True, "checks":["ordered_route_continuity","source_site_isolation","layer_transition_columns","route_site_coverage","gate_connection_ports"], "net_count":1,"route_count":1,"cell_count":cells}))
                    elapsed[0] += 0.1
                    if plan.get("cancel_after_interface"):
                        (root / "cancel.request").touch()
                    return
                selected = command[command.index("--algorithm")+1]
                variant = (command[command.index("--initial-placement")+1] if "--initial-placement" in command else
                           command[command.index("--topology")+1] if "--topology" in command else "default")
                self.assertLess(len(calls), len(plans), "unexpected additional candidate process")
                plan = plans[len(calls)]
                calls.append({"algorithm": selected, "variant": variant, "timeout_s": timeout_s,
                              "input_name": Path(command[command.index("--input")+1]).name,
                              "input_content": Path(command[command.index("--input")+1]).read_text(),
                              "clock": command[command.index("--clock")+1] if "--clock" in command else None})
                elapsed[0] += plan.get("elapsed", 0.2)
                if plan.get("error"):
                    if plan["error"] is TimeoutError:
                        elapsed[0] += timeout_s
                    raise plan["error"]("deliberate candidate failure")
                target = Path(command[command.index("--output")+1])
                targets[target] = plan
                (target / "layout.ifcn").write_text('#nodes info\n0, a, input, (0,0);\n1, y, not, (1,0);\n#nodes info\n#paths info\n(0,1): (0,0),(1,0);\n#paths info\n#phase map\n(0,0):0; (1,0):1;\n#phase map\n'.replace("(1,0):1", "(1,0):3") if plan.get("bad_clock_arrival") else '#nodes info\n0, a, input, (0,0);\n1, y, not, (1,0);\n#nodes info\n#paths info\n(0,1): (0,0),(1,0);\n#paths info\n#phase map\n(0,0):0; (1,0):1;\n#phase map\n')
                (target / "routed_dag.json").write_text(json.dumps({
                    "schema": "ifcn.dag.v1", "input_count": 1, "output_count": 1,
                    "nodes": [{"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False},
                              {"id": 1, "name": "y", "type": "buf" if plan.get("wrong_logic") else "not",
                               "is_input": False, "is_output": True}], "edges": [[0, 1]]}))
                summary = {"algorithm": selected, "layout_legal": not plan.get("illegal", False),
                           "failed_edge_count": 0, "clock_legal": True, "clock_template_ok": True,
                           "clock_scheme": plan.get("reported_clock", clock or ("2DDWave" if selected == "normal_2ddwave" else "irregular")),
                           "validation": {"passed": True}, "area_tiles": plan.get("area", 10),
                           # This intentionally disagrees with actual QCA cell count in some cases.
                           "mapped_qca_cells": plan.get("reported_cells", 1), "ifcn": str(target / "layout.ifcn")}
                if plan.get("legacy_summary"):
                    for key in ("algorithm", "clock_legal", "clock_scheme", "validation"):
                        summary.pop(key)
                (target / "pnr.json").write_text(json.dumps(summary))

            error = None
            with patch("ifcn_agent.execute", backend), patch("ifcn_agent.time.monotonic", side_effect=lambda: elapsed[0]), \
                    patch("ifcn_agent.STOP", False):
                try:
                    run_pnr(out, root, manifest)
                except Exception as caught:
                    error = caught
            report = json.loads((out / "pnr_attempts.json").read_text())
            reports = {name: json.loads((root / artifact["path"]).read_text()) for name, artifact in
                       manifest["artifacts"].items() if name.startswith("pnr_attempts/") and name.endswith(".json")}
            return {"calls": calls, "report": report, "manifest": manifest, "error": error, "reports": reports}

    def test_candidate_must_not_regress_either_area_or_actual_qca_count(self):
        for area, cells, variant in ((9, 6, "original"), (11, 3, "original"), (10, 4, "original"),
                                     (9, 4, "source_order_transposed"), (10, 3, "source_order_transposed"), (9, 3, "source_order_transposed")):
            with self.subTest(area=area, cells=cells):
                outcome = self.run_variants([{"area": 10, "cells": 4}, {"area": area, "cells": cells, "reported_cells": 1}])
                self.assertIsNone(outcome["error"])
                self.assertEqual(outcome["report"]["selected_variant"], variant)
                self.assertEqual(outcome["report"]["attempts"][1]["qca_cells"], cells)
                selected = [attempt for attempt in outcome["report"]["attempts"] if attempt.get("selected")]
                self.assertEqual(len(selected), 1)
                self.assertEqual(selected[0]["variant"], variant)
                self.assertIn(variant, outcome["manifest"]["artifacts"]["layout.ifcn"]["path"])

    def test_illegal_inequivalent_or_incomplete_device_candidate_cannot_replace_baseline(self):
        for invalid, diagnostic in (({"illegal": True}, "legality"), ({"wrong_logic": True}, "not_equivalent"),
                                    ({"missing_output": True}, "QCA interface incomplete"),
                                    ({"bad_clock_arrival": True}, "Clock arrival alignment"),
                                    ({"missing_physical_certificate": True}, "physical route certification")):
            with self.subTest(invalid=invalid):
                outcome = self.run_variants([{}, {"area": 1, "cells": 2, **invalid}])
                self.assertIsNone(outcome["error"])
                self.assertEqual(outcome["report"]["selected_variant"], "original")
                second = outcome["report"]["attempts"][1]
                self.assertEqual(second["status"], "failed")
                self.assertIn(diagnostic, second["error"])
                self.assertNotIn("selected", second)
                if invalid.get("wrong_logic"):
                    logic = next(report for name, report in outcome["reports"].items() if "transposed_logic" in name)
                    self.assertEqual(logic["status"], "not_equivalent")
                    self.assertTrue(logic["counterexamples"])

    def test_second_variant_timeout_preserves_baseline_and_shared_time_budget(self):
        outcome = self.run_variants([{"elapsed": 8}, {"error": TimeoutError}])
        self.assertIsNone(outcome["error"])
        self.assertEqual(outcome["report"]["selected_variant"], "original")
        self.assertEqual(outcome["report"]["attempts"][1]["status"], "failed")
        self.assertLess(outcome["calls"][1]["timeout_s"], outcome["calls"][0]["timeout_s"]-8)
        self.assertEqual(outcome["manifest"]["validation"]["rtl_equivalence"], "exhaustive_scalar_source_vs_routed_dag")
        self.assertIn("validated_device.qca", outcome["manifest"]["artifacts"])

    def test_cancellation_never_commits_a_previous_success(self):
        for plans in ([{}, {"error": InterruptedError}], [{"cancel_after_interface": True}]):
            with self.subTest(plans=plans):
                outcome = self.run_variants(plans)
                self.assertIsInstance(outcome["error"], InterruptedError)
                self.assertNotIn("layout.ifcn", outcome["manifest"]["artifacts"])
                self.assertNotIn("pnr", outcome["manifest"]["metrics"])
                self.assertIsNone(outcome["report"]["selected_algorithm"])
                self.assertIsNone(outcome["report"]["selected_variant"])
                self.assertFalse(any(attempt.get("selected") for attempt in outcome["report"]["attempts"]))

    def test_clock_constrained_auto_never_crosses_clock_family(self):
        choices = {"2DDWave": ["normal_2ddwave", "normal_2ddwave", "regular_clock_ga"],
                   "USE": ["regular_clock_ga"], "RES": ["regular_clock_ga"],
                   "irregular": ["compact", "june_random", "june_random"]}
        for clock, algorithms in choices.items():
            with self.subTest(clock=clock):
                outcome = self.run_variants([{"error": RuntimeError}] * len(algorithms), algorithm="auto", clock=clock)
                self.assertIsInstance(outcome["error"], RuntimeError)
                self.assertEqual([call["algorithm"] for call in outcome["calls"]], algorithms)
                self.assertEqual({call["clock"] for call in outcome["calls"]}, {clock})
                self.assertIsNone(outcome["report"]["selected_algorithm"])
        self.assertEqual(pnr_candidates("auto"), list(DEFAULT_AUTO_ALGORITHMS))

    def test_explicit_clock_mismatch_fails_closed_even_in_a_tampered_run(self):
        outcome = self.run_variants([{"reported_clock": "irregular"}, {"reported_clock": "irregular"}], clock="2DDWave")
        self.assertIsInstance(outcome["error"], RuntimeError)
        self.assertNotIn("layout.ifcn", outcome["manifest"]["artifacts"])
        self.assertTrue(all("different clock scheme" in item["error"] for item in outcome["report"]["attempts"]))

    def test_june_variants_keep_distinct_topology_evidence(self):
        outcome = self.run_variants([{"area": 12, "cells": 8}, {"area": 10, "cells": 7}], algorithm="june_random", clock="irregular")
        self.assertIsNone(outcome["error"])
        self.assertEqual([call["variant"] for call in outcome["calls"]], ["layer_redundancy_buffers", "optimized_buffers"])
        self.assertEqual(outcome["report"]["selected_variant"], "optimized_buffers")

    def test_normal_baseline_input_is_unchanged_and_source_order_variant_is_preserved(self):
        outcome = self.run_variants([{}, {"area": 9}])
        self.assertIsNone(outcome["error"])
        self.assertEqual([call["input_name"] for call in outcome["calls"]], ["normalized.v", "placement_input.v"])
        self.assertEqual([call["variant"] for call in outcome["calls"]], ["original", "transposed"])
        self.assertEqual(outcome["calls"][1]["input_content"], normalize_verilog(
            outcome["calls"][0]["input_content"], source_order=True)[0])
        self.assertTrue(any(name.endswith("source_order_transposed_input.v") for name in outcome["manifest"]["artifacts"]))

    def test_legacy_manifest_without_algorithm_or_clock_retains_validated_default(self):
        outcome = self.run_variants([{"legacy_summary": True}, {"error": TimeoutError}], legacy=True)
        self.assertIsNone(outcome["error"])
        self.assertEqual(outcome["report"]["requested_algorithm"], "normal_2ddwave")
        self.assertIsNone(outcome["report"]["requested_clock"])
        self.assertEqual(outcome["report"]["selected_variant"], "original")
        self.assertEqual(outcome["manifest"]["validation"]["device_terminal_counts"], "match_source_declarations")
        self.assertIn("logic.json", outcome["manifest"]["artifacts"])


class ClockSelectionTests(unittest.TestCase):
    def test_default_and_explicit_regular_clocks(self):
        self.assertEqual(resolve_design_selection("combinational"), ("normal_2ddwave", "2DDWave"))
        self.assertEqual(resolve_design_selection("combinational", clock="USE"), ("regular_clock_ga", "USE"))
        self.assertEqual(resolve_design_selection("combinational", clock="RES"), ("regular_clock_ga", "RES"))
        self.assertEqual(resolve_design_selection("combinational", "auto", "2DDWave"), ("auto", "2DDWave"))
        self.assertEqual(resolve_design_selection("sequential"), ("sequential_cyclic", "irregular"))

    def test_mismatched_algorithms_clocks_and_design_modes_are_rejected(self):
        for design, algorithm, clock in (("combinational", "normal_2ddwave", "USE"),
                                         ("combinational", "compact", "2DDWave"),
                                         ("combinational", "june_random", "RES"),
                                         ("combinational", "regular_clock_ga", "irregular"),
                                         ("combinational", "sequential_cyclic", None),
                                         ("sequential", "auto", None), ("sequential", None, "USE"),
                                         ("combinational", "auto", "BANCS")):
            with self.subTest(design=design, algorithm=algorithm, clock=clock), self.assertRaises(ValueError):
                resolve_design_selection(design, algorithm, clock)


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ifcn-agent-test-")
        self.path = Path(self.temporary.name)
        self.runs = self.path / "runs"
        self.source = self.path / "with space.v"
        self.source.write_text("module m(input a, output y); assign y=~a; endmodule")
        fake = self.path / "fake-python"
        fake.write_text("""#!/usr/bin/python3
import json, pathlib, sys, time
p=pathlib.Path(__file__).parent
if (p/'pause').exists(): time.sleep(5)
out=pathlib.Path(sys.argv[sys.argv.index('--output')+1])
(out/'dag.json').write_text(json.dumps({'input_count':1,'output_count':1}))
(out/'dag.dot').write_text('digraph {}')
""")
        fake.chmod(0o700)
        self.env = dict(os.environ, IFCN_PYTHON=str(fake))
        self.run_id = None

    def command(self, *args, ok=True):
        run = subprocess.run([sys.executable, str(ROOT / "scripts/ifcn_agent.py"),
                              "--runs-dir", str(self.runs), *args], env=self.env,
                             capture_output=True, text=True, timeout=10)
        if ok:
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        else:
            self.assertNotEqual(run.returncode, 0)
        return json.loads(run.stdout)

    def start(self, timeout=20):
        result = self.command("start", str(self.source), "--until", "parse", "--timeout", str(timeout))
        self.run_id = result["run_id"]
        return result

    def wait(self):
        for _ in range(100):
            result = self.command("status", self.run_id)
            if not result["active"]:
                return result
            time.sleep(0.1)
        self.fail("Worker did not settle.")

    def tearDown(self):
        if self.run_id:
            self.command("cancel", self.run_id)
            self.wait()
        self.temporary.cleanup()

    def test_snapshots_and_tamper_guard(self):
        self.start()
        self.source.write_text("changed after submission")
        result = self.wait()
        self.assertEqual(result["status"], "completed")
        artifact = self.command("read", self.run_id, "source.v")
        self.assertIn("assign y=~a", artifact["content"])
        self.command("resume", self.run_id, "--until", "parse")
        self.assertEqual(self.wait()["stages"]["parse"]["attempt"], 1)
        dag = self.runs / self.run_id / result["artifacts"]["dag.json"]["path"]
        dag.write_text("tampered")
        self.command("resume", self.run_id, "--until", "parse", ok=False)
        self.command("read", self.run_id, "../../etc/passwd", ok=False)

    def test_incompatible_clock_is_rejected_before_a_job_is_created(self):
        for algorithm, clock in (("normal_2ddwave", "USE"), ("compact", "2DDWave"),
                                  ("regular_clock_ga", "irregular")):
            with self.subTest(algorithm=algorithm, clock=clock):
                self.command("start", str(self.source), "--until", "parse", "--algorithm", algorithm,
                             "--clock", clock, ok=False)
                self.assertFalse(self.runs.exists() and any(self.runs.iterdir()))

    def test_cancel_lock_and_resume(self):
        pause = self.path / "pause"
        pause.touch()
        self.start()
        self.command("resume", self.run_id, "--until", "parse", ok=False)
        time.sleep(0.3)
        self.command("cancel", self.run_id)
        self.assertEqual(self.wait()["status"], "cancelled")
        pause.unlink()
        self.command("resume", self.run_id, "--until", "parse")
        result = self.wait()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["stages"]["parse"]["attempt"], 2)

    def test_timeout_and_resume(self):
        pause = self.path / "pause"
        pause.touch()
        self.start(timeout=1)
        self.assertEqual(self.wait()["status"], "failed")
        pause.unlink()
        self.command("resume", self.run_id, "--until", "parse")
        self.assertEqual(self.wait()["status"], "completed")

    def test_legacy_pnr_resume_cannot_skip_logic_guard(self):
        self.start()
        self.wait()
        path = self.runs / self.run_id / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["stages"]["pnr"] = {"status": "completed", "attempt": 1}
        # A valid hash alone is insufficient: the old graph lacks explicit
        # logic/port information and must not be approved by a PNR-only resume.
        manifest["artifacts"]["routed_dag.json"] = manifest["artifacts"]["dag.json"]
        path.write_text(json.dumps(manifest))
        self.command("resume", self.run_id, "--until", "pnr")
        state = self.wait()
        self.assertEqual(state["status"], "failed")
        self.assertIn("Routed logic validation unsupported", state["error"])


if __name__ == "__main__":
    unittest.main()
