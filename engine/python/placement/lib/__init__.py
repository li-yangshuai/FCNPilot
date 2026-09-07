"""Load the native parser/router built in the engine build directory."""
import importlib
import os
from pathlib import Path
import sys

_engine = Path(__file__).resolve().parents[3]
_build = Path(os.environ.get("IFCN_BUILD_DIR", str(_engine / "build"))).resolve()
sys.path.insert(0, str(_build / "python"))
iFCN_Lab = importlib.import_module("iFCN_Lab")
