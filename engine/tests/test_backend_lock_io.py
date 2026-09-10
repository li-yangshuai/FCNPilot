"""Backend fixed-I/O argument propagation; no model or native work in these mocks."""
from contextlib import redirect_stderr
import io
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ifcn_agent_backend as backend


class CommandCaptured(Exception):
    pass


class BackendLockIoTests(unittest.TestCase):
    def test_lock_io_is_forwarded_only_for_edit_execution(self):
        with tempfile.TemporaryDirectory(prefix="fcn-backend-pin-") as directory:
            root = Path(directory)
            for editing, locked in [(True, False), (True, True), (False, False)]:
                args = SimpleNamespace(algorithm="june_random", input="source.v", topology=None,
                                       clock="irregular", seed=1, budget=20,
                                       edit_baseline="baseline.json" if editing else None,
                                       edit_proposal="proposal.json" if editing else None, lock_io=locked)
                summary = {}
                with self.subTest(editing=editing, locked=locked), \
                     patch.object(backend.subprocess, "run", side_effect=CommandCaptured) as run:
                    with self.assertRaises(CommandCaptured): backend.run_native(args, root, summary)
                    command = run.call_args.args[0]
                    self.assertEqual("--lock-io" in command, locked)
                    if editing:
                        self.assertEqual(command[1:5], ["source.v", "baseline.json", "proposal.json", str(root / "layout_candidate.json")])
                        self.assertEqual(summary["algorithm_parameters"]["io_coordinates_locked"], locked)

    def test_cli_rejects_locking_without_native_edit_pair_before_creating_outputs(self):
        invalid = [["pnr"], ["parse"], ["probe"],
                   ["parse", "--edit-baseline", "base", "--edit-proposal", "proposal"],
                   ["pnr", "--algorithm", "normal_2ddwave", "--edit-baseline", "base", "--edit-proposal", "proposal"]]
        with tempfile.TemporaryDirectory(prefix="fcn-invalid-pin-") as directory:
            for index, arguments in enumerate(invalid):
                out = Path(directory) / str(index)
                argv = ["ifcn_agent_backend.py", *arguments, "--output", str(out), "--lock-io"]
                with self.subTest(arguments=arguments), patch.object(sys, "argv", argv), redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as failure: backend.main()
                    self.assertEqual(failure.exception.code, 2)
                    self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
