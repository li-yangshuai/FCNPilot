"""Regression against the independently frozen pre-consolidation XOR layout."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FixedClockLayoutRegression(unittest.TestCase):
    def test_parse_preserves_explicit_state_outputs_only_when_requested(self):
        source = """module ifcn_cut_toggle_ff(q0,i0,d0);
input q0,i0;
output d0;
wire d0,n0;
assign n0=i0|q0;
assign d0=~n0;
endmodule
"""
        with tempfile.TemporaryDirectory(prefix="fcnpilot-output-boundary-") as temporary:
            directory = Path(temporary)
            input_path = directory / "cut.v"
            input_path.write_text(source)
            records = {}
            for preserve in (False, True):
                output = directory / ("preserved" if preserve else "default")
                command = [sys.executable, str(ROOT / "scripts/ifcn_agent_backend.py"), "parse",
                           "--input", str(input_path), "--output", str(output)]
                if preserve:
                    command.append("--preserve-output-boundaries")
                result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                records[preserve] = json.loads((output / "dag.json").read_text())

            fused = records[False]
            preserved = records[True]
            self.assertEqual([node["name"] for node in fused["nodes"] if node["is_output"]], ["~n0"])
            outputs = [node for node in preserved["nodes"] if node["is_output"]]
            self.assertEqual([node["name"] for node in outputs], ["d0"])
            self.assertEqual(outputs[0]["type"], "output")
            self.assertEqual(len(preserved["nodes"]), len(fused["nodes"]) + 1)
            driver = next(node for node in preserved["nodes"] if node["name"] == "~n0")
            self.assertFalse(driver["is_output"])
            self.assertIn([driver["id"], outputs[0]["id"]], preserved["edges"])
            self.assertEqual(preserved["input_count"], fused["input_count"])
            self.assertEqual(preserved["output_count"], fused["output_count"])

    def test_numpy_layout_preserves_frozen_routes_and_device_export(self):
        expected = json.loads((ROOT / "tests/fixtures/pi_layout/xor2_fixed_clock.json").read_text())
        with tempfile.TemporaryDirectory(prefix="fcnpilot-layout-test-") as temporary:
            output = Path(temporary)
            env = os.environ.copy()
            env.update(MPLCONFIGDIR=str(output / "mpl"), MPLBACKEND="Agg")
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/ifcn_agent_backend.py"), "pnr",
                 "--algorithm", "normal_2ddwave", "--seed", "1", "--budget", "30",
                 "--input", str(ROOT / "tests/benchmarks_pi/v1/TOY/xor2.v"),
                 "--output", str(output)],
                capture_output=True, text=True, timeout=45, env=env,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            candidate = json.loads((output / "layout_candidate.json").read_text())
            self.assertEqual(candidate, expected)
            summary = json.loads((output / "pnr.json").read_text())
            self.assertTrue(summary["validation"]["passed"])
            self.assertEqual(summary["area_tiles"], 12)
            self.assertTrue(summary["mapping_validation"]["passed"])
            exported = (output / "layout.ifcn").read_text()
            self.assertIn("#cell count: 76", exported)
            self.assertIn("#cross count: 1", exported)


if __name__ == "__main__":
    unittest.main()
