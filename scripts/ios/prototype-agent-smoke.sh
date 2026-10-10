#!/usr/bin/env bash
# Per-runtime simulator smoke test for the iOS prototype agent (ios/prototype-agent, issue #10569).
#
# Creates a FRESH simulator on one iOS runtime, injects the agent dylib into stock Settings via
# SIMCTL_CHILD_DYLD_INSERT_LIBRARIES, shows the demo floating prototype through the host driver
# (scripts/ios/prototype-agent-demo.ts), and checks it three ways: the agent's own prototype_result
# and status replies, and `simctl io screenshot` pixels that differ from the pre-injection baseline.
# It then dismisses the prototype, and always shuts down and deletes the simulator it created. Only
# that one UDID is ever touched, serially.
#
# Taps are headless through the agent's simulate_tap test hook (the app is launched with
# AUTOMOBILE_PROTOTYPE_AGENT_TEST_HOOKS=1; production launches never set it): the script taps the
# demo's `like-button` twice and asserts the host receives prototype_event "liked" with an
# increasing sequence. This exercises the spec action and event path, not UIKit touch delivery.
#
# CI: the advisory "Prototype Simulator" job (.github/workflows/pull_request.yml, heavy self-hosted
# Mac lane for same-repo PRs, #11011), one matrix leg per iOS version, runs this when the prototype
# agent's inputs change. It is not a required check.
#
# Usage: scripts/ios/prototype-agent-smoke.sh <ios-version|latest>   e.g. 26, 18.5, latest
#
# Environment:
#   PROTOTYPE_SMOKE_LOG_DIR            output dir (default scratch/prototype-agent-smoke/ios-<version>)
#   PROTOTYPE_SMOKE_BUILD_SCRIPT       dylib build script (default: prototype-agent-build.sh beside this)
#   PROTOTYPE_SMOKE_DRIVER             host driver command (default: bun prototype-agent-demo.ts)
#   PROTOTYPE_SMOKE_DEVICE_TYPE        simulator device type identifier (default: newest iPhone the
#                                    runtime supports)
#   PROTOTYPE_SMOKE_BOOT_TIMEOUT       seconds for bootstatus (default 600)
#   PROTOTYPE_SMOKE_CONNECT_ATTEMPTS   agent status polls after launch (default 20)
#   PROTOTYPE_SMOKE_SETTLE_SECONDS     pause before each screenshot and between polls (default 2)
#
# Exit codes: 0 pass; 1 check failed; 2 usage; 3 no matching runtime installed (skip, not a fail).
set -euo pipefail

usage() {
  echo "usage: prototype-agent-smoke.sh <ios-version|latest>" >&2
}
if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi
requested="$1"
if [[ ! ${requested} =~ ^(latest|[0-9]+(\.[0-9]+)*)$ ]]; then
  usage
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "${script_dir}/run_with_timeout.sh"

bundle_id="com.apple.Preferences"
boot_timeout="${PROTOTYPE_SMOKE_BOOT_TIMEOUT:-600}"
attempts="${PROTOTYPE_SMOKE_CONNECT_ATTEMPTS:-20}"
settle="${PROTOTYPE_SMOKE_SETTLE_SECONDS:-2}"
build_script="${PROTOTYPE_SMOKE_BUILD_SCRIPT:-${script_dir}/prototype-agent-build.sh}"
read -r -a driver <<< "${PROTOTYPE_SMOKE_DRIVER:-bun ${script_dir}/prototype-agent-demo.ts}"

# Pick the newest installed iOS runtime matching the request ("26" matches 26.x).
runtimes_json="$(xcrun simctl list runtimes available iOS --json)"
if [[ ${requested} == latest ]]; then
  prefix=""
else
  prefix="${requested}"
fi
runtime_line="$(printf '%s' "${runtimes_json}" | jq -r --arg p "${prefix}" '
  [.runtimes[]
    | select(.isAvailable != false)
    | select($p == "" or .version == $p or (.version | startswith($p + ".")))]
  | sort_by(.version | split(".") | map(tonumber? // 0))
  | last // empty
  | [.version, .identifier] | @tsv')"
if [[ -z ${runtime_line} ]]; then
  echo "prototype-agent-smoke: no installed iOS runtime matches '${requested}'; skipping" >&2
  exit 3
fi
runtime_version="${runtime_line%%$'\t'*}"
runtime_id="${runtime_line#*$'\t'}"

log_dir="${PROTOTYPE_SMOKE_LOG_DIR:-scratch/prototype-agent-smoke/ios-${runtime_version}}"
mkdir -p "${log_dir}"
log="${log_dir}/smoke.log"
: > "${log}"
exec > >(tee -a "${log}") 2>&1
echo "prototype-agent-smoke: iOS ${runtime_version} (${runtime_id})"

device_type="${PROTOTYPE_SMOKE_DEVICE_TYPE:-}"
if [[ -z ${device_type} ]]; then
  device_type="$(printf '%s' "${runtimes_json}" | jq -r --arg id "${runtime_id}" '
    [.runtimes[] | select(.identifier == $id) | .supportedDeviceTypes[]
      | select(.productFamily == "iPhone")] | last // empty | .identifier')"
fi
if [[ -z ${device_type} ]]; then
  echo "prototype-agent-smoke: runtime ${runtime_id} lists no iPhone device type" >&2
  exit 1
fi

udid=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n ${udid} ]]; then
    # Best effort: the simulator may already be shut down, and cleanup must not mask the result.
    xcrun simctl shutdown "${udid}" > /dev/null 2>&1 || echo "prototype-agent-smoke: shutdown skipped (not booted?)"
    xcrun simctl delete "${udid}" > /dev/null 2>&1 || echo "prototype-agent-smoke: delete failed for ${udid}"
  fi
  exit "${status}"
}
trap cleanup EXIT

fail() {
  echo "prototype-agent-smoke: FAIL: $*" >&2
  exit 1
}

# Rewrites <file> with the last top-level JSON value in it that matches the jq <filter>, or fails.
# The driver prints each reply as one compact JSON line on stdout and its handshake log on stderr,
# but this must not depend on that: a driver that also prints labelled log lines (`agent {json}`,
# `event {json}`, `unmatched {json}`) or pretty-prints a reply across several lines has to work
# too. Labelled log lines are dropped whole (their JSON bodies are never picked apart), then jq
# parses what remains as a stream of JSON values with --slurp, so a multi-line value is one value.
keep_last_json() {
  local file="$1" filter="$2" what="$3" reply
  if ! reply="$({ grep -v -E '^[A-Za-z_]+ [{[]' "${file}" || true; } \
    | jq -c -s "[.[] | select(type == \"object\") | select(${filter})] | last // empty")"; then
    fail "driver output for ${what} is not JSON: $(cat "${file}")"
  fi
  [[ -n ${reply} ]] || fail "no ${what} reply from the driver: $(cat "${file}")"
  printf '%s\n' "${reply}" > "${file}"
}

keep_reply() {
  keep_last_json "$1" '.type == "prototype_result"' prototype_result
}

echo "== build agent"
bash "${build_script}"

echo "== create and boot a fresh simulator (${device_type})"
udid="$(xcrun simctl create "prototype-agent-smoke-${runtime_version}-$$" "${device_type}" "${runtime_id}")"
[[ -n ${udid} ]] || fail "simctl create returned no UDID"
xcrun simctl boot "${udid}"
set +e
run_with_timeout "${boot_timeout}" xcrun simctl bootstatus "${udid}" -b
boot_status=$?
set -e
if [[ ${boot_status} -ne 0 ]]; then
  fail "simulator did not finish booting (status ${boot_status})"
fi
# A fixed clock keeps the status bar out of the pixel comparison.
xcrun simctl status_bar "${udid}" override --time "9:41" > /dev/null

echo "== baseline screenshot of stock Settings"
xcrun simctl launch --terminate-running-process "${udid}" "${bundle_id}" > /dev/null
sleep "${settle}"
baseline="${log_dir}/baseline.png"
xcrun simctl io "${udid}" screenshot "${baseline}"

echo "== relaunch with the agent injected"
"${driver[@]}" launch "${udid}" "${bundle_id}" --test-hooks

echo "== wait for the agent"
connected=false
for ((attempt = 1; attempt <= attempts; attempt++)); do
  if "${driver[@]}" status > "${log_dir}/status-initial.json" 2> "${log_dir}/status-initial.err"; then
    connected=true
    break
  fi
  sleep "${settle}"
done
[[ ${connected} == true ]] || fail "agent never answered get_prototype_status ($(tail -n 1 "${log_dir}/status-initial.err"))"
keep_reply "${log_dir}/status-initial.json"
[[ "$(jq -r '.type' "${log_dir}/status-initial.json")" == prototype_result ]] || fail "unexpected status reply"
[[ "$(jq -r '.status.shown' "${log_dir}/status-initial.json")" == false ]] || fail "prototype shown before show_prototype"

echo "== show the demo prototype"
"${driver[@]}" floating > "${log_dir}/show.json"
keep_reply "${log_dir}/show.json"
[[ "$(jq -r '.success' "${log_dir}/show.json")" == true ]] || fail "show_prototype failed: $(cat "${log_dir}/show.json")"
"${driver[@]}" status > "${log_dir}/status-shown.json"
keep_reply "${log_dir}/status-shown.json"
[[ "$(jq -r '.status.shown' "${log_dir}/status-shown.json")" == true ]] || fail "status does not report the prototype shown"
[[ "$(jq -r '.status.id' "${log_dir}/status-shown.json")" == floating-demo ]] || fail "status reports the wrong prototype id"

sleep "${settle}"
shown="${log_dir}/shown.png"
xcrun simctl io "${udid}" screenshot "${shown}"
if cmp -s "${baseline}" "${shown}"; then
  fail "screenshot with the prototype equals the baseline (prototype not in the pixels)"
fi

echo "== tap the like button twice and expect prototype_event"
sequences=()
for tap in 1 2; do
  "${driver[@]}" tap like-button > "${log_dir}/tap-${tap}.json"
  keep_last_json "${log_dir}/tap-${tap}.json" '.result.type == "prototype_result"' simulate_tap
  [[ "$(jq -r '.result.success' "${log_dir}/tap-${tap}.json")" == true ]] || fail "simulate_tap failed: $(cat "${log_dir}/tap-${tap}.json")"
  [[ "$(jq -r '[.events[] | select(.type == "prototype_event" and .kind == "emit" and .name == "liked" and .id == "floating-demo")] | length' "${log_dir}/tap-${tap}.json")" == 1 ]] \
    || fail "tap ${tap} did not deliver exactly one prototype_event 'liked': $(cat "${log_dir}/tap-${tap}.json")"
  sequences+=("$(jq -r '.events[0].sequence' "${log_dir}/tap-${tap}.json")")
done
if ! [[ ${sequences[0]} =~ ^[0-9]+$ && ${sequences[1]} =~ ^[0-9]+$ ]] || ((sequences[1] <= sequences[0])); then
  fail "prototype_event sequence did not increase (${sequences[*]})"
fi

echo "== dismiss"
"${driver[@]}" dismiss > "${log_dir}/dismiss.json"
keep_reply "${log_dir}/dismiss.json"
[[ "$(jq -r '.success' "${log_dir}/dismiss.json")" == true ]] || fail "dismiss_prototype failed: $(cat "${log_dir}/dismiss.json")"
"${driver[@]}" status > "${log_dir}/status-dismissed.json"
keep_reply "${log_dir}/status-dismissed.json"
[[ "$(jq -r '.status.shown' "${log_dir}/status-dismissed.json")" == false ]] || fail "prototype still shown after dismiss"
sleep "${settle}"
dismissed="${log_dir}/dismissed.png"
xcrun simctl io "${udid}" screenshot "${dismissed}"
if cmp -s "${shown}" "${dismissed}"; then
  fail "screenshot after dismiss equals the shown screenshot"
fi

echo "prototype-agent-smoke: PASS on iOS ${runtime_version}"
