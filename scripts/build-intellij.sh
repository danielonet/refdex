#!/usr/bin/env bash
# Builds the IntelliJ plugin zip: plugins/intellij/build/distributions/refdex-intellij-<version>.zip.
# Gradle builds the daemon it bundles first (npm run build:sea: refdex.cjs plus this platform's
# single executable); see plugins/intellij/README.md.
#
# Usage:
#   scripts/build-intellij.sh [--test] [--verify] [--skip-daemon]
#
#   --test         run the plugin's tests first (unit tests, and the real daemon on a fixture)
#   --verify       run the IntelliJ Plugin Verifier afterwards (downloads the IDEs it checks against)
#   --skip-daemon  don't rebuild the daemon; bundle whatever packages/server/dist holds
#
# Needs JDK 21+ (JAVA_HOME, `java` on PATH, or ~/.local/jdk) and Node 22.18+. The Gradle wrapper
# downloads Gradle and the IntelliJ Platform SDK (~1.5 GB) on the first run.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTELLIJ_DIR="$ROOT_DIR/plugins/intellij"
# shellcheck source=lib/node.sh
source "$ROOT_DIR/scripts/lib/node.sh"
cd "$ROOT_DIR"

TASKS=()
GRADLE_ARGS=()
VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --test) TASKS+=(test) ;;
    --verify) VERIFY=1 ;;
    --skip-daemon) GRADLE_ARGS+=(-PskipDaemonBuild) ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
TASKS+=(buildPlugin)
[ "$VERIFY" -eq 1 ] && TASKS+=(verifyPlugin)

# The Java major version of a `java` binary, e.g. 21; empty if it doesn't run.
java_major() {
  "$1" -version 2>&1 | awk -F'"' '/version/ { split($2, v, "."); print (v[1] == "1" ? v[2] : v[1]); exit }'
}

# The IntelliJ Platform Gradle plugin needs JDK 21 for IntelliJ 2025.3.
ensure_jdk() {
  local candidate
  for candidate in "${JAVA_HOME:-}" "$(dirname "$(dirname "$(readlink -f "$(command -v java 2>/dev/null || echo /nonexistent)")")")" "$HOME/.local/jdk"; do
    [ -n "$candidate" ] && [ -x "$candidate/bin/java" ] || continue
    if [ "$(java_major "$candidate/bin/java")" -ge 21 ] 2>/dev/null; then
      export JAVA_HOME="$candidate"
      echo "==> Using JDK $(java_major "$JAVA_HOME/bin/java") at $JAVA_HOME"
      return 0
    fi
  done
  echo "!! No JDK 21+ found. Install one (e.g. https://adoptium.net) and set JAVA_HOME, or unpack it to ~/.local/jdk." >&2
  exit 1
}

ensure_jdk
ensure_node
if [ ! -d node_modules ]; then
  echo "==> Installing npm dependencies..."
  npm install
fi

# One JVM: the Kotlin compiler runs inside Gradle instead of its own daemon, which keeps the
# build within reach of machines with little memory. --no-daemon ends Gradle when it is done.
echo "==> Running gradlew ${TASKS[*]}..."
(cd "$INTELLIJ_DIR" && ./gradlew --no-daemon -Pkotlin.compiler.execution.strategy=in-process "${GRADLE_ARGS[@]}" "${TASKS[@]}")

zip="$(ls -t "$INTELLIJ_DIR"/build/distributions/*.zip 2>/dev/null | awk 'NR == 1' || true)"
if [ -z "$zip" ]; then
  echo "!! buildPlugin produced no zip in plugins/intellij/build/distributions" >&2
  exit 1
fi
# Which daemon executables made it in; the other platforms fall back to Node on PATH.
platforms="$(unzip -Z1 "$zip" | awk -F/ '$2 == "daemon" && $3 ~ /-/ && $4 ~ /^refdex/ { print $3 }' | sort -u | paste -sd, - || true)"
echo
echo "Built $zip ($(du -h "$zip" | cut -f1))"
echo "  daemon executables: ${platforms:-none (every platform needs Node.js 22.13+ on PATH)}"
echo "  install: Settings -> Plugins -> gear -> 'Install Plugin from Disk...', or scripts/build-and-install.sh intellij"
