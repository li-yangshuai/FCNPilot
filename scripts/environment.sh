#!/usr/bin/env bash
# Shared local runtime discovery; never points into either original repository.
FCNPILOT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

require_node() {
  if ! command -v node >/dev/null 2>&1 || ! node -e 'const [m,n]=process.versions.node.split(".").map(Number);process.exit(m>22 || (m===22 && n>=19) ? 0 : 1)' >/dev/null 2>&1; then
    if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
      source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
      nvm use 22 >/dev/null
    fi
  fi
  if ! command -v node >/dev/null 2>&1; then
    printf 'Install Node.js 22.19 or newer, then retry.\n' >&2
    return 1
  fi
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error("Node.js 22.19 or newer is required."); process.exit(1); }'
}

use_engine() {
  export IFCN_ROOT="$FCNPILOT_ROOT/engine"
  if [[ -x "$IFCN_ROOT/.venv/bin/python" ]]; then
    export PATH="$IFCN_ROOT/.venv/bin:$PATH"
  fi
}
