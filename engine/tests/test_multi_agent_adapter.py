"""Boundary tests for the durable research bridge; no provider calls."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ifcn_agent as api
import ifcn_agent_multi_agent as bridge


def options(mode="multi_agent", *extra):
    p = argparse.ArgumentParser()
    bridge.add_commands(p.add_subparsers(dest="command"))
    return p.parse_args([mode, "/source.v", *extra])


class ResearchAdapterTests(unittest.TestCase):
    def test_offline_default_and_explicit_model_repair(self):
        args = options()
        self.assertEqual(args.max_model_calls, 0)
        bridge.validate_options(args)
        for condition, calls in [("llm_single", "0"), ("clock_window", "1")]:
            with self.assertRaisesRegex(ValueError, "explicit model-call budget"):
                bridge.validate_options(options("clock_repair", "--snapshot", "/snapshot.json",
                                                "--condition", condition, "--max-model-calls", calls))
        bridge.validate_options(options("clock_repair", "--snapshot", "/snapshot.json",
                                        "--condition", "llm_negotiated", "--max-model-calls", "6"))

    def test_finite_budgets_and_actual_node_limit(self):
        for flag, value in [("--budget", "nan"), ("--budget", "inf"), ("--max-nodes", "150"),
                            ("--max-model-calls", "-1"), ("--max-model-tokens", "4097")]:
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                bridge.validate_options(options("multi_agent", flag, value))

    def test_backend_absence_is_explicit(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"IFCN_MULTI_AGENT_ROOT": d}):
            result = bridge.capabilities(api.ROOT)
            self.assertFalse(result["available"])
            self.assertEqual(result["default_max_model_calls"], 0)
            with self.assertRaisesRegex(ValueError, "backend unavailable"):
                bridge.create_run(api, options(), Path(d) / "runs")
            self.assertFalse((Path(d) / "runs").exists())

    def test_sources_are_frozen_and_resume_cannot_replay_calls(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d) / "runs"
            source = Path(d) / "c.v"
            source.write_text("module m(input a, output y); assign y=~a; endmodule\n")
            args = options()
            args.input = str(source)
            cap = {"available": True, "configuration": bridge.configuration(api.ROOT)}
            with patch.object(bridge, "capabilities", return_value=cap), patch.object(api, "start_worker", side_effect=lambda path, until: path):
                path = bridge.create_run(api, args, base)
            manifest = api.load_run(path)
            self.assertEqual(manifest["requested_until"], "multi_agent")
            self.assertEqual(manifest["parameters"]["max_model_calls"], 0)
            source.write_text("changed")
            self.assertNotEqual(source.read_bytes(), (path / "source.v").read_bytes())
            api.verify_artifacts(path, manifest)
            manifest["status"] = "interrupted"
            api.write_json(path / "manifest.json", manifest)
            with self.assertRaisesRegex(ValueError, "not replayed"):
                api.start_worker(path, None)
            self.assertEqual(api.load_run(path)["status"], "interrupted")

    def test_unrecovered_search_retains_evidence_without_certification(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d) / "runs"
            source = Path(d) / "c.v"
            source.write_text("module m(input a, output y); assign y=~a; endmodule\n")
            args = options(); args.input = str(source)
            cap = {"available": True, "configuration": bridge.configuration(api.ROOT)}
            with patch.object(bridge, "capabilities", return_value=cap), patch.object(api, "start_worker", side_effect=lambda path, until: path):
                path = bridge.create_run(api, args, base)
            def execute(*_a, **_kw):
                (path / "search").mkdir()
                api.write_json(path / "search/result.json", {"status": "unrecovered"})
                api.write_json(path / "research-summary.json", {"status": "unrecovered", "layout_validated": False})
            fd = api.lock_run(path)
            with patch.object(api, "execute", side_effect=execute):
                bridge.run_worker(api, path, fd)
            result = api.load_run(path)
            self.assertEqual(result["status"], "completed_with_warnings")
            self.assertEqual(result["validation"]["layout_model"], "not_validated")
            self.assertEqual(result["validation"]["physical_function"], "not_verified")
            self.assertIn("search/result.json", result["artifacts"])
            self.assertIn("result.json", result["artifacts"])
            api.verify_artifacts(path, result)


if __name__ == "__main__":
    unittest.main()
