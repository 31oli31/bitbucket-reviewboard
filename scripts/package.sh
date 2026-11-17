#!/usr/bin/env bash
# Build Chrome and Firefox packages into dist/ (and versioned zip archives).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 - <<'PY'
import json
print(json.load(open("manifest.json"))["version"])
PY
)"

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist/chrome dist/firefox

copy_tree() {
  local dest="$1"
  local manifest="$2"

  rsync -a \
    --exclude '.git' \
    --exclude '.gitignore' \
    --exclude 'dist' \
    --exclude 'scripts' \
    --exclude 'tests' \
    --exclude 'manifest.json' \
    --exclude 'manifest.firefox.json' \
    --exclude 'README.md' \
    --exclude 'LICENSE' \
    --exclude '*.zip' \
    --exclude '.DS_Store' \
    ./ "$dest/"

  cp "$manifest" "$dest/manifest.json"
}

copy_tree "dist/chrome" "manifest.json"
copy_tree "dist/firefox" "manifest.firefox.json"

if command -v zip >/dev/null 2>&1; then
  (cd dist/chrome && zip -qr "../reviewboard-chrome-${VERSION}.zip" .)
  (cd dist/firefox && zip -qr "../reviewboard-firefox-${VERSION}.zip" .)
  echo "Packages:"
  echo "  dist/reviewboard-chrome-${VERSION}.zip"
  echo "  dist/reviewboard-firefox-${VERSION}.zip"
else
  echo "zip not found; unpacked folders are in dist/chrome and dist/firefox"
fi
