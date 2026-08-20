#!/usr/bin/env bash
#
# Clean-room verification of the pinned runtime dependency graph (issue #5421,
# acceptance criterion 3).
#
# Packs the published artifact and installs it into a throwaway project with an
# EMPTY package cache, then asserts the resolved runtime graph matches the
# committed manifest. This proves a consumer's `bun install -g` reproduces the
# intended exact versions instead of re-resolving caret ranges at install time.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

mkdir -p ci-logs

# 1. Ensure the published payload exists (dist/ is what gets packed).
if [ ! -f "dist/src/index.js" ]; then
  echo "Building dist/ before packing…"
  bun run build
fi

# 2. Verify package.json / manifest are internally consistent first (hermetic).
bun scripts/release/pin-runtime-deps.ts --check

# 3. Pack the artifact exactly as `npm publish` would.
pack_json="$(npm pack --json)"
tarball="$(printf '%s' "$pack_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[0].filename))')"
if [ -z "$tarball" ] || [ ! -f "$tarball" ]; then
  echo "npm pack did not produce a tarball" >&2
  exit 1
fi
tarball_abs="$REPO_ROOT/$tarball"
echo "Packed artifact: $tarball"

# 4. Install into a throwaway project with an isolated, empty cache so nothing is
#    served from a warm cache — a faithful "fresh environment" install.
consumer_dir="$(mktemp -d "${TMPDIR:-/tmp}/automobile-cleanroom.XXXXXX")"
cache_dir="$(mktemp -d "${TMPDIR:-/tmp}/automobile-cleanroom-cache.XXXXXX")"
cleanup() {
  rm -f "$tarball_abs"
  rm -rf "$consumer_dir" "$cache_dir"
}
trap cleanup EXIT

cat > "$consumer_dir/package.json" <<EOF
{
  "name": "automobile-cleanroom-consumer",
  "version": "0.0.0",
  "private": true,
  "dependencies": { "@kaeawc/auto-mobile": "file:$tarball_abs" }
}
EOF

echo "Installing packed artifact into clean room ($consumer_dir)…"
(
  cd "$consumer_dir"
  BUN_INSTALL_CACHE_DIR="$cache_dir" bun install --no-save
)

# 5. Assert the resolved graph reproduces the pinned manifest.
installed_nm="$consumer_dir/node_modules/@kaeawc/auto-mobile/node_modules"
# Bun hoists the tarball's dependencies to the consumer's top-level node_modules;
# fall back to the nested location if a package was kept nested.
consumer_nm="$consumer_dir/node_modules"
if [ -d "$installed_nm" ]; then
  # Assert against the top-level tree (hoisted) — the manifest names resolve there.
  echo "(nested node_modules present under the package; asserting hoisted tree)"
fi

bun "$REPO_ROOT/scripts/ci/assert-installed-runtime-graph.ts" "$consumer_nm" \
  | tee ci-logs/pinned-runtime-graph.log

echo "Pinned runtime graph clean-room verification passed."
