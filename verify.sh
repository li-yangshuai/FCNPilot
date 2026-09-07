#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/environment.sh"
require_node
use_engine
cd "$FCNPILOT_ROOT"
python3 integrations/pi/install.py
python3 -m unittest discover -s integrations/pi -p 'test_*.py'
ctest --test-dir engine/build --output-on-failure
(cd apps/web && npm run typecheck)
(cd apps/web && node --test lib/custom-agent-files.test.mjs lib/new-session-agent.test.mjs \
  lib/session-agent-profile.test.mjs lib/rpc-manager-tools.test.mjs lib/ifcn-workspace.test.mjs)
# Real local tools, both simulation models and standard energy; no LLM API call.
node integrations/pi/smoke.mjs
