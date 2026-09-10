"""Real headless regular-clock candidates, exporter and rejected CLI inputs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("IFCN_BUILD_DIR", ROOT / "build"))
sys.path.insert(0, str(ROOT / "scripts"))
from ifcn_agent_layout_validation import validate_candidate


class RegularClockNativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ifcn-regular-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / "and_or.v"
        self.source.write_text("module combo(a,b,c,y);\ninput a,b,c;\noutput y;\nwire y,n;\nassign n=a&b;\nassign y=n|c;\nendmodule\n")

    def run_native(self, *arguments):
        output = self.directory / "candidate.json"
        output.unlink(missing_ok=True)
        result = subprocess.run([str(BUILD / "ifcn_regular_clock_pnr"), str(self.source), str(output),
                                 *arguments], text=True, capture_output=True, timeout=10)
        return result, json.loads(output.read_text()) if output.exists() else None

    def test_real_three_template_candidates(self):
        for clock in ("2DDWave", "USE", "RES"):
            with self.subTest(clock=clock):
                result, candidate = self.run_native("--clock", clock, "--seed", "7", "--budget", "5",
                                                     "--generations", "150", "--population", "96")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(candidate["clock_scheme"], clock)
                self.assertTrue(candidate["regular_clock_valid"])
                self.assertTrue(candidate["synchronization_valid"])
                self.assertTrue(candidate["native_mapping_valid"])
                self.assertTrue(validate_candidate(candidate, source_crossings=True)["passed"])
                self.assertGreater(candidate["mapped_qca_cells"], 0)
                self.assertGreater(candidate["physical_area"], 0)
                phases = {(c["x"], c["y"]): c["phase"] for c in candidate["cells"]}
                ticks = candidate["regular_validation"]["arrival_ticks"]
                for route in candidate["routes"]:
                    self.assertEqual(ticks[str(route["target"])], ticks[str(route["source"])]+len(route["path"])-1)
                    for first, second in zip(route["path"], route["path"][1:]):
                        self.assertEqual((phases[tuple(second)]-phases[tuple(first)]) % 4, 1)

    def test_rejects_unknown_clock_and_malformed_search(self):
        cases = [("--clock", "BANCS"), ("--clock", "2DDwave"), ("--clock", "TDD"),
                 ("--clock", "USE", "--population", "1"), ("--clock", "RES", "--width", "0"),
                 ("--clock", "USE", "--budget", "nan"), ("--clock", "USE", "--seed", "-1"),
                 ("--clock", "USE", "--clock", "RES"), ("--clock", "USE", "--mystery", "1"),
                 ("--clock", "USE", "--width", "1", "--height", "1")]
        for case in cases:
            with self.subTest(arguments=case):
                result, candidate = self.run_native(*case)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(candidate)

    def test_full_grid_failure_is_bounded_and_truthful(self):
        result, candidate = self.run_native("--clock", "2DDWave", "--width", "5", "--height", "1",
                                             "--population", "2", "--generations", "100", "--budget", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(candidate["routed"])
        self.assertFalse(candidate["regular_clock_valid"])
        self.assertFalse(candidate["synchronization_valid"])
        self.assertFalse(candidate["native_mapping_valid"])
        self.assertTrue(candidate["native_validation_error"])


if __name__ == "__main__":
    unittest.main()
