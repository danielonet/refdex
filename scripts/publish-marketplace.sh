#!/usr/bin/env bash
# Builds the RefDex VS Code extension (packages/vscode) into a .vsix and publishes it to the
# Visual Studio Marketplace (https://marketplace.visualstudio.com).
#
# Usage:
#   scripts/publish-marketplace.sh [patch|minor|major|<version>] [options]
#
# Positional argument (optional):
#   patch|minor|major   Bump packages/vscode/package.json's version accordingly before publishing.
#   <version>           Set packages/vscode/package.json's version to this exact semver before publishing.
#   (omitted)           Publish whatever version is already in packages/vscode/package.json, unchanged.
#
# A bump/version is applied with `npm version -w refdex`, which updates packages/vscode/package.json
# and the root package-lock.json. After a successful (non-dry-run) publish this script commits that
# change as "Release vX.Y.Z" and tags it "vX.Y.Z" locally - see "Done" output for the push command.
# If packaging or publishing fails, or you decline the prompt, the bump is reverted.
#
# Options:
#   --dry-run       Build and package only; do not publish, bump, commit or tag.
#   -y, --yes       Skip the confirmation prompt before publishing.
#   --skip-tests    Skip the extension's tests ("npm test -w refdex") before packaging.
#   --env-file PATH Read credentials from PATH instead of the default location.
#   -h, --help      Show this help.
#
# Safety checks
# -------------
# Before an actual (non-dry-run) publish, the script requires a clean git working
# tree (no uncommitted changes) so the published package - and any version bump's
# commit/tag - correspond to real, committed history.
#
# Credentials
# -----------
# The publisher id and the Marketplace personal access token (PAT) are never
# kept in this repository. They are read from a plain text file OUTSIDE the
# repo, by default:
#
#   ~/.config/refdex/marketplace.env
#
# (override with --env-file, or the REFDEX_MARKETPLACE_ENV_FILE environment
# variable). If that file does not exist yet, this script creates a template
# there (permissions 600) and stops so you can fill it in. Its contents:
#
#   VSCE_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#   # Optional - defaults to the "publisher" field in packages/vscode/package.json.
#   VSCE_PUBLISHER=danielonnet
#
# Get a PAT from https://dev.azure.com -> User settings -> Personal access
# tokens, scoped to "Marketplace (Manage)", for the org that owns the
# "danielonnet" publisher (see https://marketplace.visualstudio.com/manage).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/packages/vscode"
cd "$ROOT_DIR"

DRY_RUN=0
ASSUME_YES=0
SKIP_TESTS=0
BUMP=""
ENV_FILE="${REFDEX_MARKETPLACE_ENV_FILE:-$HOME/.config/refdex/marketplace.env}"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

print_usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --env-file)
      shift
      ENV_FILE="${1:-}"
      [ -n "$ENV_FILE" ] || { echo "!! --env-file requires a path" >&2; exit 2; }
      ;;
    -h|--help) print_usage; exit 0 ;;
    patch|minor|major)
      [ -z "$BUMP" ] || { echo "!! Only one version bump / version may be given" >&2; exit 2; }
      BUMP="$1"
      ;;
    -*) echo "Unknown option: $1" >&2; print_usage; exit 2 ;;
    *)
      if [[ "$1" =~ $SEMVER_RE ]]; then
        [ -z "$BUMP" ] || { echo "!! Only one version bump / version may be given" >&2; exit 2; }
        BUMP="$1"
      else
        echo "!! Not a valid bump keyword (patch|minor|major) or semver: $1" >&2
        print_usage
        exit 2
      fi
      ;;
  esac
  shift
done

echo "==> Working in $ROOT_DIR"

# 1. Require a clean git working tree before any real (non-dry-run) publish, so the
#    published package - and any version bump's commit/tag - correspond to a real commit.
if [ "$DRY_RUN" -ne 1 ]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "!! Not inside a git repository." >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "!! Working tree has uncommitted changes. Commit or stash them first (or use --dry-run):" >&2
    git status --short >&2
    exit 1
  fi
fi

# 2. Credentials: a plain text file outside the repo, never committed.
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  cat > "$ENV_FILE" <<'ENVEOF'
# Visual Studio Marketplace publishing credentials for RefDex.
# This file is NOT part of the git repository - keep it out of any repo,
# and do not share it. Permissions are already restricted to your user (600).

VSCE_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional - defaults to the "publisher" field in packages/vscode/package.json.
# VSCE_PUBLISHER=danielonnet
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "!! No credentials found. Created a template at: $ENV_FILE"
  echo "   Edit it with your real Marketplace PAT (and optionally VSCE_PUBLISHER), then re-run this script."
  exit 1
fi

# Reject group/world-readable credential files rather than silently using them.
FILE_PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '')"
if [ -n "$FILE_PERMS" ] && [ "${FILE_PERMS: -2}" != "00" ]; then
  echo "!! $ENV_FILE is readable by others (mode $FILE_PERMS). Run: chmod 600 \"$ENV_FILE\"" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [ -z "${VSCE_PAT:-}" ] || [ "$VSCE_PAT" = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ]; then
  echo "!! VSCE_PAT is not set in $ENV_FILE. Add your Marketplace personal access token there." >&2
  exit 1
fi

# 3. Node must be new enough for this repo (TypeScript runs through Node's type stripping, which
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

ext_field() { node -p "require('$EXT_DIR/package.json').$1"; }
PUBLISHER="${VSCE_PUBLISHER:-$(ext_field publisher)}"
VERSION="$(ext_field version)"
EXT_NAME="$(ext_field name)"

# 4. Install workspace dependencies if needed (hoisted to the repo root).
if [ ! -d node_modules ]; then
  echo "==> Installing npm dependencies..."
  npm install
fi

# 5. Compile + test before packaging anything that might get published.
echo "==> Compiling..."
npm run compile -w refdex

if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "==> Skipping tests (--skip-tests)."
else
  echo "==> Running tests..."
  npm test -w refdex
fi

# Packages the extension with @vscode/vsce. --no-dependencies: the extension is bundled by
# esbuild, and npm workspaces hoist node_modules to the root, which vsce's dependency scan
# does not understand. vsce runs the "vscode:prepublish" script (production build) first.
VSIX_PATH="$ROOT_DIR/refdex.vsix"
package_vsix() {
  echo "==> Packaging extension..."
  (cd "$EXT_DIR" && npx --yes @vscode/vsce package --no-dependencies --out "$VSIX_PATH")
  echo "==> Packaged $VSIX_PATH"
}

if [ "$DRY_RUN" -eq 1 ]; then
  package_vsix
  echo
  if [ -n "$BUMP" ]; then
    echo "Dry run: not bumping the version, committing, tagging, or publishing."
    echo "Package built at the current version ($VERSION) is at $VSIX_PATH"
  else
    echo "Dry run: not publishing. Package is at $VSIX_PATH"
  fi
  exit 0
fi

# 6. Apply the version bump, if any. The tree was clean in step 1, so on any failure or abort
#    before the publish succeeds, restoring the two files undoes the bump exactly.
PUBLISHED=0
if [ -n "$BUMP" ]; then
  OLD_VERSION="$VERSION"
  revert_bump() {
    if [ "$PUBLISHED" -ne 1 ]; then
      echo "==> Reverting version bump ($OLD_VERSION was not published as a new version)."
      git checkout -- packages/vscode/package.json package-lock.json
    fi
  }
  trap revert_bump EXIT
  echo "==> Bumping version ($BUMP)..."
  npm version "$BUMP" -w refdex --no-git-tag-version >/dev/null
  VERSION="$(ext_field version)"
fi

package_vsix

# 7. Confirm, then publish.
echo
echo "About to publish:"
echo "  Extension: $EXT_NAME"
echo "  Publisher: $PUBLISHER"
if [ -n "$BUMP" ]; then
  echo "  Version:   $OLD_VERSION -> $VERSION (bumped by '$BUMP'; committed and tagged locally after publishing, not pushed)"
else
  echo "  Version:   $VERSION"
fi
echo "  Package:   $VSIX_PATH"
echo "  Target:    https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.$EXT_NAME"
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Publish this version to the Marketplace? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

echo "==> Publishing with vsce..."
(cd "$EXT_DIR" && npx --yes @vscode/vsce publish --packagePath "$VSIX_PATH" --pat "$VSCE_PAT")
PUBLISHED=1

if [ -n "$BUMP" ]; then
  echo "==> Committing and tagging v$VERSION..."
  git add packages/vscode/package.json package-lock.json
  git commit -m "Release v$VERSION"
  git tag "v$VERSION"
fi

echo
echo "Done. Published $EXT_NAME v$VERSION as $PUBLISHER."
echo "  https://marketplace.visualstudio.com/items?itemName=$PUBLISHER.$EXT_NAME"
echo
if [ -n "$BUMP" ]; then
  echo "Committed and tagged v$VERSION locally. Push them:"
  echo "  git push && git push origin v$VERSION"
else
  echo "Consider tagging the release: git tag v$VERSION && git push --tags"
fi
