"""Resolve historical iFCN evidence paths inside the curated FCNPilot archive."""
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
ENGINE = REPOSITORY / "engine"
ARCHIVE = REPOSITORY / "experiments/archive"
COHORTS = {
    "backend-comparison-20260905T103536Z": "backend",
    "agent-comparison-2026-09-05T10-29-05-410Z": "pilot",
    "release-logic-io-20260905T110234Z": "production/release-logic-io-20260905T110234Z",
    "release-logic-io-20260905T110907Z": "production/release-logic-io-20260905T110907Z",
}


def recorded_path(value):
    """Keep receipts unchanged; resolve only their known source/archive prefixes."""
    path = Path(value)
    text = path.as_posix()
    marker = "/output/pi-validation/"
    if marker in text:
        relative = text.split(marker, 1)[1]
        parts = Path(relative).parts
        if ".." in parts:
            raise ValueError("Recorded evidence path escapes its archive")
        if parts[0] in COHORTS:
            return ARCHIVE / COHORTS[parts[0]] / Path(*parts[1:])
        if relative in {"routed-logic-audit-final.json", "qca-output-count-diagnostic.json"}:
            return ARCHIVE / "backend" / relative
        raise FileNotFoundError("Historical evidence was not included: " + relative)
    marker = "/tests/benchmarks_pi/"
    if marker in text:
        relative = text.split(marker, 1)[1]
        if ".." in Path(relative).parts:
            raise ValueError("Recorded benchmark path escapes its corpus")
        return ENGINE / "tests/benchmarks_pi" / relative
    return path
