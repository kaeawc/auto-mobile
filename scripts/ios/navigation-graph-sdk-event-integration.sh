#!/usr/bin/env bash
# Verify the iOS CtrlProxy SDK-event path reaches the daemon's public navigation
# graph surface on the booted Simulator. The focused TypeScript tests cover path
# replay deterministically; this job owns the real runner/HTTP/daemon boundary.

set -euo pipefail

device_id="${1:?usage: navigation-graph-sdk-event-integration.sh <simulator-udid>}"
timestamp_ms="$(($(date +%s) * 1000))"
bundle_id="dev.jasonpearson.automobile.issue4460"
home_screen="Issue4460Home"
detail_screen="Issue4460Detail"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}

require_command auto-mobile
require_command base64
require_command curl
require_command jq
require_command xcrun

xcrun simctl getenv "${device_id}" HOME >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8765/health >/dev/null

event_payload() {
  local destination="$1"
  jq -cn \
    --argjson timestamp "${timestamp_ms}" \
    --arg destination "${destination}" \
    '{eventType:"navigation", timestamp:$timestamp, destination:$destination, source:"swiftui", arguments:{}, metadata:{}}' \
    | base64 | tr -d '\n'
}

batch="$(jq -cn \
  --arg bundle_id "${bundle_id}" \
  --argjson timestamp "${timestamp_ms}" \
  --arg home_payload "$(event_payload "${home_screen}")" \
  --arg detail_payload "$(event_payload "${detail_screen}")" \
  '{bundleId:$bundle_id, timestamp:$timestamp, events:[{eventType:"navigation", payload:$home_payload}, {eventType:"navigation", payload:$detail_payload}]}'
)"

curl --fail --silent --show-error --max-time 5 \
  --request POST \
  --header 'Content-Type: application/json' \
  --data "${batch}" \
  http://127.0.0.1:8765/sdk-events >/dev/null

# CtrlProxy polls its SDK endpoint every two seconds after the warm-up observe.
# Query through the public, daemon-backed tool until the batched events appear.
for attempt in 1 2 3 4 5; do
  if ! graph="$(auto-mobile --debug --cli getNavigationGraph --platform ios --deviceId "${device_id}")"; then
    echo "getNavigationGraph attempt ${attempt} failed; retrying in 2s..." >&2
    sleep 2
    continue
  fi
  if jq -e --arg home "${home_screen}" --arg detail "${detail_screen}" \
    '(if .content? then (.content[] | select(.type == "text").text | fromjson) else . end) as $result
      | ([$result.screens[].name] | index($home)) != null
      and ([$result.screens[].name] | index($detail)) != null' \
    <<<"${graph}" >/dev/null; then
    echo "iOS SDK navigation events reached getNavigationGraph on attempt ${attempt}."
    exit 0
  fi
  sleep 2
done

echo "error: iOS SDK navigation events did not reach getNavigationGraph" >&2
echo "last graph response: ${graph}" >&2
exit 1
