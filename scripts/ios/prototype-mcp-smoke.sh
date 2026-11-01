#!/usr/bin/env bash
#
# Advisory live-prototype smoke through the MCP/CLI host routing and event store.
# Usage: prototype-mcp-smoke.sh <simulator-udid>
# The caller supplies one booted simulator; this script never creates, boots,
# shuts down or deletes simulators. Requires an installable DeepLinkDemo.app
# (PROTOTYPE_SMOKE_APP_BUNDLE overrides the repository fixture), jq and plutil.
# AUTO_MOBILE_CMD and XCRUN_BIN provide the same seams as saved-prototype-smoke.
# A supplied SMOKE_SESSION_UUID is consumed and released, like an acquired one.
# Exit: 0 pass, 1 failed check, 2 usage, 3 unsupported capability/platform.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -ne 1 || -z "${1:-}" || "$1" == -* ]]; then
  echo 'usage: prototype-mcp-smoke.sh <simulator-udid>' >&2
  exit 2
fi
device_id="$1"
cli_words="${AUTO_MOBILE_CMD:-auto-mobile --debug --embedded-sdk --cli}"
read -r -a cli_base <<< "$cli_words"
xcrun_bin="${XCRUN_BIN:-xcrun}"
app_bundle="${PROTOTYPE_SMOKE_APP_BUNDLE:-${script_dir}/../../test/fixtures/ios-app-bundle/DeepLinkDemo.app}"
session_uuid="${SMOKE_SESSION_UUID:-}"
cli_stdout=""; cli_stderr=""; cli_status=0
spec='{"id":"mcp-smoke","window":{"placement":{"type":"floating","gravity":"bottomCenter","offset":{"x":0,"y":0}}},"root":{"type":"row","testTag":"mcp-smoke-button","onTap":[{"type":"emit","name":"smoke-tapped"}],"style":{"background":"#FF0A84FF","padding":{"top":16,"bottom":16,"start":20,"end":20}},"children":[{"type":"text","text":"MCP smoke tap","style":{"color":"#FFFFFFFF","textSize":17}}]}}'
# shellcheck source=scripts/lib/session-release.sh
source "${script_dir}/../lib/session-release.sh"
cli() { "${cli_base[@]}" "$@"; }
call_cli() {
  local stdout_file stderr_file
  cli_status=0; stdout_file="$(mktemp)"; stderr_file="$(mktemp)"
  set +e
  cli "$@" >"$stdout_file" 2>"$stderr_file"
  cli_status=$?
  set -e
  cli_stdout="$(cat "$stdout_file")"; cli_stderr="$(cat "$stderr_file")"
  rm -f "$stdout_file" "$stderr_file"
}
result_json() { jq -c 'if .content? then ([.content[] | select(.type == "text") | .text | (fromjson? // empty)][0] // {}) else . end' <<< "$1" 2>/dev/null || printf '{}\n'; }
step_error() { echo "error: $1: $2" >&2; exit 1; }
check_cli() {
  local step="$1" code
  parsed="$(result_json "$cli_stdout")"
  code="$(jq -r '.errorCode // empty' <<< "$parsed")"
  if [[ "$code" == unsupported_capability || "$code" == unsupported_platform ]]; then
    echo "skipped: $step: $code (${cli_stdout}${cli_stderr:+ $cli_stderr})"
    exit 3
  fi
  [[ "$cli_status" -eq 0 && "$(jq -r --arg step "$step" 'if has("success") then .success else $step == "getApple" end' <<< "$parsed")" == true ]] || step_error "$step" "${cli_stdout}${cli_stderr:+ $cli_stderr}"
}
call_tool() {
  if [[ -n "$session_uuid" ]]; then
    call_cli --session-uuid "$session_uuid" "$1" --deviceId "$device_id" "${@:2}"
  else
    call_cli "$1" --deviceId "$device_id" "${@:2}"
  fi
}
call_prototype() { call_tool prototype --action "$1" "${@:2}"; check_cli "$1"; }
check_shown() {
  local expected="$1" step="$2"
  call_prototype status
  # status is host-local: current prototypes membership is the shown flag.
  # It proves host tracking, not a fresh device/pixel observation.
  jq -e --argjson expected "$expected" '(.prototypes | type == "array") and (any(.prototypes[]; .id == "mcp-smoke") == $expected)' <<< "$parsed" >/dev/null || step_error "$step" "unexpected prototype tracking: $cli_stdout"
  echo "ok: $step"
}
if [[ -z "$session_uuid" ]]; then
  call_cli getApple --deviceId "$device_id"
  check_cli getApple
  session_uuid="$(jq -er '(.runtime.session.sessionUuid // .sessionUuid) | select(type == "string" and length > 0)' <<< "$parsed")" || step_error getApple "could not parse session UUID: $cli_stdout"
fi
install_session_release_trap "$session_uuid"
echo 'ok: getApple'
[[ -f "$app_bundle/Info.plist" ]] || step_error install "missing installable app Info.plist: $app_bundle (set PROTOTYPE_SMOKE_APP_BUNDLE to a built DeepLinkDemo.app)"
bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app_bundle/Info.plist")" || step_error install 'could not read CFBundleIdentifier from Info.plist'
[[ -n "$bundle_id" && "$bundle_id" != com.apple.* ]] || step_error install "expected a non-Apple bundle id, got: $bundle_id"
"$xcrun_bin" simctl install "$device_id" "$app_bundle" || step_error install 'simctl install failed'
echo 'ok: install'
call_tool launchApp --platform ios --appId "$bundle_id" --prototype true
check_cli launchApp; echo 'ok: launchApp'
call_prototype show --spec "$spec"; echo 'ok: show'
call_tool tapOn --selector '{"text":"MCP smoke tap"}'
check_cli tapOn; echo 'ok: tapOn'
call_prototype awaitEvent --id mcp-smoke --eventName smoke-tapped --timeoutMs 5000
jq -e '.event.id == "mcp-smoke" and .event.name == "smoke-tapped"' <<< "$parsed" >/dev/null || step_error awaitEvent "expected smoke-tapped event for mcp-smoke: $cli_stdout"
echo 'ok: awaitEvent'
check_shown true 'status shown'
call_prototype dismiss --id mcp-smoke; echo 'ok: dismiss'
check_shown false 'status dismissed'
# The shared helper exits. Run it in a subshell so we can check status afterwards;
# its warning is a failure here, since successful release is a smoke postcondition.
set +e
release_output="$(session_release_on_exit 2>&1)"
release_status=$?
set -e
session_release_done=1
trap - EXIT
[[ "$release_status" -eq 0 && -z "$release_output" ]] || step_error 'release session' "$release_output"
echo 'ok: release session'
# A released session UUID cannot be routed again. Query the explicit device
# without that UUID; this checks only the host-local status of the new scope.
session_uuid=""
check_shown false 'status released'
