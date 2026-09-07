import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


class InstallationTests(unittest.TestCase):
    def test_relocation_and_local_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repository"
            source = Path(__file__).resolve().parent
            shutil.copytree(source, root / "integrations/pi", ignore=shutil.ignore_patterns("__pycache__"))
            (root / "engine/scripts").mkdir(parents=True)
            (root / "engine/scripts/ifcn_agent.py").write_text("# fixture\n")
            (root / "apps/web").mkdir(parents=True)
            spec = importlib.util.spec_from_file_location("fixture_install", root / "integrations/pi/install.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.install(root / "apps/web")
            module.install(root / "engine")
            # A clone may be moved without rewriting its generated registration.
            relocated = Path(temporary) / "moved"
            root.rename(relocated)
            for project in [relocated / "apps/web", relocated / "engine"]:
                config = project / ".pi/extensions/ifcn/ifcn-config.json"
                value = json.loads(config.read_text())["root"]
                self.assertFalse(Path(value).is_absolute())
                self.assertEqual((config.parent / value).resolve(), relocated / "engine")
            # A subsequent install must not replace an edited main-agent prompt.
            spec = importlib.util.spec_from_file_location("moved_install", relocated / "integrations/pi/install.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            project = relocated / "apps/web"
            module.install(project)
            profile = project / ".pi/agents/ifcn.md"
            profile.write_text(profile.read_text() + "\nUser instruction.\n")
            with self.assertRaisesRegex(ValueError, "Preserving user-modified"):
                module.install(project)
            self.assertTrue(profile.read_text().endswith("User instruction.\n"))


if __name__ == "__main__":
    unittest.main()
