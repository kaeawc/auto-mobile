#!/usr/bin/env bash
#
# Guard against stray "[*-DEBUG]" log tags merging into the TypeScript source.
#
# Temporary instrumentation often gets a bracketed tag like
# "[DEVICE-POOL-DEBUG]" so it can be grepped out of logs during a debugging
# session. Those statements are meant to be removed afterward; this check
# fails CI if any survive in src/, complementing dead-code-detection.yml.
#
# See issue #2656 (left-in [DEVICE-POOL-DEBUG] logging).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT_DIR}/src"

# Match an uppercase tag ending in -DEBUG inside square brackets, e.g.
# [DEVICE-POOL-DEBUG], [FOO-DEBUG]. Allow letters, digits, underscores, hyphens.
PATTERN='\[[A-Z0-9_-]+-DEBUG\]'

matches="$(grep -rEn --include='*.ts' "$PATTERN" "$SRC_DIR" || true)"

if [[ -n "$matches" ]]; then
  echo "error: stray [*-DEBUG] log tag(s) found in src/ — remove temporary instrumentation before merging:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "No stray [*-DEBUG] log tags found in src/."
