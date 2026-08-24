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
session_uuid="44600000-0000-4000-8000-000000000000"

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

ctrl_proxy_port_for_device() {
  # CtrlProxy allocates a per-device host port; 8765 is only its preferred
  # default and may already belong to another local service. `doctor` can exit
  # non-zero for unrelated diagnostics, but still emits the JSON round-trip
  # report that contains this ready runner's port.
  local doctor_report ctrl_proxy_port
  doctor_report="$(auto-mobile --cli doctor --ios --json || true)"
  if ! ctrl_proxy_port="$(jq -er --arg device_id "${device_id}" '
      .ios.checks[]
      | select(.name == "iOS Observe Round Trip")
      | .message
      | split(" | ")
      | map(select(contains("device=" + $device_id + ";")))
      | .[0]
      | capture("runnerPort=(?<port>[0-9]+)")
      | .port
    ' <<<"${doctor_report}")"; then
    echo "error: could not determine CtrlProxy port for simulator ${device_id}" >&2
    return 1
  fi
  printf '%s\n' "${ctrl_proxy_port}"
}

wait_for_ctrl_proxy_health() {
  local ctrl_proxy_port="$1"
  local session_uuid="${2:-}"
  local attempt
  for attempt in 1 2 3 4 5; do
    if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${ctrl_proxy_port}/health" >/dev/null; then
      return 0
    fi
    # One-shot CLI clients stop their proxy heartbeat after each public call.
    # Renew the graph session while this bounded runner-health retry is in progress.
    if [[ -n "${session_uuid}" ]] && ! auto-mobile --daemon heartbeat "${session_uuid}" >/dev/null; then
      echo "error: could not renew navigation graph session ownership" >&2
      return 1
    fi
    if [[ "${attempt}" -lt 5 ]]; then
      echo "CtrlProxy health check attempt ${attempt} failed; retrying in 2s..." >&2
      sleep 2
    fi
  done

  echo "error: CtrlProxy health check failed after 5 attempts on port ${ctrl_proxy_port}" >&2
  return 1
}

ctrl_proxy_port="$(ctrl_proxy_port_for_device)"

wait_for_ctrl_proxy_health "${ctrl_proxy_port}"

# The graph query selects the target device's latest observed foreground app.
# Keep the injected SDK events and the following observations scoped to the
# same installed app instead of letting a SpringBoard observation hide them.
for attempt in 1 2 3; do
  if auto-mobile --debug --embedded-sdk --cli --session-uuid "${session_uuid}" launchApp --platform ios --appId "${bundle_id}" --deviceId "${device_id}" >/dev/null; then
    break
  fi
  if [[ "${attempt}" -eq 3 ]]; then
    echo "error: could not launch iOS graph target app after 3 attempts" >&2
    exit 1
  fi
  echo "iOS graph target launch attempt ${attempt} failed; retrying in 2s..." >&2
  sleep 2
done

# `doctor` above may have started the shared CtrlProxy client while it was
# unbound. Bind it to this graph session before posting events so its SDK-event
# poller cannot consume them into the global NavigationGraphManager.
if ! auto-mobile --debug --embedded-sdk --cli --session-uuid "${session_uuid}" observe --platform ios --deviceId "${device_id}" >/dev/null; then
  echo "error: could not bind iOS SDK events to navigation graph session" >&2
  exit 1
fi

# Requesting debug and embedded-SDK tools can restart the daemon. That restart
# creates a new CtrlProxy client, so the prior daemon's reported port is stale.
ctrl_proxy_port="$(ctrl_proxy_port_for_device)"
wait_for_ctrl_proxy_health "${ctrl_proxy_port}" "${session_uuid}"

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
  "http://127.0.0.1:${ctrl_proxy_port}/sdk-events" >/dev/null

# Refresh the connected CtrlProxy client after injection. `getNavigationGraph`
# reads the daemon's persisted graph but does not itself drain `/sdk-events`, so
# relying on its background poll leaves a race on a busy Simulator runner.
# Query through the public, daemon-backed tool until the batched events appear.
for attempt in 1 2 3 4 5; do
  if ! auto-mobile --debug --embedded-sdk --cli --session-uuid "${session_uuid}" observe --platform ios --deviceId "${device_id}" >/dev/null; then
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
    <<<"${graph}" >/dev/null; then
    echo "iOS SDK navigation events reached getNavigationGraph on attempt ${attempt}."
    exit 0
  fi
  sleep 2
done

echo "error: iOS SDK navigation events did not reach getNavigationGraph for app ${bundle_id}" >&2
echo "last graph response: ${graph}" >&2
exit 1
