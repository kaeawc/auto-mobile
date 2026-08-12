#!/usr/bin/env bash
#
# Verify the Android SDK broadcast reaches the public navigation graph surface
# through the installed CtrlProxy and daemon.

set -euo pipefail

adb_bin="${ADB_BIN:-adb}"
device_id="${1:-}"
package_id="dev.jasonpearson.automobile.playground"
emit_action="dev.jasonpearson.automobile.playground.action.TEST_EMIT_SDK_NAVIGATION"
session_uuid="52150000-0000-4000-8000-000000000000"
timestamp_ms="$(($(date +%s) * 1000))"
destination="Issue5215SdkNavigation-${timestamp_ms}"
graph=""

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}

require_command "$adb_bin"
require_command auto-mobile
require_command jq

if [[ -z "$device_id" ]]; then
  device_id="$("$adb_bin" devices | awk '$2 == "device" { print $1; exit }')"
fi
if [[ -z "$device_id" ]]; then
  echo "error: no connected Android device" >&2
  exit 1
fi

# The debug-only Playground receiver requires android.permission.DUMP. Restart
# the selected emulator's adbd as root before launching the session it serves.
"$adb_bin" -s "$device_id" root >/dev/null
"$adb_bin" -s "$device_id" wait-for-device

# Bind CtrlProxy's SDK-event client and the graph query to the same daemon
# session before emitting the event. The debug-only Playground receiver invokes
# the public AutoMobileSDK API after launch has initialized the SDK.
if ! auto-mobile --debug --embedded-sdk --cli --session-uuid "$session_uuid" \
  launchApp --platform android --appId "$package_id" --deviceId "$device_id" >/dev/null; then
  echo "error: could not launch Android graph target app" >&2
  exit 1
fi
if ! auto-mobile --debug --embedded-sdk --cli --session-uuid "$session_uuid" \
  observe --platform android --deviceId "$device_id" >/dev/null; then
  echo "error: could not bind Android SDK events to navigation graph session" >&2
  exit 1
fi

if ! "$adb_bin" -s "$device_id" shell am broadcast \
  -a "$emit_action" -p "$package_id" --es destination "$destination" >/dev/null; then
  echo "error: could not trigger Android SDK navigation event" >&2
  exit 1
fi

for attempt in 1 2 3 4 5; do
  if ! auto-mobile --debug --embedded-sdk --cli --session-uuid "$session_uuid" \
    observe --platform android --deviceId "$device_id" >/dev/null; then
    echo "observe refresh attempt ${attempt} failed; retrying in 2s..." >&2
    sleep 2
    continue
  fi
  if ! graph="$(auto-mobile --debug --embedded-sdk --cli --session-uuid "$session_uuid" \
    getNavigationGraph --platform android --deviceId "$device_id")"; then
    echo "getNavigationGraph attempt ${attempt} failed; retrying in 2s..." >&2
    sleep 2
    continue
  fi
  if jq -e --arg destination "$destination" \
    '(if .content? then (.content[] | select(.type == "text").text | fromjson) else . end) as $result
      | ([$result.screens[].name] | index($destination)) != null' \
    <<<"$graph" >/dev/null; then
    echo "Android SDK navigation event reached getNavigationGraph on attempt ${attempt}."
    exit 0
  fi
  sleep 2
done

echo "error: Android SDK navigation event did not reach getNavigationGraph" >&2
echo "last graph response: ${graph}" >&2
exit 1
