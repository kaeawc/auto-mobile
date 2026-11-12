#!/usr/bin/env bash
#
# validate-version-catalog-toml.sh
#
# Parse the Android version catalog with a strict TOML parser (Bun.TOML) and fail
# on duplicate keys or redefined tables (#16815). Two PRs can each add the same
# catalog key at different places in the file; git merges them without a
# conflict, and Gradle then rejects the catalog. Fast Validation runs on the PR
# merge ref, so this catches the duplicate before merge.
#
# Usage:
#   scripts/android/validate-version-catalog-toml.sh [catalog.toml ...]
#
# With no arguments it checks android/gradle/libs.versions.toml.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ $# -eq 0 ]]; then
  set -- "$PROJECT_ROOT/android/gradle/libs.versions.toml"
fi

if ! command -v bun > /dev/null 2>&1; then
  echo "bun is required to parse TOML version catalogs." >&2
  exit 2
fi

# Bun.TOML.parse rejects a redefined key ("Cannot redefine key"), a redefined
# table header and a dotted key that extends an existing inline table.
# shellcheck disable=SC2016 # the template literals are TypeScript, not shell.
readonly PARSE_CATALOGS='
let failed = false;
for (const path of process.argv.slice(1)) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`${path}: file not found`);
    failed = true;
    continue;
  }
  try {
    Bun.TOML.parse(await file.text());
    console.log(`${path}: valid TOML with no duplicate keys`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${path}: ${message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
'

if ! bun --eval "$PARSE_CATALOGS" "$@"; then
  echo "Version catalog TOML validation failed: remove the duplicate key or table (Gradle rejects it)." >&2
  exit 1
fi
