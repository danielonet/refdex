# Shared by the build scripts: `source scripts/lib/node.sh`, then call ensure_node.
#
# Node must be new enough for this repo (TypeScript runs through Node's type stripping, which
# needs 22.18+; @vscode/vsce needs 20+). If the shell resolved an older Node (a fresh terminal
# that hasn't sourced nvm, or a non-interactive runner), try nvm with the repo's .nvmrc.
REQUIRED_NODE="22.18"

node_is_new_enough() {
  command -v node >/dev/null 2>&1 &&
    node -e '
      const [maj, min] = process.versions.node.split(".").map(Number);
      const [rmaj, rmin] = process.argv[1].split(".").map(Number);
      process.exit(maj > rmaj || (maj === rmaj && min >= rmin) ? 0 : 1);
    ' "$REQUIRED_NODE"
}

ensure_node() {
  node_is_new_enough && return 0
  echo "==> Node $(node -v 2>/dev/null || echo 'not found') is too old (needs >= $REQUIRED_NODE); looking for nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh"
    # .nvmrc at the repo root pins the major version.
    nvm install >/dev/null
    nvm use >/dev/null
    echo "==> Switched to Node $(node -v) via nvm"
  fi
  if ! node_is_new_enough; then
    echo "!! Still on Node $(node -v 2>/dev/null || echo 'not found'). Install nvm (https://github.com/nvm-sh/nvm)" >&2
    echo "   and run: nvm install $(cat "$(dirname "${BASH_SOURCE[0]}")/../../.nvmrc")" >&2
    echo "   then re-run this script." >&2
    exit 1
  fi
}
