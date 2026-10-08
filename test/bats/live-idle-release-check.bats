#!/usr/bin/env bats
#
# Tests for scripts/live-idle-release-check.sh (#10671).
#
# No daemon, emulator or adb is used. A fake `bun` plays both the stdio MCP proxy
# and the `--daemon` CLI over a small file-backed model of the daemon's release
# rules; fake `sleep` and clock commands advance a virtual clock, so the windows
# under test (seconds of wall time) run instantly.

SCRIPT="scripts/live-idle-release-check.sh"
SESSION_UUID="00000000-0000-4000-8000-000000010671"

setup() {
  FAKE="$(mktemp -d /tmp/am-idle-bats.XXXXXX)"
  WORK="${FAKE}/w"
  EVIDENCE="${FAKE}/evidence"
  mkdir -p "${FAKE}/state"
  printf '%s\n' 1000000 > "${FAKE}/clock"
  : > "${FAKE}/index.js"
  export FAKE

  cat > "${FAKE}/now" <<'EOF'
#!/usr/bin/env bash
cat "${FAKE}/clock"
EOF

  cat > "${FAKE}/sleep" <<'EOF'
#!/usr/bin/env bash
# Advance the virtual clock; yield briefly so the fake proxy can react.
now="$(cat "${FAKE}/clock")"
printf '%s\n' "$((now + $1 * 1000))" > "${FAKE}/clock"
command sleep 0.01
EOF

  cat > "${FAKE}/adb" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE}/adb.calls"
if [[ "$1" == "-s" && "$3" == "get-state" ]]; then
  printf '%s\n' "${FAKE_ADB_STATE:-device}"
  exit 0
fi
exit 1
EOF

  cat > "${FAKE}/bun" <<'EOF'
#!/usr/bin/env bash
# Fake AutoMobile entry point: `--daemon <command>` or the stdio MCP proxy.
state="${FAKE}/state"
now() { cat "${FAKE}/clock"; }
idle_ms="${AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS:-120000}"

release() {
  rm -f "${state}/session" "${state}/stopped_since"
  printf '%s %s\n' "$(now)" "$1" >> "${FAKE}/releases"
}

active_sessions() {
  local t pid
  t="$(now)"
  if [[ -f "${state}/session" ]]; then
    pid="$(cat "${state}/proxy_pid")"
    if ! kill -0 "${pid}" 2> /dev/null; then
      release owner-disconnected
    elif [[ "$(ps -o stat= -p "${pid}" 2> /dev/null)" == *T* ]]; then
      [[ -f "${state}/stopped_since" ]] || printf '%s\n' "${t}" > "${state}/stopped_since"
      if ((t - $(cat "${state}/stopped_since") >= ${FAKE_NO_HB_RELEASE_MS:-8000})); then
        release heartbeat-timeout
      fi
    else
      rm -f "${state}/stopped_since"
      printf '%s\n' "${t}" > "${state}/last_beat"
      if [[ "${FAKE_HEARTBEAT_COUNTS_AS_USE:-0}" == 1 ]]; then
        printf '%s\n' "${t}" > "${state}/last_tool"
      fi
    fi
  fi
  if [[ -f "${state}/session" ]]; then
    local last_tool acquired
    last_tool="$(cat "${state}/last_tool")"
    acquired="$(cat "${state}/acquired")"
    if [[ "${FAKE_NEVER_IDLE_RELEASE:-0}" != 1 ]] && ((t > last_tool + idle_ms + 4000)); then
      release cleanup-expired
    elif [[ -n "${FAKE_RELEASE_AFTER_MS:-}" ]] && ((t - acquired >= FAKE_RELEASE_AFTER_MS)); then
      release bug
    fi
  fi
  if [[ -f "${state}/session" ]]; then
    jq -cn --arg id "$(cat "${state}/session")" --argjson tool "$(cat "${state}/last_tool")" \
      --argjson beat "$(cat "${state}/last_beat")" --argjson idle "${idle_ms}" \
      --arg kind "${FAKE_HOLDER_KIND:-stdio-proxy}" \
      '{activeSessions: 1, activeExecutions: 0, sessions: [{sessionId: $id,
        assignedDevice: "emulator-5560", platform: "android", lastToolActivityAt: $tool,
        lastOwnerHeartbeatAt: $beat, idleReleaseAt: ($tool + $idle + 4000),
        holderKind: $kind, activeExecutions: 0}]}'
  else
    printf '%s\n' '{"activeSessions":0,"activeExecutions":0,"sessions":[]}'
  fi
}

if [[ "$2" == "--daemon" ]]; then
  printf '%s\n' "${*:2}" >> "${FAKE}/daemon.calls"
  case "$3" in
    start)
      env | grep -E '^(AUTOMOBILE|AUTO_MOBILE)_' | sort > "${FAKE}/daemon.env"
      ;;
    stop) ;;
    active-sessions) active_sessions ;;
    *) exit 1 ;;
  esac
  exit 0
fi

# stdio MCP proxy
printf '%s\n' "${*:2}" >> "${FAKE}/proxy.calls"
reply() {
  jq -cn --argjson id "$1" --argjson result "$2" '{jsonrpc: "2.0", id: $id, result: $result}'
}
while IFS= read -r line; do
  id="$(jq -r '.id // empty' <<< "${line}")"
  [[ -n "${id}" ]] || continue
  method="$(jq -r '.method' <<< "${line}")"
  if [[ "${method}" == initialize ]]; then
    reply "${id}" '{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"0"}}'
    continue
  fi
  tool="$(jq -r '.params.name' <<< "${line}")"
  printf '%s %s\n' "${tool}" "$(jq -c '.params.arguments' <<< "${line}")" >> "${FAKE}/tool.calls"
  if [[ "${tool}" == getAndroid ]]; then
    printf '%s\n' "${FAKE_SESSION_UUID}" > "${state}/session"
    printf '%s\n' "$$" > "${state}/proxy_pid"
    now > "${state}/acquired"
    now > "${state}/last_beat"
  fi
  now > "${state}/last_tool"
  reply "${id}" '{"content":[{"type":"text","text":"ok"}]}'
done
EOF
  chmod +x "${FAKE}/now" "${FAKE}/sleep" "${FAKE}/adb" "${FAKE}/bun"

  export FAKE_SESSION_UUID="${SESSION_UUID}"
  export AUTOMOBILE_IDLE_CHECK_BUN="${FAKE}/bun"
  export AUTOMOBILE_IDLE_CHECK_ADB="${FAKE}/adb"
  export AUTOMOBILE_IDLE_CHECK_SLEEP="${FAKE}/sleep"
  export AUTOMOBILE_IDLE_CHECK_NOW="${FAKE}/now"
}

teardown() {
  # Only the fake proxies this test started; never any other process.
  if [[ -f "${FAKE}/state/proxy_pid" ]]; then
    kill -CONT "$(cat "${FAKE}/state/proxy_pid")" 2> /dev/null || true
    kill "$(cat "${FAKE}/state/proxy_pid")" 2> /dev/null || true
  fi
  rm -rf "${FAKE}"
}

run_check() {
  run bash "${SCRIPT}" --confirm-live --serial emulator-5560 --port 3920 \
    --idle-timeout-ms 16000 --active-ms 20000 --call-interval-ms 5000 --slack-ms 5000 \
    --server "${FAKE}/index.js" --work-dir "${WORK}" --evidence-dir "${EVIDENCE}" "$@"
}

@test "script is executable and passes help" {
  [ -x "${SCRIPT}" ]
  run bash "${SCRIPT}" --help
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"--confirm-live"* ]]
}

@test "refuses to run without --confirm-live and touches nothing" {
  run bash "${SCRIPT}" --serial emulator-5560 --port 3920 --server "${FAKE}/index.js"
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--confirm-live"* ]]
  [ ! -e "${FAKE}/daemon.calls" ]
  [ ! -e "${FAKE}/adb.calls" ]
}

@test "refuses a serial that is not an emulator" {
  run_check --serial 57281FDCH00462
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"emulator serial"* ]]
  [ ! -e "${FAKE}/daemon.calls" ]
}

@test "refuses the resident daemon's port range" {
  run_check --port 3000
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"3000-3010"* ]]
  [ ! -e "${FAKE}/daemon.calls" ]
}

@test "refuses an idle window too short to tell idle from no-heartbeat release" {
  run_check --idle-timeout-ms 15000
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"must exceed 15000"* ]]
}

@test "refuses an emulator adb does not see online" {
  FAKE_ADB_STATE=offline run_check
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"not an online adb device"* ]]
  [ ! -e "${FAKE}/daemon.calls" ]
}

@test "passes all scenarios against a daemon that keeps the release windows" {
  export AUTOMOBILE_DB_PATH=/resident/auto-mobile.db
  export AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS=3600000
  export AUTOMOBILE_DAEMON_SOCKET_PATH=/resident/auto-mobile-daemon.sock
  run_check
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS active"* ]]
  [[ "${output}" == *"PASS no-heartbeat"* ]]
  [[ "${output}" == *"PASS idle"* ]]

  # Each scenario released the device the way it should.
  run cut -d' ' -f2 "${FAKE}/releases"
  [ "${output}" = "$(printf 'owner-disconnected\nheartbeat-timeout\ncleanup-expired')" ]

  # A fully private daemon on the explicit port, with the short idle window.
  grep -qx "AUTOMOBILE_DAEMON_SOCKET_PATH=${WORK}/d.sock" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_AUX_SOCKET_DIR=${WORK}" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_DATA_DIR=${WORK}/data" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_LOG_DIR=${WORK}/logs" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_DB_DIR=${WORK}/db" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_COORDINATION_DIR=${WORK}/coord" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS=16000" "${FAKE}/daemon.env"
  run grep -E '^AUTOMOBILE_(DB_PATH|SESSION_HEARTBEAT_TIMEOUT_MS)=' "${FAKE}/daemon.env"
  [ "${status}" -eq 1 ]
  grep -qx -- "--daemon start --port 3920 --strict-port" "${FAKE}/daemon.calls"
  grep -qx -- "--daemon stop --port 3920 --strict-port" "${FAKE}/daemon.calls"
  run sort -u "${FAKE}/proxy.calls"
  [ "${output}" = "--port 3920 --strict-port" ]

  # The device is acquired by serial and observed with the session the daemon reported.
  grep -qx 'getAndroid {"deviceId":"emulator-5560"}' "${FAKE}/tool.calls"
  grep -qx "observe {\"sessionUuid\":\"${SESSION_UUID}\"}" "${FAKE}/tool.calls"

  # Ground truth and evidence for every scenario.
  [ "$(grep -c 'get-state' "${FAKE}/adb.calls")" -eq 4 ]
  for scenario in active no-heartbeat idle; do
    [ -s "${EVIDENCE}/${scenario}.sessions.log" ]
  done
}

@test "fails the active scenario when the device is released while in use" {
  FAKE_RELEASE_AFTER_MS=8000 run_check --scenario active
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL active"*"while the proxy heartbeated and called tools"* ]]
  grep -qx -- "--daemon stop --port 3920 --strict-port" "${FAKE}/daemon.calls"
  [ -d "${WORK}" ]
}

@test "fails the no-heartbeat scenario when release takes longer than about 10 s" {
  FAKE_NO_HB_RELEASE_MS=30000 run_check --scenario no-heartbeat
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL no-heartbeat"*"after heartbeats stopped"* ]]
}

@test "fails the idle scenario when a heartbeating session is never idle-released" {
  FAKE_NEVER_IDLE_RELEASE=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL idle"*"still held after the 16000 ms idle window"* ]]
}

@test "fails the idle scenario when heartbeats count as tool use" {
  FAKE_HEARTBEAT_COUNTS_AS_USE=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL idle"*"heartbeats moved lastToolActivityAt"* ]]
}

@test "fails when the holder is not reported as the stdio proxy" {
  FAKE_HOLDER_KIND=unknown run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"holderKind unknown, expected stdio-proxy"* ]]
}
