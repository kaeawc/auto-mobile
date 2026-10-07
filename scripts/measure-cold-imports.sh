#!/usr/bin/env bash
# Advisory diagnostic: measure cold module-import cost (issue #10429).
#
# Spawns a fresh `bun` process per sample, imports each entry module, and
# prints median/min/max cold-import milliseconds plus the loaded-module count.
# Never fails on slow imports; exits non-zero only for bad usage or a module
# that cannot be imported.
#
# Usage: scripts/measure-cold-imports.sh [-n SAMPLES] [module ...]
#   -n SAMPLES  samples per module (default 5)
#   -h          show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$SCRIPT_DIR/lib/measure-cold-import.ts"

DEFAULT_MODULES=(
  src/features/action/TapOnElement.ts
  src/features/action/BaseVisualChange.ts
  src/features/action/Rotate.ts
  src/server/interactionTools.ts
)

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | sed '$d'
}

samples=5
while getopts ":n:h" opt; do
  case "$opt" in
    n) samples="$OPTARG" ;;
    h)
      usage
      exit 0
      ;;
    :)
      echo "Option -$OPTARG requires an argument" >&2
      exit 2
      ;;
    *)
      echo "Unknown option -$OPTARG" >&2
      usage >&2
      exit 2
      ;;
  esac
done
shift $((OPTIND - 1))

if ! [[ "$samples" =~ ^[1-9][0-9]*$ ]]; then
  echo "SAMPLES must be a positive integer, got: $samples" >&2
  exit 2
fi

modules=("$@")
if [[ ${#modules[@]} -eq 0 ]]; then
  modules=("${DEFAULT_MODULES[@]}")
fi

cd "$REPO_ROOT"
printf '| Entry | Samples | Median ms | Min ms | Max ms | Modules |\n'
printf '|---|---|---|---|---|---|\n'

for module in ${modules[@]+"${modules[@]}"}; do
  times=()
  count=0
  for ((i = 0; i < samples; i++)); do
    if ! line="$(bun "$HELPER" "$module")"; then
      echo "Failed to import $module" >&2
      exit 1
    fi
    times+=("${line%% *}")
    count="${line##* }"
  done
  stats="$(printf '%s\n' ${times[@]+"${times[@]}"} | sort -n | awk '
    { v[NR] = $1 }
    END {
      mid = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2
      printf "%.0f | %.0f | %.0f", mid, v[1], v[NR]
    }')"
  printf '| %s | %d | %s | %s |\n' "$module" "$samples" "$stats" "$count"
done
