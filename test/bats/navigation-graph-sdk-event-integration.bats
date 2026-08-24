#!/usr/bin/env bats

SCRIPT="scripts/ios/navigation-graph-sdk-event-integration.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  export GRAPH_ATTEMPTS_FILE="${MOCK_BIN}/graph-attempts"
  export CURL_URL_FILE="${MOCK_BIN}/curl-urls"
  export SESSION_OBSERVE_FILE="${MOCK_BIN}/session-observe"
  export DOCTOR_CALLS_FILE="${MOCK_BIN}/doctor-calls"
  export HEALTH_ATTEMPTS_FILE="${MOCK_BIN}/health-attempts"
  export HEARTBEAT_FILE="${MOCK_BIN}/heartbeats"
  export TARGET_APP_LAUNCHED_FILE="${MOCK_BIN}/target-app-launched"
  export INVOCATION_FILE="${MOCK_BIN}/invocations"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

make_mock() {
  local name="$1"
  local body="$2"
  cat > "${MOCK_BIN}/${name}" <<SCRIPT
#!/usr/bin/env bash
${body}
SCRIPT
  chmod +x "${MOCK_BIN}/${name}"
}

@test "renews the graph session while retrying post-bind CtrlProxy health" {
  make_mock xcrun 'exit 0'
  make_mock curl '
url="${!#}"
if [[ "$url" == */health ]]; then
  health_attempts=0
  [ -f "$HEALTH_ATTEMPTS_FILE" ] && health_attempts="$(cat "$HEALTH_ATTEMPTS_FILE")"
  health_attempts=$((health_attempts + 1))
  printf "%s\\n" "$health_attempts" > "$HEALTH_ATTEMPTS_FILE"
  if [ "$health_attempts" -eq 1 ] || { [ -f "$SESSION_OBSERVE_FILE" ] && [ "$health_attempts" -eq 3 ]; }; then
    exit 1
  fi
fi
if [[ "$url" == */sdk-events ]] && [[ ! -f "$SESSION_OBSERVE_FILE" ]]; then
  echo "SDK events were posted before the graph session was bound" >&2
  exit 1
fi
printf "%s\\n" "$url" >> "$CURL_URL_FILE"
'
  make_mock base64 'cat'
  make_mock sleep 'exit 0'
  make_mock jq '
if [ "$1" = "-cn" ]; then
  printf "{}\\n"
  exit 0
fi
if [ "$1" = "-er" ]; then
  doctor_calls="$(cat "$DOCTOR_CALLS_FILE")"
  if [ "$doctor_calls" -eq 1 ]; then
    printf "8768\\n"
  else
    printf "8769\\n"
  fi
  exit 0
fi
exit 0
'
  make_mock auto-mobile '
printf "%s\n" "$*" >> "$INVOCATION_FILE"
if [ "$1" = "--cli" ] && [ "$2" = "doctor" ]; then
  doctor_calls=0
  [ -f "$DOCTOR_CALLS_FILE" ] && doctor_calls="$(cat "$DOCTOR_CALLS_FILE")"
  printf "%s\\n" "$((doctor_calls + 1))" > "$DOCTOR_CALLS_FILE"
  printf "{\"ios\":{\"checks\":[]}}\\n"
  exit 0
fi
if [ "$1" = "--daemon" ] && [ "$2" = "heartbeat" ] && [ "$3" = "44600000-0000-4000-8000-000000000000" ]; then
  if [ ! -f "$SESSION_OBSERVE_FILE" ]; then
    echo "session heartbeat ran before the graph session was bound" >&2
    exit 1
  fi
  touch "$HEARTBEAT_FILE"
  exit 0
fi
if [ "$1" = "--debug" ] && [ "$2" = "--embedded-sdk" ] && [ "$3" = "--cli" ] && [ "$4" = "--session-uuid" ] && [ "$6" = "launchApp" ]; then
  if [ "$7" != "--platform" ] || [ "$8" != "ios" ] || [ "$9" != "--appId" ] || [ "${10}" != "com.apple.reminders" ] || [ "${11}" != "--deviceId" ] || [ "${12}" != "simulator-udid" ]; then
    echo "unexpected target app launch arguments: $*" >&2
    exit 1
  fi
  touch "$TARGET_APP_LAUNCHED_FILE"
  exit 0
fi
if [ "$1" = "--debug" ] && [ "$2" = "--embedded-sdk" ] && [ "$3" = "--cli" ] && [ "$4" = "--session-uuid" ] && [ "$6" = "observe" ]; then
  if [ ! -f "$TARGET_APP_LAUNCHED_FILE" ]; then
    echo "graph session was bound before its target app launched" >&2
    exit 1
  fi
  touch "$SESSION_OBSERVE_FILE"
  exit 0
fi
if [ "$1" = "--debug" ] && [ "$2" = "--embedded-sdk" ] && [ "$3" = "--cli" ] && [ "$4" = "--session-uuid" ] && [ "$6" = "getNavigationGraph" ]; then
  attempts=0
  [ -f "$GRAPH_ATTEMPTS_FILE" ] && attempts="$(cat "$GRAPH_ATTEMPTS_FILE")"
  attempts=$((attempts + 1))
  printf "%s\\n" "$attempts" > "$GRAPH_ATTEMPTS_FILE"
  if [ "$attempts" -eq 1 ]; then
    exit 1
  fi
  printf "{}\\n"
fi
'

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 0 ]
  [ "$(cat "$GRAPH_ATTEMPTS_FILE")" = "2" ]
  [ "$(cat "$DOCTOR_CALLS_FILE")" = "2" ]
  [ "$(cat "$HEALTH_ATTEMPTS_FILE")" = "4" ]
  [ -f "$HEARTBEAT_FILE" ]
  [ -f "$TARGET_APP_LAUNCHED_FILE" ]
  [[ "$output" == *"getNavigationGraph attempt 1 failed"* ]]
  # Regression for issue #4579: the graph read must be scoped to the fixture
  # bundle so a concurrent SpringBoard hierarchy push cannot redirect the query.
  grep -q -- "getNavigationGraph --platform ios --deviceId simulator-udid --appId com.apple.reminders" "$INVOCATION_FILE"
  launch_line="$(grep -n -- "launchApp --platform ios --appId com.apple.reminders --deviceId simulator-udid" "$INVOCATION_FILE" | head -n 1 | cut -d: -f1)"
  observe_line="$(grep -n -- "observe --platform ios --deviceId simulator-udid" "$INVOCATION_FILE" | head -n 1 | cut -d: -f1)"
  [ "$launch_line" -lt "$observe_line" ]
  grep -qx "http://127.0.0.1:8769/health" "$CURL_URL_FILE"
  grep -qx "http://127.0.0.1:8769/sdk-events" "$CURL_URL_FILE"
}
