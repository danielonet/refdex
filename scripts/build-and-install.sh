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
# INTELLIJ_BUILD_ARGS passes options to scripts/build-intellij.sh, e.g.
#   INTELLIJ_BUILD_ARGS=--test scripts/build-and-install.sh intellij
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

# shellcheck source=lib/node.sh
source "$ROOT_DIR/scripts/lib/node.sh"


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

  # 1. Build the plugin zip (and the daemon it bundles) -> plugins/intellij/build/distributions/.
  if [ ! -x "$INTELLIJ_DIR/gradlew" ]; then
    skip_or_fail intellij "plugins/intellij has no gradlew wrapper"
    return
  fi
  if ! (scripts/build-intellij.sh ${INTELLIJ_BUILD_ARGS:-}); then
    skip_or_fail intellij "scripts/build-intellij.sh failed (see above)"
    return
  fi
  # The zip of the version in gradle.properties (older builds stay in the same folder).
  local version zip
  version="$(awk -F' *= *' '$1 == "pluginVersion" { print $2 }' "$INTELLIJ_DIR/gradle.properties")"
  zip="$(ls "$INTELLIJ_DIR"/build/distributions/*-"$version".zip)"

  # 2. Unpack into the plugin folder of every JetBrains IDE the plugin supports, replacing an
  #    older copy (including one installed with "Install Plugin from Disk...").
  if ! command -v unzip >/dev/null 2>&1; then
    skip_or_fail intellij "'unzip' is not installed. Install manually: Settings -> Plugins -> gear -> 'Install Plugin from Disk...' -> $zip"
    return
  fi
  # The zip holds one top-level folder named after the plugin.
  local plugin_folder
  # (awk reads the whole listing; `head` would end the pipe early and trip pipefail.)
  plugin_folder="$(unzip -Z1 "$zip" | awk -F/ 'NR == 1 { print $1 }')"
  # Oldest supported IDE as a build number, e.g. 253 for 2025.3.
  local since
  since="$(awk -F' *= *' '$1 == "pluginSinceBuild" { print $2 }' "$INTELLIJ_DIR/gradle.properties")"
  local installed=() dir name build
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    # "IntelliJIdea2026.2" (or ".../IntelliJIdea2026.2/plugins" on macOS/Windows) -> build 262.
    name="$(basename "${dir%/plugins}")"
    build="$(echo "$name" | sed -E 's/^[A-Za-z]+([0-9]{2})([0-9]{2})\.([0-9]+)$/\2\3/')"
    if [ "$build" -lt "$since" ]; then
      echo "--> Skipping $name: RefDex needs $since (2025.3) or later"
      continue
    fi
    mkdir -p "$dir"
    rm -rf "${dir:?}/$plugin_folder"
    unzip -q -o "$zip" -d "$dir"
    # The daemon must be executable, or RefDex can't index anything.
    local exe
    for exe in "$dir/$plugin_folder"/daemon/*/refdex; do
      [ -e "$exe" ] && chmod +x "$exe"
    done
    echo "==> Installed $version into $dir/$plugin_folder"
    installed+=("$name")
  done < <(jetbrains_plugin_dirs)

  if [ "${#installed[@]}" -eq 0 ]; then
    skip_or_fail intellij "no JetBrains IDE $since (2025.3) or later found for this user (start one once, or install manually: Settings -> Plugins -> gear -> 'Install Plugin from Disk...' -> $zip)"
    return
  fi
  # An IDE loads plugins only at startup.
  # (The native launcher runs as bin/idea, a script-started IDE as com.intellij.idea.Main.)
  if pgrep -f '/bin/(idea|pycharm|webstorm|rider|clion|goland|phpstorm|rubymine)(\.sh)?( |$)|com\.intellij\.idea\.Main' >/dev/null 2>&1; then
    echo "==> A JetBrains IDE is running: restart it (File -> Exit, then open it again) to load RefDex $version"
  fi
  RESULTS+=("intellij: installed RefDex $version into ${installed[*]} (restart the IDE)")
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
