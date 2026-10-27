#!/usr/bin/env bash
# Scripted scroll wall time (not frame time). Usage: --device UDID [--rows N]
#   [--swipes N] [--dry-run]. PROTOTYPE_BENCH_CLI overrides the CLI executable.
set -euo pipefail
export LC_ALL=C
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
die() { echo "prototype-feed-benchmark-ios: $*" >&2; exit 2; }
device=""; rows=1000; swipes=6; dry=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device|--rows|--swipes)
      [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"
      case "$1" in --device) device="$2" ;; --rows) rows="$2" ;; --swipes) swipes="$2" ;; esac
      shift 2 ;;
    --dry-run) dry=true; shift ;;
    --help|-h) sed -n '2,3p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -n "$device" ]] || $dry || die "--device is required"
# Bound scripted work and avoid shell integer overflow on untrusted values.
if ! [[ "$swipes" =~ ^[1-9][0-9]{0,2}$ ]] || [[ "$swipes" -gt 100 ]]; then
  die "--swipes must be an integer in 1..100"
fi
work_dir=$(mktemp -d)
if [[ -n "${PROTOTYPE_BENCH_CLI:-}" ]]; then cli=("$PROTOTYPE_BENCH_CLI"); else cli=(bun "${ROOT}/src/index.ts" --cli); fi
session=()
[[ -z "${AUTOMOBILE_SESSION_UUID:-}" ]] || session=(--session-uuid "$AUTOMOBILE_SESSION_UUID")
run_cli() {
  local args=("${cli[@]}" ${session[@]+"${session[@]}"} "$@" --deviceId "${device:-<device>}")
  if $dry; then printf '%q ' "${args[@]}"; printf '\n'; else "${args[@]}" < /dev/null; fi
}
shown=false
cleanup() {
  local exit_status=$?
  set +e
  if $shown; then run_cli prototype --action dismiss --id perf-feed >&2; fi
  rm -rf "$work_dir"
  exit "$exit_status"
}
trap cleanup EXIT
bun "${ROOT}/scripts/prototype/generate-feed-benchmark-spec.ts" --rows="$rows" --out "$work_dir/spec.json"
# Without a supplied asset the same avatar nodes render placeholders on iOS.
shown=true
run_cli prototype --action show --specPath "$work_dir/spec.json" >&2
TIMEFORMAT='%3R'
scroll_steps() {
  local i direction
  for ((i=1; i<=swipes; i++)); do
    direction=up
    if ((i > (swipes+1)/2)); then direction=down; fi
    if $dry; then
      run_cli swipeOn --layer prototype --container '{"text":"Benchmark feed"}' --direction "$direction"
    else
      { time run_cli swipeOn --layer prototype --container '{"text":"Benchmark feed"}' --direction "$direction" > "$work_dir/cli-out" 2> "$work_dir/cli-err"; } 2> "$work_dir/step-time"
      cat "$work_dir/cli-out" "$work_dir/cli-err" >&3
      awk -v step="$i" -v direction="$direction" '{printf "scroll_step=%d direction=%s wall_ms=%.0f\n",step,direction,$1*1000}' "$work_dir/step-time"
    fi
  done
}
if $dry; then
  scroll_steps
  echo 'wall_time_ms=n/a (dry-run; no frame metrics)'
else
  { time scroll_steps; } 3>&2 2> "$work_dir/total-time"
  awk -v swipes="$swipes" 'END {printf "scroll_total swipes=%d wall_ms=%.0f metric=scripted-scroll-wall-time\n",swipes,$1*1000}' "$work_dir/total-time"
fi
