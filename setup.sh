#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/environment.sh"
require_node
cd "$FCNPILOT_ROOT"
for command in python3 cmake c++ pkg-config dot; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing %s. Install the Ubuntu packages listed in README.md.\n' "$command" >&2
    exit 1
  fi
done
if ! command -v yosys >/dev/null 2>&1 && [[ ! -x "${IFCN_YOSYS:-$FCNPILOT_ROOT/engine/build/tools/yosys-local/usr/bin/yosys}" ]]; then
  printf 'Missing Yosys for sequential RTL. Install yosys or set IFCN_YOSYS to its executable.\n' >&2
  exit 1
fi
python3 -m venv engine/.venv
engine/.venv/bin/python -m pip install -r engine/requirements.txt
cmake -S engine -B engine/build -DCMAKE_BUILD_TYPE=Release \
  -DPython3_EXECUTABLE="$FCNPILOT_ROOT/engine/.venv/bin/python"
cmake --build engine/build --parallel "${FCNPILOT_BUILD_JOBS:-2}"
(cd apps/web && npm ci --include=dev)
python3 integrations/pi/install.py
printf '\nFCNPilot is ready. Start the workspace with ./start.sh\n'
