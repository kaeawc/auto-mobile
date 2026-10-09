#!/usr/bin/env bats

SCRIPT="scripts/ios/navigation-graph-sdk-event-integration.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  export REAL_JQ="$(command -v jq)"
  export GRAPH_ATTEMPTS_FILE="${MOCK_BIN}/graph-attempts"
  export CURL_URL_FILE="${MOCK_BIN}/curl-urls"
  export SESSION_OBSERVE_FILE="${MOCK_BIN}/session-observe"
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

make_release_fixture() {
  export ACQUIRED_SESSION_UUID="86090000-0000-4000-8000-000000000000"
  export RELEASE_LOG="${MOCK_BIN}/release-calls"
  export RELEASE_CALLED_FILE="${MOCK_BIN}/released"
  make_mock xcrun 'exit 0'
  make_mock base64 'cat'
  make_mock sleep 'exit 0'
  make_mock curl 'exit 0'
  make_mock jq '
if [ "$1" = "-er" ] && [[ "$2" == *"iosServicePort"* ]]; then
  if [ "${MISSING_PORT:-0}" = "1" ]; then exit 1; fi
  printf "8768\n"
  exit 0
fi
if [ "$1" = "-er" ]; then exec "$REAL_JQ" "$@"; fi
if [ "$1" = "-cn" ]; then printf "{}\n"; exit 0; fi
if [ "$1" = "-e" ]; then exit 0; fi
exit 0
'
  make_mock auto-mobile '
printf "%s\n" "$*" >> "$INVOCATION_FILE"
if [ "$1" = "--daemon" ] && [ "$2" = "release-session" ]; then
  printf "%s\n" "$3" >> "$RELEASE_LOG"
  [ "$3" = "$ACQUIRED_SESSION_UUID" ] || exit 91
  [ "${AUTOMOBILE_DAEMON_TIMEOUT_MS:-}" = "2000" ] || exit 92
  touch "$RELEASE_CALLED_FILE"
  [ "${RELEASE_FAIL:-0}" = "0" ]
  exit $?
fi
if [ "$1" = "--debug" ] && [ "$2" = "--embedded-sdk" ] && [ "$3" = "--cli" ] && [ "$4" = "getApple" ]; then
  if [ "${ACQUIRE_FAIL:-0}" = "1" ]; then
    printf "{\"sessionUuid\":\"\"}\n"
  else
    printf "{\"sessionUuid\":\"%s\",\"deviceIdentity\":{\"iosServicePort\":8768}}\n" "$ACQUIRED_SESSION_UUID"
  fi
  exit 0
fi
if [ "$1" = "--daemon" ] && [ "$2" = "heartbeat" ]; then exit 0; fi
if [ "$4" = "--session-uuid" ]; then
  [ "$5" = "$ACQUIRED_SESSION_UUID" ] || exit 93
  if [ "$6" = "launchApp" ]; then
    if [ -n "${HOLD_LAUNCH_FILE:-}" ]; then
      touch "${HOLD_LAUNCH_FILE}.started"
      while [ ! -f "$HOLD_LAUNCH_FILE" ]; do /bin/sleep 0.02; done
    fi
    if [ "${LAUNCH_FAIL:-0}" = "1" ]; then exit 23; fi
  fi
  if [ "$6" = "observe" ] && [ "${OBSERVE_FAIL:-0}" = "1" ]; then exit 24; fi
  exit 0
fi
exit 94
'
}

@test "rejects an empty session UUID from getApple" {
  make_mock xcrun 'exit 0'
  make_mock curl 'exit 0'
  make_mock jq '
if [ "$1" = "-er" ]; then
  exec "$REAL_JQ" "$@"
fi
'
  make_mock auto-mobile '
if [ "$1" = "--debug" ] && [ "$2" = "--embedded-sdk" ] && [ "$3" = "--cli" ] && [ "$4" = "getApple" ]; then
  printf "{\"sessionUuid\":\"\"}\n"
  exit 0
fi
'

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 1 ]
  [[ "$output" == *"could not acquire navigation graph session"* ]]
}

@test "releases the acquired iOS session once after launch failures and preserves status" {
  make_release_fixture
  export LAUNCH_FAIL=1

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 1 ]
  [ "$(wc -l < "$RELEASE_LOG" | tr -d ' ')" -eq 1 ]
  [ "$(cat "$RELEASE_LOG")" = "$ACQUIRED_SESSION_UUID" ]
}

@test "releases the acquired iOS session once on success" {
  make_release_fixture

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 0 ]
  [ "$(wc -l < "$RELEASE_LOG" | tr -d ' ')" -eq 1 ]
  [ "$(cat "$RELEASE_LOG")" = "$ACQUIRED_SESSION_UUID" ]
}

@test "does not release when iOS session acquisition fails" {
  make_release_fixture
  export ACQUIRE_FAIL=1

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 1 ]
  [ ! -f "$RELEASE_CALLED_FILE" ]
  [ ! -s "$RELEASE_LOG" ]
}

@test "release failure warns without changing success or failure status" {
  make_release_fixture
  export RELEASE_FAIL=1

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"
  [ "$status" -eq 0 ]
  [[ "$output" == *"warning: could not release session ${ACQUIRED_SESSION_UUID}"* ]]

  export LAUNCH_FAIL=1
  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"
  [ "$status" -eq 1 ]
  [[ "$output" == *"warning: could not release session ${ACQUIRED_SESSION_UUID}"* ]]
}

@test "releases the iOS session once on SIGTERM" {
  make_release_fixture
  export HOLD_LAUNCH_FILE="${MOCK_BIN}/continue-launch"

  env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid" > "${MOCK_BIN}/signal-output" 2>&1 &
  script_pid=$!
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    [ -f "${HOLD_LAUNCH_FILE}.started" ] && break
    /bin/sleep 0.05
  done
  [ -f "${HOLD_LAUNCH_FILE}.started" ]
  kill -TERM "$script_pid"
  touch "$HOLD_LAUNCH_FILE"
  wait "$script_pid" || signal_status=$?

  [ "${signal_status:-0}" -eq 143 ]
  [ "$(wc -l < "$RELEASE_LOG" | tr -d ' ')" -eq 1 ]
  [ "$(cat "$RELEASE_LOG")" = "$ACQUIRED_SESSION_UUID" ]
}

@test "releases after getApple UUID parsing when the CtrlProxy port is missing" {
  make_release_fixture
  export MISSING_PORT=1

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 1 ]
  [ "$(wc -l < "$RELEASE_LOG" | tr -d ' ')" -eq 1 ]
  [ "$(cat "$RELEASE_LOG")" = "$ACQUIRED_SESSION_UUID" ]
}

@test "forwards a legacy iOS graph session UUID" {
  make_mock xcrun 'exit 0'
  make_mock curl 'exit 0'
  make_mock base64 'cat'
  make_mock sleep 'exit 0'
  make_mock jq '
if [ "$1" = "-er" ] && [[ "$2" == *"iosServicePort"* ]]; then
  printf "8768\n"
  exit 0
fi
if [ "$1" = "-er" ]; then
  exec "$REAL_JQ" "$@"
fi
if [ "$1" = "-cn" ]; then
  printf "{}\n"
  exit 0
fi
exit 0
'
  make_mock auto-mobile '
printf "%s\n" "$*" >> "$INVOCATION_FILE"
if [ "$4" = "getApple" ]; then
  printf "{\"sessionUuid\":\"legacy-ios-session\"}\n"
  exit 0
fi
if [ "$1" = "--daemon" ]; then
  [ "$3" = "legacy-ios-session" ] || exit 1
  exit 0
fi
if [ "$4" = "--session-uuid" ]; then
  [ "$5" = "legacy-ios-session" ] || exit 1
  exit 0
fi
exit 1
'

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 0 ]
  grep -q -- "--session-uuid legacy-ios-session" "$INVOCATION_FILE"
}

@test "retries post-bind CtrlProxy health without a heartbeat keeper" {
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
  exec "$REAL_JQ" "$@"
fi
exit 0
'
  make_mock auto-mobile '
printf "%s\n" "$*" >> "$INVOCATION_FILE"
if [ "$1" = "--debug" ] && [ "$2" = "--embedded-sdk" ] && [ "$3" = "--cli" ] && [ "$4" = "getApple" ] && [ "$5" = "--deviceId" ] && [ "$6" = "simulator-udid" ]; then
  printf "{\"runtime\":{\"session\":{\"sessionUuid\":\"44600000-0000-4000-8000-000000000000\"}},\"deviceIdentity\":{\"iosServicePort\":8768}}\\n"
  exit 0
fi
if [ "$1" = "--daemon" ] && [ "$2" = "heartbeat" ] && [ "$3" = "44600000-0000-4000-8000-000000000000" ]; then
  if [ ! -f "$SESSION_OBSERVE_FILE" ]; then
    echo "session heartbeat ran before the graph session was bound" >&2
    exit 1
  fi
  if [ "${AUTOMOBILE_DAEMON_TIMEOUT_MS:-}" != "2000" ]; then
    echo "session heartbeat did not use the bounded daemon timeout" >&2
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
  [ "$(cat "$HEALTH_ATTEMPTS_FILE")" = "2" ]
  # #11096: a one-shot CLI session needs no keeper, so the script never heartbeats.
  [ ! -f "$HEARTBEAT_FILE" ]
  [ "$(grep -c -- "--daemon heartbeat" "$INVOCATION_FILE")" = "0" ]
  [ -f "$TARGET_APP_LAUNCHED_FILE" ]
  [[ "$output" == *"getNavigationGraph attempt 1 failed"* ]]
  [ "$(grep -c -- "--cli getApple --deviceId simulator-udid" "$INVOCATION_FILE")" = "1" ]
  run grep -q -- "--cli doctor" "$INVOCATION_FILE"
  [ "$status" -eq 1 ]
  # Regression for issue #4579: the graph read must be scoped to the fixture
  # bundle so a concurrent SpringBoard hierarchy push cannot redirect the query.
  grep -q -- "getNavigationGraph --platform ios --deviceId simulator-udid --appId com.apple.reminders" "$INVOCATION_FILE"
  launch_line="$(grep -n -- "launchApp --platform ios --appId com.apple.reminders --deviceId simulator-udid" "$INVOCATION_FILE" | head -n 1 | cut -d: -f1)"
  observe_line="$(grep -n -- "observe --platform ios --deviceId simulator-udid" "$INVOCATION_FILE" | head -n 1 | cut -d: -f1)"
  [ "$launch_line" -lt "$observe_line" ]
  grep -qx "http://127.0.0.1:8768/health" "$CURL_URL_FILE"
  grep -qx "http://127.0.0.1:8768/sdk-events" "$CURL_URL_FILE"
}
