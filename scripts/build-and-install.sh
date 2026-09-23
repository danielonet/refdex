#!/usr/bin/env bash
# Builds the RefDex VS Code extension (packages/vscode) into a .vsix and installs it into your
# local VS Code, so you can test it as a real installed extension (not just via the F5
# "Extension Development Host").
#
# Usage:
#   scripts/build-and-install.sh
#
# After it finishes, reload/restart VS Code (Cmd/Ctrl+Shift+P ->
# "Developer: Reload Window") to pick up the newly installed extension.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/packages/vscode"
cd "$ROOT_DIR"

echo "==> Working in $ROOT_DIR"

# 0. Node must be new enough for this repo (TypeScript runs through Node's type stripping, which
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
    echo "   and run: nvm install $(cat "$ROOT_DIR/.nvmrc")" >&2
    echo "   then re-run this script." >&2
    exit 1
  fi
}

ensure_node

# 1. Install workspace dependencies if needed (hoisted to the repo root).
if [ ! -d node_modules ]; then
  echo "==> Installing npm dependencies..."
  npm install
fi

# 2. Typecheck, lint and bundle the extension -> packages/vscode/dist/.
echo "==> Compiling..."
npm run compile -w refdex

# 3. Package the extension into a .vsix using @vscode/vsce.
#    --no-dependencies: the extension is bundled by esbuild, and npm workspaces hoist
#    node_modules to the root, which vsce's dependency scan does not understand.
#    --allow-missing-repository / --skip-license: this is a local dev package, not a
#    marketplace publish, so we don't need those.
echo "==> Packaging extension..."
VSIX_PATH="$ROOT_DIR/refdex.vsix"
(cd "$EXT_DIR" && npx --yes @vscode/vsce package \
  --no-dependencies \
  --allow-missing-repository \
  --skip-license \
  --out "$VSIX_PATH")

echo "==> Packaged $VSIX_PATH"

# 4. Find a VS Code CLI to install into.
CODE_BIN=""
for candidate in code code-insiders codium; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CODE_BIN="$candidate"
    break
  fi
done

if [ -z "$CODE_BIN" ]; then
  echo "!! Could not find a 'code' CLI on PATH."
  echo "   Install the extension manually from VS Code:"
  echo "   Extensions view -> ... menu -> 'Install from VSIX...' -> $VSIX_PATH"
  exit 1
fi

# 5. Install (force overwrites any previously installed version).
echo "==> Installing with '$CODE_BIN --install-extension'..."
"$CODE_BIN" --install-extension "$VSIX_PATH" --force

echo
echo "Done. Reload VS Code (Cmd/Ctrl+Shift+P -> 'Developer: Reload Window')"
echo "or restart it to start using the installed RefDex extension."
