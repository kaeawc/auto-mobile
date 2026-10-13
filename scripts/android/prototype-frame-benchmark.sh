#!/usr/bin/env bash
# Measure the prototype overlay with gfxinfo; never manages a daemon.
# Usage: prototype-frame-benchmark.sh --device ID [--package PKG] [--spec FILE]
#   [--show-settle-ms N] (default 2000; non-negative integer)
#   [--scenarios FILE] [--scenario NAME ...] [--list] [--dry-run] [--markdown]
# PROTOTYPE_BENCH_ADB and PROTOTYPE_BENCH_CLI override executable paths.
# AUTOMOBILE_SESSION_UUID is passed to every CLI call as --session-uuid.
set -euo pipefail
export LC_ALL=C
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
usage() { sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# //'; }
die() { echo "prototype-frame-benchmark: $*" >&2; exit 2; }
device=""; package=dev.jasonpearson.automobile.ctrlproxy
spec="${ROOT}/benchmark/prototype-frame/spec.json"
scenarios="${ROOT}/benchmark/prototype-frame/scenarios.json"
show_settle_ms=2000
filters=(); dry=false; list=false; markdown=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --list) list=true; shift ;;
    --dry-run) dry=true; shift ;;
    --markdown) markdown=true; shift ;;
    --device|--package|--spec|--scenarios|--scenario|--show-settle-ms)
      [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"
      case "$1" in
        --show-settle-ms)
          [[ "$2" =~ ^[0-9]+$ ]] || die "--show-settle-ms must be a non-negative integer"
          show_settle_ms="$2" ;;
        --device) device="$2" ;;
        --package) package="$2" ;;
        --spec) spec="$2" ;;
        --scenarios) scenarios="$2" ;;
        --scenario) filters+=("$2") ;;
      esac
      shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -f "$scenarios" ]] || die "scenarios not found"
jq -e 'type == "array" and length > 0 and all(.[];
  (.name | type == "string" and test("^[a-z0-9-]+$")) and
  (.repeat | type == "number" and floor == . and . > 0) and
  (.settleMs | type == "number" and . >= 0) and
  ((.durationMs // 0) | type == "number" and . >= 0) and
  (.steps | type == "array" and all(.[];
    (.tool == "tapOn" or .tool == "swipeOn") and (.text | type == "string" and length > 0) and
    (if .tool == "swipeOn" then (.direction == "up" or .direction == "down" or .direction == "left" or .direction == "right") else true end))))
  and ([.[].name] | length == (unique | length))' "$scenarios" >/dev/null || die "invalid scenarios"
for filter in ${filters[@]+"${filters[@]}"}; do
  jq -e --arg name "$filter" 'any(.[]; .name == $name)' "$scenarios" >/dev/null || die "unknown scenario: $filter"
done
selected() {
  [[ ${#filters[@]} -eq 0 ]] && return 0
  local filter
  for filter in "${filters[@]}"; do [[ "$filter" == "$1" ]] && return 0; done
  return 1
}
if $list; then
  while IFS= read -r name; do selected "$name" && printf '%s\n' "$name"; done < <(jq -r '.[].name' "$scenarios")
  exit 0
fi
[[ -n "$device" ]] || $dry || die "--device is required"
[[ -f "$spec" ]] || die "spec not found"
[[ "$spec" == /* ]] || spec="${PWD}/${spec}"
id=$(jq -er '.id | select(type == "string" and length > 0)' "$spec") || die "spec needs an id"
adb=("${PROTOTYPE_BENCH_ADB:-adb}")
if [[ -n "${PROTOTYPE_BENCH_CLI:-}" ]]; then cli=("$PROTOTYPE_BENCH_CLI"); else cli=(bun "${ROOT}/src/index.ts" --cli); fi
session=()
[[ -z "${AUTOMOBILE_SESSION_UUID:-}" ]] || session=(--session-uuid "$AUTOMOBILE_SESSION_UUID")
run_command() {
  if $dry; then printf '%q ' "$@"; printf '\n'; else "$@"; fi
}
run_cli() { run_command "${cli[@]}" ${session[@]+"${session[@]}"} "$@" --deviceId "${device:-<device>}"; }
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  if $dry; then run_cli prototype --action dismiss --id "$id"; else run_cli prototype --action dismiss --id "$id" >&2 || true; fi
}
# Install cleanup before show, including a partially successful show.
trap cleanup EXIT
if $dry; then run_cli prototype --action show --specPath "$spec"; else run_cli prototype --action show --specPath "$spec" >&2; fi
if [[ "$show_settle_ms" =~ [1-9] ]]; then
  run_command sleep "$(awk -v ms="$show_settle_ms" 'BEGIN { print ms / 1000 }')"
fi
failed=0
if $markdown && ! $dry; then
  printf '| Scenario | Frames | Janky %% | p50 ms | p90 ms | p95 ms | p99 ms | Slow UI | Error |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
fi
while IFS= read -r scenario; do
  name=$(jq -r '.name' <<< "$scenario")
  selected "$name" || continue
  error=""
  if $dry; then
    run_command "${adb[@]}" -s "${device:-<device>}" shell dumpsys gfxinfo "$package" reset
  elif ! run_command "${adb[@]}" -s "$device" shell dumpsys gfxinfo "$package" reset >&2; then error="reset-failed"; fi
  repeat=$(jq -r '.repeat' <<< "$scenario")
  for ((i=0; i<repeat; i++)); do
    while IFS= read -r step; do
      tool=$(jq -r '.tool' <<< "$step")
      selector=$(jq -c '{text:.text}' <<< "$step")
      args=("$tool" --layer prototype)
      if [[ "$tool" == tapOn ]]; then args+=(--selector "$selector"); else args+=(--container "$selector" --direction "$(jq -r '.direction' <<< "$step")"); fi
      if $dry; then run_cli "${args[@]}"; elif ! run_cli "${args[@]}" >&2; then error="step-failed"; fi
    done < <(jq -c '.steps[]' <<< "$scenario")
    delay=$(jq -r '((.durationMs // .settleMs) / 1000)' <<< "$scenario")
    run_command sleep "$delay"
  done
  if $dry; then
    run_command "${adb[@]}" -s "${device:-<device>}" shell dumpsys gfxinfo "$package"
    continue
  fi
  # #3647: guard the capture so set -e cannot skip the remaining scenarios.
  if out=$("${adb[@]}" -s "$device" shell dumpsys gfxinfo "$package" 2>&1); then
    values=$(awk '
      /^Total frames rendered:/ && !f { frames=$NF; f=1 }
      /^Janky frames:/ && !j { pct=$NF; gsub(/[()%]/,"",pct); j=1 }
      /^50th percentile:/ && !a { p50=$NF; sub(/ms$/,"",p50); a=1 }
      /^90th percentile:/ && !b { p90=$NF; sub(/ms$/,"",p90); b=1 }
      /^95th percentile:/ && !c { p95=$NF; sub(/ms$/,"",p95); c=1 }
      /^99th percentile:/ && !d { p99=$NF; sub(/ms$/,"",p99); d=1 }
      /^Number Slow UI thread:/ && !s { slow=$NF; s=1 }
      END { if(f&&j&&a&&b&&c&&d&&s) print frames,pct,p50,p90,p95,p99,slow }
    ' <<< "$out")
    if [[ ! "$values" =~ ^[0-9]+\ [0-9]+([.][0-9]+)?\ [0-9]+([.][0-9]+)?\ [0-9]+([.][0-9]+)?\ [0-9]+([.][0-9]+)?\ [0-9]+([.][0-9]+)?\ [0-9]+$ ]]; then error=missing-fields; fi
  else error=capture-failed
  fi
  if [[ -n "$error" ]]; then
    failed=1
    if $markdown; then printf '| %s | — | — | — | — | — | — | — | %s |\n' "$name" "$error"; else printf 'scenario=%s error=%s\n' "$name" "$error"; fi
  else
    read -r frames pct p50 p90 p95 p99 slow <<< "$values"
    if $markdown; then printf '| %s | %s | %s | %s | %s | %s | %s | %s | — |\n' "$name" "$frames" "$pct" "$p50" "$p90" "$p95" "$p99" "$slow"
    else printf 'scenario=%s frames=%s janky_pct=%s p50_ms=%s p90_ms=%s p95_ms=%s p99_ms=%s slow_ui=%s\n' "$name" "$frames" "$pct" "$p50" "$p90" "$p95" "$p99" "$slow"; fi
  fi
done < <(jq -c '.[]' "$scenarios")
exit "$failed"
