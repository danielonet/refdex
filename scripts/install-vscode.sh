#!/usr/bin/env bash
# Builds the VS Code extension and installs it locally, so you can test it as a real installed
# extension (not just via the F5 "Extension Development Host"):
#
#   packages/vscode -> refdex.vsix, installed with `code --install-extension`
#
# Usage:
#   scripts/install-vscode.sh
#
# Afterwards: reload VS Code (Cmd/Ctrl+Shift+P -> "Developer: Reload Window").
# To remove it again: scripts/uninstall.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/packages/vscode"
# shellcheck source=lib/node.sh
source "$ROOT_DIR/scripts/lib/node.sh"
cd "$ROOT_DIR"

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "!! Unknown option: $1 (see --help)" >&2; exit 2 ;;
esac

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
  echo "!! No 'code' CLI on PATH. Install manually: Extensions view -> ... -> 'Install from VSIX...' -> $VSIX_PATH" >&2
  exit 1
fi

# 5. Install (force overwrites any previously installed version).
echo "==> Installing with '$CODE_BIN --install-extension'..."
"$CODE_BIN" --install-extension "$VSIX_PATH" --force

echo
echo "Done: installed $VSIX_PATH with $CODE_BIN. Reload the VS Code window to use it."
