#!/usr/bin/env python3
"""Build the FCNPilot manuscript; --figures regenerates plots from frozen evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

PAPER = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--figures", action="store_true", help="Regenerate figure data and all editable TikZ PDFs before the manuscript")
    args = parser.parse_args()
    env = dict(os.environ)
    if not shutil.which("latexmk"):
        for candidate in sorted(Path("/usr/local/texlive").glob("*/bin/x86_64-linux"), reverse=True):
            if (candidate / "latexmk").is_file():
                env["PATH"] = str(candidate) + os.pathsep + env.get("PATH", "")
                break
    if not shutil.which("latexmk", path=env.get("PATH")):
        parser.error("Install TeX Live with latexmk and the manuscript's LaTeX packages")
    build = PAPER / ".build"
    build.mkdir(exist_ok=True)

    def compile_tex(source, destination):
        destination.mkdir(parents=True, exist_ok=True)
        command = ["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", f"-outdir={destination}", source.name]
        result = subprocess.run(command, cwd=source.parent, env=env, text=True, capture_output=True)
        (destination / "build.log").write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(f"Compilation failed; see {destination / 'build.log'}")
        shutil.copyfile(destination / (source.stem + ".pdf"), source.with_suffix(".pdf"))
        print(source.with_suffix(".pdf"))

    if args.figures:
        for name in ["build_audit_figures_data.py", "generate_device_figures.py"]:
            subprocess.run([sys.executable, str(PAPER / "scripts" / name)], check=True, cwd=PAPER, env=env)
        for source in sorted((PAPER / "figures").glob("fig*.tex")):
            compile_tex(source, build / "figures" / source.stem)
        # Refresh hashes in derived-data sidecars after the PDF compilation.
        subprocess.run([sys.executable, str(PAPER / "scripts/build_audit_figures_data.py")], check=True, cwd=PAPER, env=env)
    # Only regenerated paper assets receive new hashes. Frozen source digests remain unchanged.
    def refresh_generated(value):
        if isinstance(value, list):
            for item in value:
                refresh_generated(item)
        elif isinstance(value, dict):
            if "path" in value and "sha256" in value:
                recorded = str(value["path"])
                relative = recorded.split("/paper-pi-ifcn/", 1)[1] if "/paper-pi-ifcn/" in recorded else recorded
                if relative.startswith(("figures/", "data/")):
                    current = PAPER / relative
                    if current.is_file():
                        value["path"] = relative
                        value["sha256"] = hashlib.sha256(current.read_bytes()).hexdigest()
            for item in value.values():
                refresh_generated(item)
    for sidecar in (PAPER / "figures").glob("*.evidence.json"):
        value = json.loads(sidecar.read_text())
        refresh_generated(value)
        sidecar.write_text(json.dumps(value, indent=2) + "\n")
    for name in ["main.tex", "supplementary.tex"]:
        compile_tex(PAPER / name, build / Path(name).stem)


if __name__ == "__main__":
    main()
