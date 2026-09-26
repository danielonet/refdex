#!/usr/bin/env bash
# Builds the IntelliJ plugin and installs it locally, so you can test it as a real installed
# plugin (not just via Gradle's runIde):
#
#   plugins/intellij -> a plugin .zip (scripts/build-intellij.sh), unpacked into the plugins folder
#                       of every JetBrains IDE 2025.3+ found for your user (IntelliJ IDEA, PyCharm,
#                       Rider, WebStorm, ...), which is what "Install Plugin from Disk..." does
#
# Usage:
#   scripts/install-intellij.sh [--test] [--skip-daemon]
#
# Options are passed to scripts/build-intellij.sh (--test runs the plugin's tests first).
#
# Afterwards: restart any JetBrains IDE that was open; IDEs load plugins only at startup.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTELLIJ_DIR="$ROOT_DIR/plugins/intellij"
cd "$ROOT_DIR"

case "${1:-}" in
  -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# Per-user folders JetBrains IDEs load plugins from, one per installed IDE version, e.g.
# ~/.local/share/JetBrains/IntelliJIdea2026.2 (Linux) or
# ~/Library/Application Support/JetBrains/PyCharm2025.3/plugins (macOS).
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
    # IDE folders are "<Product><year>.<n>", e.g. IntelliJIdea2026.2, PyCharm2025.3, Rider2025.3.
    [[ "$name" =~ ^[A-Za-z]+[0-9]{4}\.[0-9]+$ ]] || continue
    echo "$data_root/$name$suffix"
  done
}

# 1. Build the plugin zip (and the daemon it bundles) -> plugins/intellij/build/distributions/.
scripts/build-intellij.sh "$@"

# The zip of the version in gradle.properties (older builds stay in the same folder).
VERSION="$(awk -F' *= *' '$1 == "pluginVersion" { print $2 }' "$INTELLIJ_DIR/gradle.properties")"
ZIP="$(ls "$INTELLIJ_DIR"/build/distributions/*-"$VERSION".zip)"
MANUAL="Install manually: Settings -> Plugins -> gear -> 'Install Plugin from Disk...' -> $ZIP"

# 2. Unpack into the plugin folder of every JetBrains IDE the plugin supports, replacing an
#    older copy (including one installed with "Install Plugin from Disk...").
if ! command -v unzip >/dev/null 2>&1; then
  echo "!! 'unzip' is not installed. $MANUAL" >&2
  exit 1
fi
# The zip holds one top-level folder named after the plugin.
# (awk reads the whole listing; `head` would end the pipe early and trip pipefail.)
PLUGIN_FOLDER="$(unzip -Z1 "$ZIP" | awk -F/ 'NR == 1 { print $1 }')"
# Oldest supported IDE as a build number, e.g. 253 for 2025.3.
SINCE="$(awk -F' *= *' '$1 == "pluginSinceBuild" { print $2 }' "$INTELLIJ_DIR/gradle.properties")"
INSTALLED=()
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  # "IntelliJIdea2026.2" (or ".../IntelliJIdea2026.2/plugins" on macOS/Windows) -> build 262.
  name="$(basename "${dir%/plugins}")"
  build="$(echo "$name" | sed -E 's/^[A-Za-z]+([0-9]{2})([0-9]{2})\.([0-9]+)$/\2\3/')"
  if [ "$build" -lt "$SINCE" ]; then
    echo "--> Skipping $name: RefDex needs $SINCE (2025.3) or later"
    continue
  fi
  mkdir -p "$dir"
  rm -rf "${dir:?}/$PLUGIN_FOLDER"
  unzip -q -o "$ZIP" -d "$dir"
  # The daemon must be executable, or RefDex can't index anything.
  for exe in "$dir/$PLUGIN_FOLDER"/daemon/*/refdex; do
    [ -e "$exe" ] && chmod +x "$exe"
  done
  echo "==> Installed $VERSION into $dir/$PLUGIN_FOLDER"
  INSTALLED+=("$name")
done < <(jetbrains_plugin_dirs)

if [ "${#INSTALLED[@]}" -eq 0 ]; then
  echo "!! No JetBrains IDE $SINCE (2025.3) or later found for this user (start one once first). $MANUAL" >&2
  exit 1
fi

echo
echo "Done: installed RefDex $VERSION into ${INSTALLED[*]}."
# An IDE loads plugins only at startup.
# (The native launcher runs as bin/idea, a script-started IDE as com.intellij.idea.Main.)
if pgrep -f '/bin/(idea|pycharm|webstorm|rider|clion|goland|phpstorm|rubymine)(\.sh)?( |$)|com\.intellij\.idea\.Main' >/dev/null 2>&1; then
  echo "A JetBrains IDE is running: restart it (File -> Exit, then open it again) to load RefDex $VERSION."
else
  echo "Start the IDE to use it."
fi
