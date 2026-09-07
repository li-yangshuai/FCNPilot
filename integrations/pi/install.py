#!/usr/bin/env python3
"""Install FCNPilot's main-agent profile and tools using relocatable engine paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]


def install(project: Path, engine: Path | None = None) -> dict:
    project = project.resolve()
    engine = (engine or REPOSITORY / "engine").resolve()
    if not project.is_dir():
        raise ValueError(f"Project directory does not exist: {project}")
    if not (engine / "scripts/ifcn_agent.py").is_file():
        raise ValueError(f"No iFCN engine at: {engine}")
    extension = project / ".pi/extensions/ifcn"
    files = {
        project / ".pi/agents/ifcn.md": (HERE / "agent.md").read_bytes(),
        extension / "index.ts": (HERE / "extension.ts").read_bytes(),
        extension / "ifcn-config.json": (json.dumps({
            "root": os.path.relpath(engine, extension),
        }, indent=2) + "\n").encode(),
    }
    receipt_path = project / ".pi/ifcn-install.json"
    prior = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    # Validate every destination before any write; preserve user-edited profiles.
    for target, content in files.items():
        if target.exists() and target.read_bytes() != content:
            expected = prior.get(str(target.relative_to(project)))
            actual = hashlib.sha256(target.read_bytes()).hexdigest()
            if expected != actual:
                raise ValueError(f"Preserving user-modified file: {target}")
    receipt = {}
    for target, content in files.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_bytes() != content:
            target.write_bytes(content)
        receipt[str(target.relative_to(project))] = hashlib.sha256(content).hexdigest()
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return {"project": str(project), "engine": str(engine), "main_agent": "ifcn"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("projects", nargs="*", type=Path)
    parser.add_argument("--engine", type=Path)
    args = parser.parse_args()
    destinations = args.projects or [REPOSITORY, REPOSITORY / "engine", REPOSITORY / "apps/web"]
    print(json.dumps([install(project, args.engine) for project in destinations], indent=2))
