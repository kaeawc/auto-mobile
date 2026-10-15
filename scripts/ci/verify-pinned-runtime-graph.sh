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
# Capture setup, pin validation, packing, installation, and final assertion.
# The CI job uploads this file on failure, so an early failure must not lose its
# only diagnostic output.
exec > >(tee -a ci-logs/pinned-runtime-graph.log) 2>&1

# 1. Ensure the published payload exists (dist/ is what gets packed).
if [ ! -f "dist/src/index.js" ]; then
  echo "Building dist/ before packing…"
  bun run build
fi

# 2. Verify package.json / manifest are internally consistent first (hermetic).
bun scripts/release/pin-runtime-deps.ts --check

# 3. Pack the artifact exactly as `npm publish` would.
pack_json="$(AUTOMOBILE_TRIM_BUNDLED_DEPS=true npm pack --json)"
# Lifecycle scripts (prepack) may print to stdout ahead of the JSON array, so
# parse from the first line-leading "[" that yields valid JSON instead of the
# whole stream. Require exactly one tarball.
tarball="$(printf '%s' "$pack_json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const starts = [...s.matchAll(/^\[/gm)].map((m) => m.index);
  for (const i of starts) {
    try {
      const parsed = JSON.parse(s.slice(i));
      if (Array.isArray(parsed) && parsed.length === 1 && parsed[0].filename) {
        process.stdout.write(parsed[0].filename);
      }
      return;
    } catch {
      // not the JSON payload; try the next candidate
    }
  }
});
')"
if [ -z "$tarball" ] || [ ! -f "$tarball" ]; then
  echo "npm pack did not produce exactly one tarball; output was:" >&2
  printf '%s\n' "$pack_json" >&2
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
package_root="$consumer_dir/node_modules/@kaeawc/auto-mobile"
consumer_nm="$consumer_dir/node_modules"

bun "$REPO_ROOT/scripts/ci/assert-installed-runtime-graph.ts" "$package_root" "$consumer_nm"

# 6. Load every importable bundled package from the trimmed installed copy.
bun "$REPO_ROOT/scripts/ci/smoke-installed-bundled-deps.ts" "$package_root"

echo "Pinned runtime graph clean-room verification passed."
