#!/usr/bin/env bash
# Update Formula/auto-mobile.rb with a new version's npm tarball URL and SHA256.
#
# Usage: scripts/release/update-brew-formula.sh <version>
#
# Resolves the published tarball from the npm registry and rewrites the
# `url` and `sha256` lines in Formula/auto-mobile.rb in place.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <version>" >&2
  exit 64
fi

VERSION="$1"
FORMULA="Formula/auto-mobile.rb"
PKG="@kaeawc/auto-mobile"
TARBALL="https://registry.npmjs.org/${PKG}/-/auto-mobile-${VERSION}.tgz"

if [[ ! -f "$FORMULA" ]]; then
  echo "error: $FORMULA not found" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$TARBALL" -o "$tmp/auto-mobile-${VERSION}.tgz"
SHA="$(shasum -a 256 "$tmp/auto-mobile-${VERSION}.tgz" | awk '{print $1}')"

# Cross-platform in-place sed: write to tmp file then mv
sed -e "s|^  url \".*\"$|  url \"${TARBALL}\"|" \
    -e "s|^  sha256 \".*\"$|  sha256 \"${SHA}\"|" \
    "$FORMULA" > "$tmp/formula.rb"
mv "$tmp/formula.rb" "$FORMULA"

echo "Updated $FORMULA to v${VERSION}"
echo "  url:    $TARBALL"
echo "  sha256: $SHA"
