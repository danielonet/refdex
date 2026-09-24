#!/usr/bin/env bash
# Builds RefDex's IDE plugins and installs them locally, so you can test them as real installed
# plugins (not just via the F5 "Extension Development Host" or Gradle's runIde):
#
#   - VS Code:  packages/vscode  -> refdex.vsix, installed with `code --install-extension`
#   - IntelliJ: plugins/intellij -> a plugin .zip (Gradle `buildPlugin`), unpacked into the plugins
#               folder of every JetBrains IDE found for your user (IntelliJ IDEA, PyCharm, Rider,
#               WebStorm, ...), which is what "Install Plugin from Disk..." does
#
# Usage:
#   scripts/build-and-install.sh [all|vscode|intellij]     (default: all)
#
# With "all", a target that cannot be built here (no VS Code CLI, no IntelliJ plugin project yet,
# no JDK, no JetBrains IDE) is skipped with a message; naming a single target makes that an error.
#
# Afterwards: reload VS Code (Cmd/Ctrl+Shift+P -> "Developer: Reload Window") and restart any
# JetBrains IDE that was open.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/packages/vscode"
INTELLIJ_DIR="$ROOT_DIR/plugins/intellij"
cd "$ROOT_DIR"

TARGET="${1:-all}"
case "$TARGET" in
  all|vscode|intellij) ;;
  -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "!! Unknown target: $TARGET (expected all, vscode or intellij)" >&2; exit 2 ;;
esac

echo "==> Working in $ROOT_DIR"

RESULTS=()

# A target that cannot be built here: fatal when it was asked for by name, skipped with "all".
skip_or_fail() {
  local target="$1" reason="$2"
  if [ "$TARGET" = "$target" ]; then
    echo "!! $reason" >&2
    exit 1
  fi
  echo "--> Skipping $target: $reason"
  RESULTS+=("$target: skipped ($reason)")
}

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
    echo "   and run: nvm install $(cat "$ROOT_DIR/.nvmrc")" >&2
    echo "   then re-run this script." >&2
    exit 1
  fi
}


# ---------------------------------------------------------------------------------------------
# VS Code
# ---------------------------------------------------------------------------------------------
install_vscode() {
  echo
  echo "==> VS Code extension"
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
  local vsix_path="$ROOT_DIR/refdex.vsix"
  (cd "$EXT_DIR" && npx --yes @vscode/vsce package \
    --no-dependencies \
    --allow-missing-repository \
    --skip-license \
    --out "$vsix_path")
  echo "==> Packaged $vsix_path"

  # 4. Find a VS Code CLI to install into.
  local code_bin=""
  for candidate in code code-insiders codium; do
    if command -v "$candidate" >/dev/null 2>&1; then
      code_bin="$candidate"
      break
    fi
  done
  if [ -z "$code_bin" ]; then
    skip_or_fail vscode "no 'code' CLI on PATH. Install manually: Extensions view -> ... -> 'Install from VSIX...' -> $vsix_path"
    return
  fi

  # 5. Install (force overwrites any previously installed version).
  echo "==> Installing with '$code_bin --install-extension'..."
  "$code_bin" --install-extension "$vsix_path" --force
  RESULTS+=("vscode: installed $vsix_path with $code_bin (reload the window)")
}

# ---------------------------------------------------------------------------------------------
# IntelliJ (and other JetBrains IDEs)
# ---------------------------------------------------------------------------------------------

# Per-user folders JetBrains IDEs load plugins from, one per installed IDE version, e.g.
# ~/.local/share/JetBrains/IntelliJIdea2025.2 (Linux) or
# ~/Library/Application Support/JetBrains/PyCharm2025.2/plugins (macOS).
# Found through the IDE's config folder, which every IDE creates on first start.
jetbrains_plugin_dirs() {
  local config_root data_root suffix=""
  case "$(uname -s)" in
    Darwin)
      config_root="$HOME/Library/Application Support/JetBrains"
      data_root="$config_root"
      suffix="/plugins"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      config_root="${APPDATA:-$HOME/AppData/Roaming}/JetBrains"
      data_root="$config_root"
      suffix="/plugins"
      ;;
    *)
      config_root="${XDG_CONFIG_HOME:-$HOME/.config}/JetBrains"
      data_root="${XDG_DATA_HOME:-$HOME/.local/share}/JetBrains"
      ;;
  esac
  [ -d "$config_root" ] || return 0
  local dir name
  for dir in "$config_root"/*/; do
    name="$(basename "$dir")"
    # IDE folders are "<Product><year>.<n>", e.g. IdeaIC2025.2, PyCharmCE2025.1, Rider2025.2.
    [[ "$name" =~ ^[A-Za-z]+[0-9]{4}\.[0-9]+$ ]] || continue
    echo "$data_root/$name$suffix"
  done
}

install_intellij() {
  echo
  echo "==> IntelliJ plugin"

  # 1. The plugin project (Phase 6 of the plan). Until it is scaffolded there is nothing to build.
  local gradle=""
  if [ -x "$INTELLIJ_DIR/gradlew" ]; then
    gradle="./gradlew"
  elif [ -f "$INTELLIJ_DIR/build.gradle.kts" ] || [ -f "$INTELLIJ_DIR/build.gradle" ]; then
    command -v gradle >/dev/null 2>&1 && gradle="gradle"
  else
    skip_or_fail intellij "no Gradle project in plugins/intellij yet (the IntelliJ plugin is Phase 6 of the plan)"
    return
  fi
  if [ -z "$gradle" ]; then
    skip_or_fail intellij "plugins/intellij has no gradlew wrapper and 'gradle' is not on PATH"
    return
  fi

  # 2. The IntelliJ Platform Gradle plugin needs a JDK (17 or newer).
  if ! command -v java >/dev/null 2>&1 && [ -z "${JAVA_HOME:-}" ]; then
    skip_or_fail intellij "no JDK found (install JDK 17+ or set JAVA_HOME)"
    return
  fi

  # 3. The plugin bundles the RefDex daemon, so the daemon bundle must be current.
  ensure_node
  if [ ! -d node_modules ]; then
    echo "==> Installing npm dependencies..."
    npm install
  fi
  echo "==> Building the daemon bundle..."
  npm run build -w @refdex/server

  # 4. Build the plugin zip -> plugins/intellij/build/distributions/<name>-<version>.zip.
  echo "==> Building plugin with '$gradle buildPlugin'..."
  (cd "$INTELLIJ_DIR" && $gradle buildPlugin)
  local zip
  zip="$(ls -t "$INTELLIJ_DIR"/build/distributions/*.zip 2>/dev/null | awk 'NR == 1' || true)"
  if [ -z "$zip" ]; then
    echo "!! buildPlugin produced no zip in plugins/intellij/build/distributions" >&2
    exit 1
  fi
  echo "==> Built $zip"

  # 5. Unpack into every JetBrains IDE's plugin folder, replacing an older copy.
  if ! command -v unzip >/dev/null 2>&1; then
    skip_or_fail intellij "'unzip' is not installed. Install manually: Settings -> Plugins -> gear -> 'Install Plugin from Disk...' -> $zip"
    return
  fi
  # The zip holds one top-level folder named after the plugin.
  local plugin_folder
  # (awk reads the whole listing; `head` would end the pipe early and trip pipefail.)
  plugin_folder="$(unzip -Z1 "$zip" | awk -F/ 'NR == 1 { print $1 }')"
  local installed=0 dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    mkdir -p "$dir"
    rm -rf "${dir:?}/$plugin_folder"
    unzip -q -o "$zip" -d "$dir"
    echo "==> Installed into $dir/$plugin_folder"
    installed=$((installed + 1))
  done < <(jetbrains_plugin_dirs)

  if [ "$installed" -eq 0 ]; then
    skip_or_fail intellij "no JetBrains IDE found for this user (start one once, or install manually: Settings -> Plugins -> gear -> 'Install Plugin from Disk...' -> $zip)"
    return
  fi
  RESULTS+=("intellij: installed $plugin_folder into $installed IDE(s) (restart them)")
}

# ---------------------------------------------------------------------------------------------

if [ "$TARGET" = "all" ] || [ "$TARGET" = "vscode" ]; then
  install_vscode
fi
if [ "$TARGET" = "all" ] || [ "$TARGET" = "intellij" ]; then
  install_intellij
fi

echo
echo "Done."
for line in "${RESULTS[@]}"; do
  echo "  - $line"
done
