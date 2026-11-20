#!/usr/bin/env bash
# Performance-tool smoke for the Android emulator PR job (#18725): a Perfetto
# performanceTrace around a cold Playground launch, a performanceAudit of the
# idle screen, and a two-launch cold measureStartup. It asserts result shape,
# not thresholds, so a slow emulator cannot fail it.
#
# Usage: performance-tool-smoke.sh [device-id]
#
# Environment (test seams):
#   ADB_BIN             adb binary (default: adb)
#   AUTO_MOBILE_CMD     CLI words (default: auto-mobile --debug --embedded-sdk --cli)
#   SMOKE_SESSION_UUID  reuse this session instead of acquiring one
#   PERF_SMOKE_FLOW_SLEEP  seconds the traced launch is given to draw (default 3)
set -euo pipefail

adb_bin="${ADB_BIN:-adb}"
cli_words="${AUTO_MOBILE_CMD:-auto-mobile --debug --embedded-sdk --cli}"
read -r -a cli_base <<< "$cli_words"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
device_id="${1:-}"
session_uuid="${SMOKE_SESSION_UUID:-}"
package_id="dev.jasonpearson.automobile.playground"
trace_id=""
trace_stopped=1
acquired_session=0

# shellcheck source=scripts/lib/session-release.sh
source "${script_dir}/../lib/session-release.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

# The MCP text envelope or a bare result object, decoded to the result object.
result_json() {
  jq -c 'if .content? then ([.content[] | select(.type == "text") | .text | (fromjson? // empty)][0] // {}) else . end' <<< "$1" 2> /dev/null || printf '{}\n'
}

# Runs one tool; prints its decoded result. A non-zero exit or an unparseable
# result fails the step with the raw output.
tool() {
  local label="$1" output stderr_file
  shift
  stderr_file="$(mktemp)"
  if ! output="$("${cli_base[@]}" --session-uuid "$session_uuid" "$@" --platform android --deviceId "$device_id" 2> "$stderr_file")"; then
    fail "${label}: ${output} $(cat "$stderr_file")"
  fi
  rm -f "$stderr_file"
  result_json "$output"
}

assert_json() {
  local label="$1" predicate="$2" json="$3"
  jq -e "$predicate" <<< "$json" > /dev/null || fail "${label}: ${json}"
  echo "PASS: ${label}"
}

stop_trace_on_exit() {
  local status=$?
  if [[ "$trace_stopped" -eq 0 ]]; then
    set +e
    "${cli_base[@]}" --session-uuid "$session_uuid" performanceTrace --action stop --traceId "$trace_id" \
      --platform android --deviceId "$device_id" > /dev/null 2>&1
    set -e
  fi
  if [[ "$acquired_session" -eq 1 ]]; then
    (exit "$status")
    session_release_on_exit
  fi
  exit "$status"
}

for command in "$adb_bin" "${cli_base[0]}" jq; do
  command -v "$command" > /dev/null 2>&1 || fail "required command not found: ${command}"
done
if [[ -z "$device_id" ]]; then
  device_id="$("$adb_bin" devices | awk '$2 == "device" { print $1; exit }')"
fi
[[ -n "$device_id" ]] || fail 'no connected Android device'
"$adb_bin" -s "$device_id" shell pm path "$package_id" > /dev/null 2>&1 \
  || fail "${package_id} is not installed; the Playground suite installs it first"

if [[ -z "$session_uuid" ]]; then
  acquired="$("${cli_base[@]}" getAndroid --deviceId "$device_id" --automation-ready-timeout-ms 120000)" \
    || fail "acquire session: ${acquired}"
  acquired_json="$(result_json "$acquired")"
  session_uuid="$(jq -er '(.runtime.session.sessionUuid // .sessionUuid) | select(type == "string" and length > 0)' \
    <<< "$acquired_json")" || fail "parse acquired session UUID: ${acquired}"
  acquired_session=1
  install_session_release_trap "$session_uuid"
fi
trap stop_trace_on_exit EXIT

# 1. performanceTrace around a cold launch. A broken Perfetto config yields a
# missing or 0-byte artifact (#14737), which fails here.
"$adb_bin" -s "$device_id" shell am force-stop "$package_id" > /dev/null
started="$(tool 'performanceTrace start' performanceTrace --action start --template appLaunch --appId "$package_id" --timeLimitMs 20000)"
assert_json 'performanceTrace start is recording' '.success == true and .state == "recording" and (.traceId | length > 0)' "$started"
trace_id="$(jq -r '.traceId' <<< "$started")"
trace_stopped=0
"$adb_bin" -s "$device_id" shell am start -W -n "${package_id}/.MainActivity" > /dev/null \
  || fail 'launch Playground inside the trace'
sleep "${PERF_SMOKE_FLOW_SLEEP:-3}"
stopped="$(tool 'performanceTrace stop' performanceTrace --action stop --traceId "$trace_id")"
trace_stopped=1
assert_json 'performanceTrace stop is stopped' '.success == true and .state == "stopped" and (.artifactPath | length > 0)' "$stopped"
artifact="$(jq -r '.artifactPath' <<< "$stopped")"
[[ -s "$artifact" ]] || fail "performanceTrace artifact is missing or empty: ${artifact}"
echo "PASS: performanceTrace artifact is non-empty ($(wc -c < "$artifact" | tr -d ' ') bytes)"
if jq -e 'any(.warnings[]?; test("trace_processor_shell was not found"))' <<< "$stopped" > /dev/null; then
  echo 'skipped: trace summary (trace_processor_shell is not on this host)'
else
  assert_json 'performanceTrace summary parsed a launch or frames' '(.summary.launch // .summary.hitches) != null' "$stopped"
fi

# 2. performanceAudit on the idle screen just launched: launch-time frames are
# outside its window, so it must pass (#18802).
audit="$(tool 'performanceAudit' performanceAudit --appId "$package_id" --kinds '["performance"]')"
assert_json 'performanceAudit idle screen passes' '.success == true and .failed == false and .performance.passed == true' "$audit"

# 3. measureStartup cold, two launches.
startup="$(tool 'measureStartup' measureStartup --appId "$package_id" --mode cold --iterations 2)"
assert_json 'measureStartup cold reports two positive TTID samples' \
  '.success == true and (.ttid.samples | length == 2) and all(.ttid.samples[]; type == "number" and . > 0)' "$startup"
