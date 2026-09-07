#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/environment.sh"
require_node
use_engine
if [[ ! -f "$FCNPILOT_ROOT/apps/web/node_modules/next/package.json" || ! -x "$IFCN_ROOT/build/ifcn_combinational_pnr" ]]; then
  printf 'Dependencies or engine binaries are missing. Run ./setup.sh first.\n' >&2
  exit 1
fi
python3 "$FCNPILOT_ROOT/integrations/pi/install.py"
export PI_WEB_CONFIG_DIR="${PI_WEB_CONFIG_DIR:-$FCNPILOT_ROOT/.local/web}"
export PI_WEB_NEXT_DIST_DIR=".next-fcnpilot"
export PI_WEB_PORT="${PI_WEB_PORT:-30211}"
cd "$FCNPILOT_ROOT/apps/web"
printf '\nFCNPilot: http://127.0.0.1:%s\n' "$PI_WEB_PORT"
printf 'Engine: %s\nPress Ctrl+C to stop.\n\n' "$IFCN_ROOT"
exec node bin/pi-web-launch.js dev --webpack -H 127.0.0.1 --port "$PI_WEB_PORT"
