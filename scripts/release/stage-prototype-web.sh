#!/usr/bin/env bash
#
# Stage @kaeawc/auto-mobile-prototype-web for npm (#16455).
#
# Copies packages/prototype-web to <stage-dir>, stamps its package.json with the
# release version, builds the two browser entries into <stage-dir>/dist and
# refuses the stage unless `npm pack --dry-run` would ship exactly the built
# entries, their type declarations, the README and package.json. The checkout is
# never modified, so CI can run the same check on every change.
#
# Usage:
#   stage-prototype-web.sh <version> <stage-dir>
#
# <stage-dir> must not exist yet. On success the stage is ready for
# `npm publish <stage-dir>`.
#
# PROTOTYPE_WEB_BUILD overrides the build command, run with the stage's dist
# directory as its only argument (the BATS suite uses it to stub the build).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_DIR="${REPO_ROOT}/packages/prototype-web"

# What the tarball may hold, sorted. Anything else -- a source map, src/, the
# build script -- fails the stage; so does a missing entry.
EXPECTED_FILES=(
  README.md
  dist/element.js
  dist/index.js
  element.d.ts
  index.d.ts
  package.json
)

usage() {
  echo "usage: $(basename "$0") <version> <stage-dir>" >&2
}

default_build() {
  bun "${PACKAGE_DIR}/build.ts" --library --outdir "$1"
}

main() {
  if [[ $# -ne 2 ]]; then
    usage
    return 2
  fi
  local version="$1" stage="$2"

  # The same shape already-published.sh and validate-release-tag accept.
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]]; then
    echo "ERROR: not a release version: '${version}' (expected 0.0.45)" >&2
    return 2
  fi
  if [[ -e "$stage" ]]; then
    echo "ERROR: stage directory already exists: ${stage}" >&2
    return 2
  fi

  mkdir -p "$stage"
  # Everything but local build output; package.json `files` decides what ships.
  (cd "$PACKAGE_DIR" && tar --exclude=./dist --exclude=./node_modules -cf - .) \
    | (cd "$stage" && tar -xf -)

  VERSION="$version" node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
    manifest.version = process.env.VERSION;
    fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  ' "${stage}/package.json"

  if [[ -n "${PROTOTYPE_WEB_BUILD:-}" ]]; then
    "${PROTOTYPE_WEB_BUILD}" "${stage}/dist"
  else
    default_build "${stage}/dist"
  fi

  local packed
  packed="$(cd "$stage" && npm pack --dry-run --json --ignore-scripts)"
  local actual
  actual="$(printf '%s' "$packed" | VERSION="$version" node -e '
    const fs = require("node:fs");
    const [entry] = JSON.parse(fs.readFileSync(0, "utf8"));
    if (entry.version !== process.env.VERSION) {
      console.error("packed version " + entry.version + ", expected " + process.env.VERSION);
      process.exit(1);
    }
    console.log(entry.files.map((file) => file.path).sort().join("\n"));
  ')" || return 1

  local expected
  expected="$(printf '%s\n' "${EXPECTED_FILES[@]}")"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: the @kaeawc/auto-mobile-prototype-web tarball would not hold exactly the built entries and declarations." >&2
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
    return 1
  fi
  echo "Staged @kaeawc/auto-mobile-prototype-web ${version} in ${stage}"
}

main "$@"
