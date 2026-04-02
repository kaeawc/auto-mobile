#!/usr/bin/env bash
# Filters ts-prune output (from stdin) against dead-code-allowlist.json ignorePaths.
# Lines matching any allowlisted file path are excluded from the output.

set -euo pipefail

ALLOWLIST="dead-code-allowlist.json"

if [ ! -f "$ALLOWLIST" ]; then
  cat # No allowlist found, pass through
  exit 0
fi

if ! command -v jq &> /dev/null; then
  echo "Warning: jq not installed, skipping allowlist filtering" >&2
  cat
  exit 0
fi

# Build grep exclusion pattern from ignorePaths and ignorePathPatterns
PATTERN=$( (jq -r '.ignorePaths[]' "$ALLOWLIST"; jq -r '.ignorePathPatterns // [] | .[]' "$ALLOWLIST") \
  | sed "s/[.[\\*^\$()+?{|]/\\\\&/g" \
  | paste -sd '|' -)

# Also build exclusion for specific ignoreEntries (file:name pairs)
# Escape file and name separately, then join with .* regex connector
ENTRY_PATTERN=$(jq -r '.ignoreEntries // [] | .[] | .file + "\t" + .name' "$ALLOWLIST" \
  | while IFS=$'\t' read -r file name; do
      # shellcheck disable=SC2001
      efile=$(echo "$file" | sed "s/[.[\\*^\$()+?{|]/\\\\&/g")
      # shellcheck disable=SC2001
      ename=$(echo "$name" | sed "s/[.[\\*^\$()+?{|]/\\\\&/g")
      echo "${efile}.*${ename}"
    done \
  | paste -sd '|' -)

if [ -n "$ENTRY_PATTERN" ]; then
  if [ -n "$PATTERN" ]; then
    PATTERN="$PATTERN|$ENTRY_PATTERN"
  else
    PATTERN="$ENTRY_PATTERN"
  fi
fi

if [ -z "$PATTERN" ]; then
  cat # No patterns, pass through
else
  grep -vE "$PATTERN" || true
fi
