"""Baseline loader contract tests; no native generation or model requests."""
from __future__ import annotations
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("joint_study_for_baseline_tests", ROOT / "experiments/llm_joint_search/run_study.py")
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class JointBaselineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="joint-baseline-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.root / ("a" * 32)
        self.origin.mkdir()
        self.inputs = self.root / "inputs"
        # Synthetic metadata fixture for rejection/path-binding unit checks;
        # actual physical correctness is covered by the two real runs below.
        source = "module top(a,out); input a; output out; assign out=~a; endmodule\n"
        normalized, frontend = study.api.normalize_verilog(source)
        candidate = {"schema": "ifcn.native_candidate.v1", "algorithm": "june_random",
                     "topology": "optimized_buffers", "routed": True,
                     "nodes": [{"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False, "x": 0, "y": 0},
                               {"id": 1, "name": "out", "type": "not", "is_input": False, "is_output": True, "x": 1, "y": 0}],
                     "edges": [[0, 1]], "routes": [{"source": 0, "target": 1, "path": [[0, 0], [1, 0]]}],
                     "layers": [[0], [1]], "cells": [{"x": 0, "y": 0, "phase": 1}, {"x": 1, "y": 0, "phase": 2}]}
        dag = {"schema": "ifcn.dag.v1", "nodes": [{k: n[k] for k in ("id", "name", "type", "is_input", "is_output")} for n in candidate["nodes"]],
               "edges": candidate["edges"], "layers": candidate["layers"], "input_count": 1, "output_count": 1}
        self.paths = {"source.v": "arbitrary/source.txt", "normalized.v": "arbitrary/normalized.txt",
                      "layout_candidate.json": "chosen/geometry.json", "routed_dag.json": "chosen/logic.json",
                      "layout.ifcn": "chosen/gate.ifcn", "physical.json": "certificates/device.json",
                      "clock.json": "certificates/clock.json", "validated_device.qca": "chosen/cells.qca"}
        for rel in self.paths.values(): (self.origin / rel).parent.mkdir(parents=True, exist_ok=True)
        self.file("source.v").write_text(source)
        self.file("normalized.v").write_text(normalized)
        self.file("layout_candidate.json").write_text(json.dumps(candidate))
        self.file("routed_dag.json").write_text(json.dumps(dag))
        study.export_native_ifcn(candidate, self.file("layout.ifcn"), "june_random")
        study.clock_arrival_report(self.file("layout.ifcn"), self.file("routed_dag.json"), self.file("clock.json"))
        self.file("validated_device.qca").write_text("[TYPE:QCADCell]\ncell_function=QCAD_CELL_INPUT\n[#TYPE:QCADCell]\n[TYPE:QCADCell]\ncell_function=QCAD_CELL_OUTPUT\n[#TYPE:QCADCell]\n")
        physical = {"schema": "ifcn.qca.physical_routes.v1", "passed": True, "cell_count": 2,
                    "route_count": 1, "net_count": 1, "qca_sha256": study.api.digest(self.file("validated_device.qca")),
                    "ifcn_sha256": study.api.digest(self.file("layout.ifcn")),
                    "checks": ["ordered_route_continuity", "source_site_isolation", "layer_transition_columns", "route_site_coverage", "gate_connection_ports"]}
        self.file("physical.json").write_text(json.dumps(physical))
        self.manifest = {"schema": "ifcn.pi.run.v1", "run_id": self.origin.name, "status": "completed",
                         "design_type": "combinational", "source": {"path": "/somewhere/TOY/inverter.v"},
                         "stages": {"pnr": {"status": "completed"}, "map": {"status": "completed"}},
                         "parameters": {"algorithm": "auto", "clock_scheme": "irregular"},
                         "metrics": {"pnr": {"algorithm": "june_random", "clock_scheme": "irregular"}},
                         "frontend": frontend, "configuration": study.api.configuration(),
                         "validation": {"clock_arrival": "cycle_zero_at_template_phase_passed",
                                        "physical_routes": "source_isolation_and_ordered_paths_passed",
                                        "rtl_equivalence": "exhaustive_scalar_source_vs_routed_dag",
                                        "device_terminal_counts": "match_source_declarations"},
                         "artifacts": {}}
        for key in self.paths: self.register(key)
        self.commit()

    def file(self, key): return self.origin / self.paths[key]
    def register(self, key):
        p = self.file(key)
        self.manifest["artifacts"][key] = {"path": self.paths[key], "bytes": p.stat().st_size, "sha256": study.api.digest(p)}
    def commit(self): (self.origin / "manifest.json").write_text(json.dumps(self.manifest))
    def rewrite(self, key, value):
        self.file(key).write_text(json.dumps(value))
        self.register(key)
        self.commit()
    def load(self): return study.prepare_baseline(self.origin, self.inputs)

    def test_manifest_mapping_auto_algorithm_and_missing_legacy_candidate_clock(self):
        before = {str(p): study.api.digest(p) for p in self.origin.rglob("*") if p.is_file()}
        result = self.load()
        self.assertEqual(result["case_id"], "TOY/inverter.v")
        self.assertEqual(result["metrics"]["qca_cells"], 2)
        self.assertEqual(result["metrics"]["area_tiles"], 2)
        self.assertNotIn("clock_scheme", result["baseline"])
        self.assertEqual(set(result), {"manifest", "baseline", "clock", "metrics", "case_id", "source_artifacts"})
        self.assertEqual((self.inputs / "device_energy_input.qca").read_bytes(), self.file("validated_device.qca").read_bytes())
        self.assertEqual(result["source_artifacts"][str(self.file("source.v"))], before[str(self.file("source.v"))])
        self.assertTrue(all(study.api.digest(Path(p)) == digest for p, digest in before.items()))

    def test_prefer_validated_qca_and_support_registered_fallback(self):
        self.paths["device.qca"] = "chosen/unselected.qca"
        self.file("device.qca").write_text("A separately registered output that is not the validated device")
        self.register("device.qca"); self.commit()
        result = self.load()
        self.assertEqual(result["metrics"]["qca_cells"], 2)
        self.assertEqual((self.inputs / "device_energy_input.qca").read_bytes(), self.file("validated_device.qca").read_bytes())
        self.inputs = self.root / "fallback-inputs"
        self.manifest["artifacts"]["device.qca"] = self.manifest["artifacts"].pop("validated_device.qca")
        self.commit()
        self.assertEqual(self.load()["metrics"]["qca_cells"], 2)

    def test_existing_inputs_are_never_overwritten(self):
        self.inputs.mkdir(); marker = self.inputs / "keep.txt"; marker.write_text("original")
        with self.assertRaisesRegex(ValueError, "overwrite"): self.load()
        self.assertEqual(marker.read_text(), "original")
        with self.assertRaisesRegex(ValueError, "outside"): study.prepare_baseline(self.origin, self.origin / "new-inputs")

    def test_missing_completed_state_certificates_and_fixed_clock_rejected(self):
        original = copy.deepcopy(self.manifest)
        edits = [("status", "running"), ("design_type", "sequential"), ("run_id", "b" * 32), ("active", True)]
        for key, value in edits:
            with self.subTest(key=key):
                self.manifest = copy.deepcopy(original); self.manifest[key] = value; self.commit()
                with self.assertRaises(ValueError): self.load()
        for key in original["validation"]:
            with self.subTest(certificate=key):
                self.manifest = copy.deepcopy(original); self.manifest["validation"].pop(key); self.commit()
                with self.assertRaisesRegex(ValueError, "certificates"): self.load()
        for section in ("parameters", "metrics"):
            self.manifest = copy.deepcopy(original)
            selected = self.manifest[section] if section == "parameters" else self.manifest["metrics"]["pnr"]
            selected["clock_scheme"] = "2DDWave"; self.commit()
            with self.assertRaises(ValueError): self.load()
        self.manifest = copy.deepcopy(original); self.manifest["stages"]["map"]["status"] = "failed"; self.commit()
        with self.assertRaisesRegex(ValueError, "stages"): self.load()

    def test_artifact_forged_hash_size_and_escape_rejected(self):
        original = copy.deepcopy(self.manifest)
        changes = [("sha256", "0" * 64), ("bytes", 999999), ("bytes", True), ("path", "../escape.v")]
        for key, value in changes:
            with self.subTest(field=key, value=value):
                self.manifest = copy.deepcopy(original); self.manifest["artifacts"]["source.v"][key] = value; self.commit()
                with self.assertRaises(ValueError): self.load()
        self.manifest = copy.deepcopy(original); self.manifest["artifacts"].pop("clock.json"); self.commit()
        with self.assertRaisesRegex(ValueError, "Missing registered"): self.load()

    def test_clock_and_physical_certificates_must_bind_current_artifacts(self):
        for key, field in [("clock.json", "ifcn_sha256"), ("physical.json", "qca_sha256")]:
            with self.subTest(certificate=key):
                original = json.loads(self.file(key).read_text()); forged = copy.deepcopy(original); forged[field] = "0" * 64
                self.rewrite(key, forged)
                with self.assertRaisesRegex(ValueError, "binding"): self.load()
                self.rewrite(key, original)

    def test_candidate_ifcn_and_source_normalized_dag_binding(self):
        candidate = json.loads(self.file("layout_candidate.json").read_text())
        candidate["nodes"][1]["name"] = "forged"
        self.rewrite("layout_candidate.json", candidate)
        with self.assertRaises(ValueError): self.load()
        candidate["nodes"][1]["name"] = "out"; self.rewrite("layout_candidate.json", candidate)
        self.file("normalized.v").write_text("module top(a,out); input a; output out; assign out=a; endmodule\n")
        self.register("normalized.v"); self.commit()
        with self.assertRaises(ValueError): self.load()

    def test_bounds_and_frontend_forgeries_are_rejected(self):
        candidate = json.loads(self.file("layout_candidate.json").read_text())
        original = copy.deepcopy(candidate)
        candidate["nodes"] += [copy.deepcopy(candidate["nodes"][0]) for _ in range(49)]
        self.rewrite("layout_candidate.json", candidate)
        with self.assertRaisesRegex(ValueError, "50-node"): self.load()
        candidate = copy.deepcopy(original); candidate["routes"] *= 101; self.rewrite("layout_candidate.json", candidate)
        with self.assertRaisesRegex(ValueError, "100-route"): self.load()
        self.rewrite("layout_candidate.json", original)
        self.manifest["frontend"]["inputs"] = ["forged"]; self.commit()
        with self.assertRaisesRegex(ValueError, "source declarations"): self.load()

    def test_exhaustive_input_limit_cannot_be_bypassed_by_manifest(self):
        names = ["a" + str(i) for i in range(12)]
        source = "module top(" + ",".join(names + ["out"]) + "); input " + ",".join(names) + "; output out; assign out=~a0; endmodule\n"
        self.file("source.v").write_text(source)
        self.register("source.v")
        _, self.manifest["frontend"] = study.api.normalize_verilog(source)
        self.commit()
        with self.assertRaisesRegex(ValueError, "11-input"): self.load()

    def test_cli_requires_run_id_and_paired_model_arguments(self):
        invalid = [[], ["--output", "unused"], ["--output", "unused", "--run-id", "../escape"],
                   ["--output", "unused", "--run-id", "A" * 32],
                   ["--output", "unused", "--run-id", "a" * 32, "--rounds", "0"],
                   ["--output", "unused", "--run-id", "a" * 32, "--provider", "provider"],
                   ["--output", "unused", "--run-id", "a" * 32, "--model-id", "model"]]
        for argv in invalid:
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                study.parse_arguments(argv)
        args = study.parse_arguments(["--output", "unused", "--run-id", "a" * 32, "--provider", "p", "--model-id", "m"])
        self.assertEqual(study.selected_model({}, args.provider, args.model_id), {"provider": "p", "modelId": "m"})
        self.assertIsNone(study.selected_model({}))
        self.assertEqual(study.selected_model({"optimization": {"model": {"provider": "p", "modelId": "m"}}}), {"provider": "p", "modelId": "m"})

    def test_unset_model_is_omitted_without_reading_credentials(self):
        target = self.root / "request-test"; target.mkdir()
        def fake_process(*args, **kwargs):
            kwargs["stdout"].write(json.dumps({"status": "ok", "model": {"provider": "configured", "modelId": "current"}}))
            kwargs["stdout"].flush()
            return Mock(wait=Mock(return_value=0))
        with patch.object(study.subprocess, "Popen", side_effect=fake_process):
            audit, _ = study.model_call("unused-node", {}, None, target, "unit-mocked-request")
        self.assertNotIn("model", json.loads((target / "request.json").read_text()))
        self.assertEqual(audit["model"]["provider"], "configured")


class RealJointBaselineTest(unittest.TestCase):
    def test_legacy_arrival_certificate_does_not_bypass_same_phase_limits(self):
        origin = ROOT / "engine/output/pi-runs/481ef7da26b64701a9307dd92172c312"
        if not (origin / "manifest.json").is_file(): self.skipTest("Local historical b1_r2 baseline is unavailable")
        manifest = study.api.load_run(origin)
        candidate = json.loads(study.api.artifact_path(origin, manifest["artifacts"]["layout_candidate.json"]).read_text())
        phases = {(c["x"], c["y"]): c["phase"] for c in candidate["cells"]}
        holds = steps = 0; longest = 1
        for route in candidate["routes"]:
            run = 1
            for a, b in zip(route["path"], route["path"][1:]):
                same = phases[tuple(a)] == phases[tuple(b)]
                holds += same; steps += 1; run = run + 1 if same else 1; longest = max(longest, run)
        self.assertEqual((longest, holds, steps), (12, 98, 118))
        self.assertEqual(manifest["validation"]["clock_arrival"], "cycle_zero_at_template_phase_passed")
        before = {str(p): study.api.digest(p) for p in origin.rglob("*") if p.is_file()}
        with tempfile.TemporaryDirectory(prefix="joint-reject-old-clock-") as tmp:
            target = Path(tmp) / "inputs"
            with patch.object(study.subprocess, "Popen", side_effect=AssertionError("No process should be launched")), self.assertRaisesRegex(ValueError, "same-phase clock constraints"):
                study.prepare_baseline(origin, target)
            self.assertFalse(target.exists())
        self.assertTrue(all(study.api.digest(Path(p)) == digest for p, digest in before.items()))

    def test_two_real_certified_toy_and_maj_baselines_are_loaded_read_only(self):
        samples = [("b5f6b42d36c5497597a766ffce7802aa", "TOY/1bitAdderAOIG.v", 479),
                   ("84e933871a534feaa6787e209597a810", "MAJ/par_gen.v", 1361)]
        with tempfile.TemporaryDirectory(prefix="joint-real-baseline-") as tmp:
            for run_id, case_id, expected_cells in samples:
                origin = ROOT / "engine/output/pi-runs" / run_id
                if not (origin / "manifest.json").is_file(): self.skipTest("Local historical certified run is unavailable: " + run_id)
                before = {str(p): study.api.digest(p) for p in origin.rglob("*") if p.is_file()}
                with self.subTest(case=case_id), patch.object(study.subprocess, "Popen", side_effect=AssertionError("No process should be launched during baseline validation")):
                    result = study.prepare_baseline(origin, Path(tmp) / run_id)
                    self.assertEqual(result["case_id"], case_id)
                    self.assertEqual(result["metrics"]["qca_cells"], expected_cells)
                    self.assertTrue(result["clock"]["passed"])
                self.assertTrue(all(study.api.digest(Path(p)) == digest for p, digest in before.items()))


if __name__ == "__main__": unittest.main()
