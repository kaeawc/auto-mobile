#!/usr/bin/env bash
# Per-runtime simulator smoke test for the iOS overlay agent (ios/overlay-agent, issue #10569).
#
# Creates a FRESH simulator on one iOS runtime, injects the agent dylib into stock Settings via
# SIMCTL_CHILD_DYLD_INSERT_LIBRARIES, shows the demo floating overlay through the host driver
# (scripts/ios/overlay-agent-demo.ts), and checks it three ways: the agent's own overlay_result
# and status replies, and `simctl io screenshot` pixels that differ from the pre-injection baseline.
# It then dismisses the overlay, and always shuts down and deletes the simulator it created. Only
# that one UDID is ever touched, serially.
#
# Taps are headless through the agent's simulate_tap test hook (the app is launched with
# AUTOMOBILE_OVERLAY_AGENT_TEST_HOOKS=1; production launches never set it): the script taps the
# demo's `like-button` twice and asserts the host receives overlay_event "liked" with an
# increasing sequence. This exercises the spec action and event path, not UIKit touch delivery.
#
# Usage: scripts/ios/overlay-agent-smoke.sh <ios-version|latest>   e.g. 26, 18.5, latest
#
# Environment:
#   OVERLAY_SMOKE_LOG_DIR            output dir (default scratch/overlay-agent-smoke/ios-<version>)
#   OVERLAY_SMOKE_BUILD_SCRIPT       dylib build script (default: overlay-agent-build.sh beside this)
#   OVERLAY_SMOKE_DRIVER             host driver command (default: bun overlay-agent-demo.ts)
#   OVERLAY_SMOKE_DEVICE_TYPE        simulator device type identifier (default: newest iPhone the
#                                    runtime supports)
#   OVERLAY_SMOKE_BOOT_TIMEOUT       seconds for bootstatus (default 600)
#   OVERLAY_SMOKE_CONNECT_ATTEMPTS   agent status polls after launch (default 20)
#   OVERLAY_SMOKE_SETTLE_SECONDS     pause before each screenshot and between polls (default 2)
#
# Exit codes: 0 pass; 1 check failed; 2 usage; 3 no matching runtime installed (skip, not a fail).
set -euo pipefail

usage() {
  echo "usage: overlay-agent-smoke.sh <ios-version|latest>" >&2
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
boot_timeout="${OVERLAY_SMOKE_BOOT_TIMEOUT:-600}"
attempts="${OVERLAY_SMOKE_CONNECT_ATTEMPTS:-20}"
settle="${OVERLAY_SMOKE_SETTLE_SECONDS:-2}"
build_script="${OVERLAY_SMOKE_BUILD_SCRIPT:-${script_dir}/overlay-agent-build.sh}"
read -r -a driver <<< "${OVERLAY_SMOKE_DRIVER:-bun ${script_dir}/overlay-agent-demo.ts}"

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
  echo "overlay-agent-smoke: no installed iOS runtime matches '${requested}'; skipping" >&2
  exit 3
fi
runtime_version="${runtime_line%%$'\t'*}"
runtime_id="${runtime_line#*$'\t'}"

log_dir="${OVERLAY_SMOKE_LOG_DIR:-scratch/overlay-agent-smoke/ios-${runtime_version}}"
mkdir -p "${log_dir}"
log="${log_dir}/smoke.log"
: > "${log}"
exec > >(tee -a "${log}") 2>&1
echo "overlay-agent-smoke: iOS ${runtime_version} (${runtime_id})"

device_type="${OVERLAY_SMOKE_DEVICE_TYPE:-}"
if [[ -z ${device_type} ]]; then
  device_type="$(printf '%s' "${runtimes_json}" | jq -r --arg id "${runtime_id}" '
    [.runtimes[] | select(.identifier == $id) | .supportedDeviceTypes[]
      | select(.productFamily == "iPhone")] | last // empty | .identifier')"
fi
if [[ -z ${device_type} ]]; then
  echo "overlay-agent-smoke: runtime ${runtime_id} lists no iPhone device type" >&2
  exit 1
fi

udid=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n ${udid} ]]; then
    # Best effort: the simulator may already be shut down, and cleanup must not mask the result.
    xcrun simctl shutdown "${udid}" > /dev/null 2>&1 || echo "overlay-agent-smoke: shutdown skipped (not booted?)"
    xcrun simctl delete "${udid}" > /dev/null 2>&1 || echo "overlay-agent-smoke: delete failed for ${udid}"
  fi
  exit "${status}"
}
trap cleanup EXIT

fail() {
  echo "overlay-agent-smoke: FAIL: $*" >&2
  exit 1
}

# The host driver prints the agent's asynchronous `event {json}` / `unmatched {json}` lines on
# stdout next to the one JSON reply, so a captured file is not a single JSON document. Keep only
# the last overlay_result line (a bounded, line-oriented filter) and rewrite the file with it.
keep_reply() {
  local file="$1" reply
  reply="$(grep '^{' "${file}" | jq -c 'select(.type == "overlay_result")' | tail -n 1 || true)"
  [[ -n ${reply} ]] || fail "no overlay_result reply from the driver: $(cat "${file}")"
  printf '%s\n' "${reply}" > "${file}"
}

echo "== build agent"
bash "${build_script}"

echo "== create and boot a fresh simulator (${device_type})"
udid="$(xcrun simctl create "overlay-agent-smoke-${runtime_version}-$$" "${device_type}" "${runtime_id}")"
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
[[ ${connected} == true ]] || fail "agent never answered get_overlay_status ($(tail -n 1 "${log_dir}/status-initial.err"))"
keep_reply "${log_dir}/status-initial.json"
[[ "$(jq -r '.type' "${log_dir}/status-initial.json")" == overlay_result ]] || fail "unexpected status reply"
[[ "$(jq -r '.status.shown' "${log_dir}/status-initial.json")" == false ]] || fail "overlay shown before show_overlay"

echo "== show the demo overlay"
"${driver[@]}" floating > "${log_dir}/show.json"
keep_reply "${log_dir}/show.json"
[[ "$(jq -r '.success' "${log_dir}/show.json")" == true ]] || fail "show_overlay failed: $(cat "${log_dir}/show.json")"
"${driver[@]}" status > "${log_dir}/status-shown.json"
keep_reply "${log_dir}/status-shown.json"
[[ "$(jq -r '.status.shown' "${log_dir}/status-shown.json")" == true ]] || fail "status does not report the overlay shown"
[[ "$(jq -r '.status.id' "${log_dir}/status-shown.json")" == floating-demo ]] || fail "status reports the wrong overlay id"

sleep "${settle}"
shown="${log_dir}/shown.png"
xcrun simctl io "${udid}" screenshot "${shown}"
if cmp -s "${baseline}" "${shown}"; then
  fail "screenshot with the overlay equals the baseline (overlay not in the pixels)"
fi

echo "== tap the like button twice and expect overlay_event"
sequences=()
for tap in 1 2; do
  "${driver[@]}" tap like-button > "${log_dir}/tap-${tap}.json"
  [[ "$(jq -r '.result.success' "${log_dir}/tap-${tap}.json")" == true ]] || fail "simulate_tap failed: $(cat "${log_dir}/tap-${tap}.json")"
  [[ "$(jq -r '[.events[] | select(.type == "overlay_event" and .kind == "emit" and .name == "liked" and .id == "floating-demo")] | length' "${log_dir}/tap-${tap}.json")" == 1 ]] \
    || fail "tap ${tap} did not deliver exactly one overlay_event 'liked': $(cat "${log_dir}/tap-${tap}.json")"
  sequences+=("$(jq -r '.events[0].sequence' "${log_dir}/tap-${tap}.json")")
done
if ! [[ ${sequences[0]} =~ ^[0-9]+$ && ${sequences[1]} =~ ^[0-9]+$ ]] || ((sequences[1] <= sequences[0])); then
  fail "overlay_event sequence did not increase (${sequences[*]})"
fi

echo "== dismiss"
"${driver[@]}" dismiss > "${log_dir}/dismiss.json"
keep_reply "${log_dir}/dismiss.json"
[[ "$(jq -r '.success' "${log_dir}/dismiss.json")" == true ]] || fail "dismiss_overlay failed: $(cat "${log_dir}/dismiss.json")"
"${driver[@]}" status > "${log_dir}/status-dismissed.json"
keep_reply "${log_dir}/status-dismissed.json"
[[ "$(jq -r '.status.shown' "${log_dir}/status-dismissed.json")" == false ]] || fail "overlay still shown after dismiss"
sleep "${settle}"
dismissed="${log_dir}/dismissed.png"
xcrun simctl io "${udid}" screenshot "${dismissed}"
if cmp -s "${shown}" "${dismissed}"; then
  fail "screenshot after dismiss equals the shown screenshot"
fi

echo "overlay-agent-smoke: PASS on iOS ${runtime_version}"
