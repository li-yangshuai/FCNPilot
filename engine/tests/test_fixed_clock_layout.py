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
