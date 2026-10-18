#!/usr/bin/env bash
# Generate shields.io endpoint JSON badges for the TypeScript, Kotlin and Swift
# test counts (issue #11871). The counts are source greps, not test runs.
# The JSON is published with the docs site (docs.yml) and read by the README via
# img.shields.io/endpoint, so no badge commit ever lands on main.
#
# Usage: bash scripts/coverage/generate-test-count-badges.sh [OUTPUT_DIR]
#   REPO_ROOT overrides the tree that is counted (default: this checkout).
set -euo pipefail

repo_root="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
out_dir="${1:-${repo_root}/site}"

ts_count=$(grep -rE '^\s*(it|test)\(' "${repo_root}/test/" --include='*.test.ts' \
  | grep -vc '\.skip(' || true)

kotlin_count=$(grep -rE '^\s*@Test' "${repo_root}/android/" --include='*.kt' \
  | grep -cE 'src/(test|androidTest)/' || true)

swift_count=$(grep -rcE '^\s*func test' "${repo_root}/ios/" --include='*.swift' \
  | awk -F: '{s+=$NF} END {print s+0}')

format_number() {
  local n="$1"
  local formatted=""
  local i=0
  while [ "$n" -gt 0 ]; do
    local digit=$((n % 10))
    n=$((n / 10))
    if [ "$i" -gt 0 ] && [ $((i % 3)) -eq 0 ]; then
      formatted=",${formatted}"
    fi
    formatted="${digit}${formatted}"
    i=$((i + 1))
  done
  [ -z "$formatted" ] && formatted="0"
  echo "$formatted"
}

write_badge() {
  # $1: file name  $2: label  $3: count  $4: color (hex, no #)
  cat > "${out_dir}/$1" <<JSON
{
  "schemaVersion": 1,
  "label": "$2",
  "message": "$(format_number "$3")",
  "color": "$4"
}
JSON
}

mkdir -p "$out_dir"
write_badge typescript-tests-badge.json "TypeScript tests" "$ts_count" 3178C6
write_badge kotlin-tests-badge.json "Kotlin tests" "$kotlin_count" 7F52FF
write_badge swift-tests-badge.json "Swift tests" "$swift_count" F05138

echo "Test counts: TypeScript=$(format_number "$ts_count") Kotlin=$(format_number "$kotlin_count") Swift=$(format_number "$swift_count")"
echo "Badges written to ${out_dir}"
