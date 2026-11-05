#!/usr/bin/env bash
# Explore the Playground fixture and replay a learned navigation edge in emulator CI.
set -euo pipefail

adb_bin="${ADB_BIN:-adb}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/session-release.sh
source "${script_dir}/../lib/session-release.sh"
repo_root="${GITHUB_WORKSPACE:-$(cd -- "${script_dir}/../.." && pwd)}"
dist_entry="${repo_root}/dist/src/index.js"
bun_bin_dir="${HOME}/.bun/bin"
device_id="${1:-}"
package_id="dev.jasonpearson.automobile.playground"
session_uuid=""

fail() { echo "FAIL: $*" >&2; exit 1; }

# Decode the public MCP text envelope with jq; diagnostics stay on stderr.
result_filter='if .content? then .content[] | select(.type == "text").text | fromjson else . end'

assert_json() {
  local label="$1" predicate="$2" json="$3"
  if ! jq -e "$predicate" <<< "$json" > /dev/null; then
    fail "${label}: ${json}"
  fi
  echo "PASS: ${label}"
}

# The preceding SDK-event check resolves auto-mobile in its own process; its PATH
# change does not reach this one, so resolve it again here.
resolve_auto_mobile_cli() {
  export PATH="${bun_bin_dir}:${PATH}"
  hash -r 2> /dev/null || true

  if command -v auto-mobile > /dev/null 2>&1; then
    return
  fi

  if [[ -x "${dist_entry}" ]]; then
    echo "auto-mobile not resolvable from global install; linking ${bun_bin_dir}/auto-mobile -> ${dist_entry}"
    mkdir -p "${bun_bin_dir}"
    ln -sf "${dist_entry}" "${bun_bin_dir}/auto-mobile"
    hash -r 2> /dev/null || true
  fi

  command -v auto-mobile > /dev/null 2>&1 || fail 'auto-mobile not resolvable'
}
resolve_auto_mobile_cli

for command in "$adb_bin" auto-mobile jq; do
  command -v "$command" > /dev/null 2>&1 || fail "required command not found: ${command}"
done
if [[ -z "$device_id" ]]; then
  device_id="$("$adb_bin" devices | awk '$2 == "device" { print $1; exit }')"
fi
[[ -n "$device_id" ]] || fail 'no connected Android device'

# The preceding SDK-event check has used this app. Clear its preferences so
# exploration always begins at onboarding, and foreground before acquisition
# so CtrlProxy readiness has an active app window to inspect.
"$adb_bin" -s "$device_id" shell pm clear "$package_id" > /dev/null || fail 'reset Playground'
"$adb_bin" -s "$device_id" shell am start -W -n "${package_id}/.MainActivity" > /dev/null \
  || fail 'foreground Playground'
session_result="$(auto-mobile --debug --embedded-sdk --cli getAndroid --deviceId "$device_id" \
  --automation-ready-timeout-ms 120000)" || fail 'acquire session'
session_uuid="$(jq -ce "$result_filter" <<< "$session_result" | jq -er \
  '(.runtime.session.sessionUuid // .sessionUuid) | select(type == "string" and length > 0)')" \
  || fail 'parse acquired session UUID'
install_session_release_trap "$session_uuid"
cli=(auto-mobile --debug --embedded-sdk --cli --session-uuid "$session_uuid")
"${cli[@]}" launchApp --platform android --deviceId "$device_id" --appId "$package_id" > /dev/null || fail 'launch Playground'

exploration="$("${cli[@]}" explore --platform android --deviceId "$device_id" --maxInteractions 40 --timeoutMs 300000 --packageName "$package_id" | jq -ce "$result_filter")" \
  || fail 'explore Playground'
assert_json 'explore completed' '.success == true and .cancelled != true' "$exploration"

# SDK events and graph writes may arrive after the action response. Retry reads,
# never exploration or replay, so failures cannot be masked by extra interactions.
graph=""
for attempt in 1 2 3 4 5; do
  if "${cli[@]}" observe --platform android --deviceId "$device_id" > /dev/null \
    && graph="$("${cli[@]}" getNavigationGraph --platform android --deviceId "$device_id" --appId "$package_id" | jq -ce "$result_filter")" \
    && jq -e '
      ([.screens[].name] | contains(["LoginDestination", "HomeDestination", "DemoIndexDestination"]))
      and any(.transitions[]; .from == "LoginDestination" and .to == "HomeDestination" and .type == "tool" and .tool == "tapOn" and .args.selector.text == "Continue as Guest")
      and any(.transitions[]; .from == "HomeDestination" and .to == "DemoIndexDestination" and .type == "tool" and .tool == "tapOn" and .args.selector.text == "Demos")
    ' <<< "$graph" > /dev/null; then
    break
  fi
  if [[ "$attempt" -eq 5 ]]; then fail "expected graph nodes and learned edges: ${graph}"; fi
  sleep 2
done
echo 'PASS: expected graph nodes are present'
# Cleared state starts at onboarding, but the SDK records no edge before the first learned screen, so onboarding is not a node.
echo 'PASS: login to home and Home to Demos learned edges are present'

home="$("${cli[@]}" navigateTo --platform android --deviceId "$device_id" --targetScreen HomeDestination | jq -ce "$result_filter")" || fail 'return to Home before replay'
assert_json 'replay starts at Home' '.success == true and .currentScreen == "HomeDestination"' "$home"
replay="$("${cli[@]}" navigateTo --platform android --deviceId "$device_id" --targetScreen DemoIndexDestination | jq -ce "$result_filter")" || fail 'replay Home to Demos'
assert_json 'Home to Demos replay succeeds in one step' \
  '.success == true and .currentScreen == "DemoIndexDestination" and .stepsExecuted == 1' "$replay"

for attempt in 1 2 3 4 5; do
  if observation="$("${cli[@]}" observe --platform android --deviceId "$device_id" | jq -ce "$result_filter")" \
    && jq -e ' .screenIdentity.components.navigationRoute == "DemoIndexDestination" ' <<< "$observation" > /dev/null \
    && graph="$("${cli[@]}" getNavigationGraph --platform android --deviceId "$device_id" --appId "$package_id" | jq -ce "$result_filter")" \
    && jq -e '.currentScreen == "DemoIndexDestination"' <<< "$graph" > /dev/null; then
    break
  fi
  if [[ "$attempt" -eq 5 ]]; then fail "observed arrival at DemoIndexDestination: ${graph}"; fi
  sleep 2
done
echo 'PASS: observed arrival at DemoIndexDestination'

home="$("${cli[@]}" navigateTo --platform android --deviceId "$device_id" --targetScreen HomeDestination | jq -ce "$result_filter")" || fail 'return to Home before negative replay'
assert_json 'negative replay starts at Home' '.success == true and .currentScreen == "HomeDestination"' "$home"
# A navigateTo tool error can also give the CLI a nonzero exit status. Retain
# stdout in either case and require the precise structured failure below.
negative="$("${cli[@]}" navigateTo --platform android --deviceId "$device_id" --targetScreen OnboardingDestination)" || true
negative="$(jq -ce "$result_filter" <<< "$negative")" || fail 'decode negative navigateTo response'
assert_json 'unreachable onboarding reports No known path with zero steps' \
  '.success == false and .stepsExecuted == 0 and .currentScreen == "HomeDestination" and .targetScreen == "OnboardingDestination" and (.error | startswith("No known path"))' "$negative"
