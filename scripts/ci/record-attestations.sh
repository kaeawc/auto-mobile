#!/usr/bin/env bash
# record-attestations.sh <lane> [--scope S] [--scope-note N] <gate-spec>...
# Also forwards --expected-head ID and --started-dirty for pre-push callers.
set -euo pipefail
if [[ $# -lt 2 ]]; then
  echo 'usage: record-attestations.sh <lane> [--scope S] [--scope-note N] <gate-spec>...' >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
lane="$1"
shift
args=(--lane "$lane")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope|--scope-note|--expected-head)
      [[ $# -ge 2 ]] || { echo "missing value for $1" >&2; exit 2; }
      args+=("$1" "$2")
      shift 2
      ;;
    --started-dirty)
      args+=("$1")
      shift
      ;;
    *) args+=(--gate "$1"); shift ;;
  esac
done
if bun "$root/scripts/ci/produce-attestations.ts" "${args[@]}"; then
  exit 0
else
  result=$?
  if [[ $result -eq 2 ]]; then exit 2; fi
  echo 'attestation skipped' >&2
  exit 0
fi
