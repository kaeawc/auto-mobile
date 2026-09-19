#!/usr/bin/env bash
# Verify the iOS CtrlProxy SDK-event path reaches the daemon's public navigation
# graph surface on the booted Simulator. The focused TypeScript tests cover path
# replay deterministically; this job owns the real runner/HTTP/daemon boundary.

set -euo pipefail

device_id="${1:?usage: navigation-graph-sdk-event-integration.sh <simulator-udid>}"
timestamp_ms="$(($(date +%s) * 1000))"
bundle_id="com.apple.reminders"
home_screen="Issue4460Home"
detail_screen="Issue4460Detail"
# Keep the runner's SDK-event consumer and the public graph query in one session. Each CLI
# invocation otherwise receives a distinct MCP session, which can route the injected events to a
# different session-scoped NavigationGraphManager than getNavigationGraph reads.
session_uuid=""

require_command() {
  command -v "$1" > /dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}

require_command auto-mobile
require_command base64
require_command curl
require_command jq
require_command xcrun

xcrun simctl getenv "${device_id}" HOME > /dev/null

renew_session_ownership() {
  local session_uuid="$1"
  if ! AUTOMOBILE_DAEMON_TIMEOUT_MS=2000 auto-mobile --daemon heartbeat "${session_uuid}" > /dev/null; then
    echo "error: could not renew navigation graph session ownership" >&2
    return 1
  fi
}

ctrl_proxy_port_from_acquisition() {
  jq -er '
    def acquisition:
      if (.content? | type) == "array" then
        .content[]
        | select(.type == "text")
        | .text
        | fromjson
      else
        .
      end;
    acquisition
    | .deviceIdentity.iosServicePort
    | select(type == "number" and . > 0 and . <= 65535)
  '
}

wait_for_ctrl_proxy_health() {
  local ctrl_proxy_port="$1"
  local session_uuid="${2:-}"
  local attempt renew_status
  for attempt in 1 2 3 4 5; do
    if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${ctrl_proxy_port}/health" > /dev/null; then
      return 0
    fi
    # One-shot CLI clients stop their proxy heartbeat after each public call.
    # Renew the graph session while this bounded runner-health retry is in progress.
    if [[ -n "${session_uuid}" ]]; then
      set +e
      renew_session_ownership "${session_uuid}"
      renew_status=$?
      set -e
      if [[ "${renew_status}" -ne 0 ]]; then
        return 1
      fi
    fi
    if [[ "${attempt}" -lt 5 ]]; then
      echo "CtrlProxy health check attempt ${attempt} failed; retrying in 2s..." >&2
      sleep 2
    fi
  done

  echo "error: CtrlProxy health check failed after 5 attempts on port ${ctrl_proxy_port}" >&2
  return 1
}

# Acquire the booted Simulator before issuing session-scoped calls. A caller must
# not fabricate a UUID to access a device it has not acquired. The preceding
# video-recording integration explicitly releases its pool assignment while
# preserving the booted Simulator for this step. Its release may also stop
# CtrlProxy, so acquisition must recreate readiness before this script asks
# doctor for the new per-device port.
session_result="$(auto-mobile --debug --embedded-sdk --cli getApple --deviceId "${device_id}")"
if ! session_uuid="$(
  jq -er '
    (
      if (.runtime?.session?.sessionUuid // .sessionUuid) then
        (.runtime.session.sessionUuid // .sessionUuid)
      elif .content? then
        .content[]
        | select(.type == "text")
        | .text
        | fromjson
        | (.runtime.session.sessionUuid // .sessionUuid)
      else empty
      end
    )
    | select(type == "string" and length > 0)
  ' <<< "${session_result}"
)"; then
  echo "error: could not acquire navigation graph session for simulator ${device_id}" >&2
  exit 1
fi
set +e
ctrl_proxy_port="$(ctrl_proxy_port_from_acquisition <<< "${session_result}")"
ctrl_proxy_port_status=$?
set -e
if [[ "${ctrl_proxy_port_status}" -ne 0 ]]; then
  echo "error: getApple did not report the CtrlProxy port for simulator ${device_id}" >&2
  exit 1
fi

# The graph query selects the target device's latest observed foreground app.
# Keep the injected SDK events and the following observations scoped to the
# same installed app instead of letting a SpringBoard observation hide them.
for attempt in 1 2 3; do
  if auto-mobile --debug --embedded-sdk --cli --session-uuid "${session_uuid}" launchApp --platform ios --appId "${bundle_id}" --deviceId "${device_id}" > /dev/null; then
    break
  fi
  if [[ "${attempt}" -eq 3 ]]; then
    echo "error: could not launch iOS graph target app after 3 attempts" >&2
    exit 1
  fi
  echo "iOS graph target launch attempt ${attempt} failed; retrying in 2s..." >&2
  sleep 2
done

# Bind the shared CtrlProxy client to this graph session before posting events
# so its SDK-event poller cannot consume them into the global
# NavigationGraphManager.
if ! auto-mobile --debug --embedded-sdk --cli --session-uuid "${session_uuid}" observe --platform ios --deviceId "${device_id}" > /dev/null; then
  echo "error: could not bind iOS SDK events to navigation graph session" >&2
  exit 1
fi

wait_for_ctrl_proxy_health "${ctrl_proxy_port}" "${session_uuid}"

event_payload() {
  local destination="$1"
  jq -cn \
    --argjson timestamp "${timestamp_ms}" \
    --arg destination "${destination}" \
    '{eventType:"navigation", timestamp:$timestamp, destination:$destination, source:"swiftui", arguments:{}, metadata:{}}' \
    | base64 | tr -d '\n'
}

batch="$(
  jq -cn \
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
  "http://127.0.0.1:${ctrl_proxy_port}/sdk-events" > /dev/null

# Refresh the connected CtrlProxy client after injection. `getNavigationGraph`
# reads the daemon's persisted graph but does not itself drain `/sdk-events`, so
# relying on its background poll leaves a race on a busy Simulator runner.
# Query through the public, daemon-backed tool until the batched events appear.
for attempt in 1 2 3 4 5; do
  if ! auto-mobile --debug --embedded-sdk --cli --session-uuid "${session_uuid}" observe --platform ios --deviceId "${device_id}" > /dev/null; then
    echo "observe refresh attempt ${attempt} failed; retrying in 2s..." >&2
    sleep 2
    continue
  fi
  # Scope the read to the fixture bundle. Without --appId the daemon selects the
  # device's latest observed foreground app, so a concurrent hierarchy push that
  # marks com.apple.springboard current makes this assertion read the wrong
  # (empty) graph even though the events reached the fixture app (issue #4579).
  if ! graph="$(auto-mobile --debug --embedded-sdk --cli --session-uuid "${session_uuid}" getNavigationGraph --platform ios --deviceId "${device_id}" --appId "${bundle_id}")"; then
    echo "getNavigationGraph attempt ${attempt} failed; retrying in 2s..." >&2
    sleep 2
    continue
  fi
  if jq -e --arg home "${home_screen}" --arg detail "${detail_screen}" \
    '(if .content? then (.content[] | select(.type == "text").text | fromjson) else . end) as $result
      | ([$result.screens[].name] | index($home)) != null
      and ([$result.screens[].name] | index($detail)) != null' \
    <<< "${graph}" > /dev/null; then
    echo "iOS SDK navigation events reached getNavigationGraph on attempt ${attempt}."
    exit 0
  fi
  sleep 2
done

echo "error: iOS SDK navigation events did not reach getNavigationGraph for app ${bundle_id}" >&2
echo "last graph response: ${graph}" >&2
exit 1
