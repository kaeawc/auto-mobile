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
# Fake AutoMobile entry point: `--daemon <command>` or the stdio MCP proxy. Each held emulator
# has a directory of facts under state/<serial>/.
state="${FAKE}/state"
now() { cat "${FAKE}/clock"; }
idle_ms="${AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS:-120000}"

release() {
  rm -rf "${state:?}/$1"
  printf '%s %s %s\n' "$(now)" "$2" "$1" >> "${FAKE}/releases"
}

session_for() {
  if [[ "$1" == emulator-5560 ]]; then
    printf '%s\n' "${FAKE_SESSION_UUID}"
  else
    printf '%s\n' "${FAKE_SESSION_UUID}-$1"
  fi
}

device_for_session() {
  local dir
  for dir in "${state}"/emulator-*; do
    if [[ -f "${dir}/session" && "$(cat "${dir}/session")" == "$1" ]]; then
      basename "${dir}"
      return 0
    fi
  done
  return 0
}

scan_device() {
  local dev="$1" t pid dir="${state}/$1"
  t="$(now)"
  pid="$(cat "${dir}/proxy_pid")"
  if ! kill -0 "${pid}" 2> /dev/null; then
    release "${dev}" owner-disconnected
    return
  elif [[ "$(ps -o stat= -p "${pid}" 2> /dev/null)" == *T* ]]; then
    [[ -f "${dir}/stopped_since" ]] || printf '%s\n' "${t}" > "${dir}/stopped_since"
    if ((t - $(cat "${dir}/stopped_since") >= ${FAKE_NO_HB_RELEASE_MS:-8000})); then
      release "${dev}" heartbeat-timeout
      return
    fi
  else
    rm -f "${dir}/stopped_since"
    printf '%s\n' "${t}" > "${dir}/last_beat"
    if [[ "${FAKE_HEARTBEAT_COUNTS_AS_USE:-0}" == 1 ]]; then
      printf '%s\n' "${t}" > "${dir}/last_tool"
    fi
  fi
  if [[ "${FAKE_NEVER_IDLE_RELEASE:-0}" != 1 ]] && ((t > $(cat "${dir}/last_tool") + idle_ms + 4000)); then
    release "${dev}" cleanup-expired
  elif [[ -n "${FAKE_RELEASE_AFTER_MS:-}" ]] && ((t - $(cat "${dir}/acquired") >= FAKE_RELEASE_AFTER_MS)); then
    release "${dev}" bug
  fi
}

active_sessions() {
  local dir dev entries=()
  for dir in "${state}"/emulator-*; do
    [[ -d "${dir}" && -f "${dir}/session" ]] || continue
    scan_device "$(basename "${dir}")"
  done
  for dir in "${state}"/emulator-*; do
    [[ -d "${dir}" && -f "${dir}/session" ]] || continue
    dev="$(basename "${dir}")"
    entries+=("$(jq -cn --arg id "$(cat "${dir}/session")" --arg dev "${dev}" \
      --argjson tool "$(cat "${dir}/last_tool")" --argjson beat "$(cat "${dir}/last_beat")" \
      --argjson idle "${idle_ms}" --arg kind "${FAKE_HOLDER_KIND:-stdio-proxy}" \
      '{sessionId: $id, assignedDevice: $dev, platform: "android", lastToolActivityAt: $tool,
        lastOwnerHeartbeatAt: $beat, idleReleaseAt: ($tool + $idle + 4000),
        holderKind: $kind, activeExecutions: 0}')")
  done
  if ((${#entries[@]} == 0)); then
    printf '%s\n' '{"activeSessions":0,"activeExecutions":0,"sessions":[]}'
  else
    printf '%s\n' "${entries[@]}" | jq -cs '{activeSessions: length, activeExecutions: 0, sessions: .}'
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
printf '%s\n' "$$" > "${state}/proxy_pid"
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
  target=""
  session_arg="$(jq -r '.params.arguments.sessionUuid // empty' <<< "${line}")"
  if [[ "${tool}" == getAndroid || "${tool}" == provisionDevice ]]; then
    target="$(jq -r '.params.arguments.deviceId' <<< "${line}")"
    mkdir -p "${state}/${target}"
    session_for "${target}" > "${state}/${target}/session"
    printf '%s\n' "$$" > "${state}/${target}/proxy_pid"
    now > "${state}/${target}/acquired"
    now > "${state}/${target}/last_beat"
  elif [[ -n "${session_arg}" ]]; then
    target="$(device_for_session "${session_arg}")"
  elif [[ "${FAKE_SELECTOR_NOT_CREDITED:-0}" != 1 ]]; then
    target="$(jq -r '.params.arguments.deviceId // empty' <<< "${line}")"
  fi
  # No read counts as activity (#10964); FAKE_READS_COUNT_AS_USE models the old daemon.
  if [[ "${tool}" == observe && "${FAKE_READS_COUNT_AS_USE:-0}" != 1 ]]; then
    target=""
  fi
  if [[ -n "${target}" && -d "${state}/${target}" ]]; then
    # A tool call takes a millisecond of virtual time, so successive calls are distinguishable.
    printf '%s\n' "$(($(now) + 1))" > "${FAKE}/clock"
    now > "${state}/${target}/last_tool"
  fi
  reply "${id}" '{"content":[{"type":"text","text":"ok"}]}'
done
EOF

  cat > "${FAKE}/nc" <<'EOF'
#!/usr/bin/env bash
# Fake `nc -U`: acknowledge the subscription, then stay open until stdin closes.
printf '%s\n' "$*" >> "${FAKE}/nc.calls"
IFS= read -r request || exit 0
printf '%s\n' "${request}" >> "${FAKE}/nc.requests"
if [[ "${request}" != *'"sessionUuid":"'* ]]; then
  printf '%s\n' '{"id":"1","type":"error","success":false,"error":"observationStream requires an authenticated daemon session."}'
  exit 0
fi
printf '%s\n' '{"id":"1","type":"subscription_response","success":true,"subscriptionId":"devicedatastream-1"}'
if [[ "${FAKE_STREAM_ENDED:-0}" == 1 ]]; then
  printf '%s\n' '{"type":"device_session_ended","deviceId":"emulator-5560"}'
fi
cat > /dev/null
EOF
  chmod +x "${FAKE}/now" "${FAKE}/sleep" "${FAKE}/adb" "${FAKE}/bun" "${FAKE}/nc"

  export FAKE_SESSION_UUID="${SESSION_UUID}"
  export AUTOMOBILE_IDLE_CHECK_BUN="${FAKE}/bun"
  export AUTOMOBILE_IDLE_CHECK_ADB="${FAKE}/adb"
  export AUTOMOBILE_IDLE_CHECK_SLEEP="${FAKE}/sleep"
  export AUTOMOBILE_IDLE_CHECK_NOW="${FAKE}/now"
  export AUTOMOBILE_IDLE_CHECK_NC="${FAKE}/nc"
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
  [[ "${output}" == *"PASS stdin-eof"* ]]
  [[ "${output}" == *"PASS selector"* ]]
  [[ "${output}" == *"PASS observe-only"* ]]
  [[ "${output}" == *"PASS stream"* ]]
  # two-devices needs --second-serial and is not part of the default sweep.
  [[ "${output}" != *"two-devices"* ]]

  # Each scenario released the device the way it should.
  run cut -d' ' -f2 "${FAKE}/releases"
  [ "${output}" = "$(printf 'owner-disconnected\nheartbeat-timeout\ncleanup-expired\nowner-disconnected\nowner-disconnected\ncleanup-expired\ncleanup-expired')" ]

  # A fully private daemon on the explicit port, with the short idle window.
  grep -qx "AUTOMOBILE_DAEMON_SOCKET_PATH=${WORK}/d.sock" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_AUX_SOCKET_DIR=${WORK}" "${FAKE}/daemon.env"
  grep -qx "AUTOMOBILE_HARNESS_PRIVATE_DAEMON=1" "${FAKE}/daemon.env"
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

  # The device is acquired by serial and driven by control calls with the session the daemon
  # reported; only the observe-only scenario reads.
  grep -qx 'getAndroid {"deviceId":"emulator-5560"}' "${FAKE}/tool.calls"
  grep -qx "homeScreen {\"sessionUuid\":\"${SESSION_UUID}\"}" "${FAKE}/tool.calls"
  grep -qx 'observe {"deviceId":"emulator-5560"}' "${FAKE}/tool.calls"

  # Ground truth and evidence for every scenario.
  [ "$(grep -c 'get-state' "${FAKE}/adb.calls")" -eq 8 ]
  for scenario in active no-heartbeat idle stdin-eof selector observe-only stream; do
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

@test "stdin-eof: the proxy exits on its own and the device is released" {
  run_check --scenario stdin-eof
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS stdin-eof"* ]]
  run cut -d' ' -f2 "${FAKE}/releases"
  [ "${output}" = "owner-disconnected" ]
}

@test "selector: deviceId-only calls hold the device past the idle window" {
  run_check --scenario selector
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS selector"* ]]
  grep -qx 'homeScreen {"deviceId":"emulator-5560"}' "${FAKE}/tool.calls"
}

@test "selector: fails when deviceId-only calls are not credited to the session" {
  FAKE_SELECTOR_NOT_CREDITED=1 run_check --scenario selector
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL selector"* ]]
}

@test "observe-only: an owner that only observes loses the device at the idle window" {
  run_check --scenario observe-only
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS observe-only"* ]]
  grep -qx 'observe {"deviceId":"emulator-5560"}' "${FAKE}/tool.calls"
  run cut -d' ' -f2 "${FAKE}/releases"
  [ "${output}" = "cleanup-expired" ]
}

@test "observe-only: fails when a read counts as use" {
  FAKE_READS_COUNT_AS_USE=1 run_check --scenario observe-only
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL observe-only"*"a read must not count as use"* ]]
}

@test "all: a failing scenario does not hide the scenarios after it" {
  FAKE_SELECTOR_NOT_CREDITED=1 run_check --scenario all
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"PASS idle"* ]]
  [[ "${output}" == *"FAIL selector"* ]]
  [[ "${output}" == *"PASS stream"* ]]
  [[ "${output}" == *"FAILED scenarios: selector"* ]]
  [[ "${output}" != *"all requested scenarios passed"* ]]
  grep -qx -- "--daemon stop --port 3920 --strict-port" "${FAKE}/daemon.calls"
}

@test "provision: a provisionDevice session is driven by deviceId and stays held" {
  run_check --scenario provision
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS provision"* ]]
  grep -qx 'provisionDevice {"deviceId":"emulator-5560"}' "${FAKE}/tool.calls"
}

@test "stream: the subscription survives the idle release and frames are kept as evidence" {
  run_check --scenario stream
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS stream"* ]]
  grep -q '"command":"subscribe"' "${FAKE}/nc.requests"
  grep -q "\"sessionUuid\":\"${SESSION_UUID}\"" "${FAKE}/nc.requests"
  grep -q subscription_response "${EVIDENCE}/stream.stream.frames"
}

@test "stream: fails when the idle release pushes device_session_ended" {
  FAKE_STREAM_ENDED=1 run_check --scenario stream
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"device_session_ended"* ]]
}

@test "two-devices: A goes at its own idle deadline while B stays held" {
  run_check --scenario two-devices --second-serial emulator-5562
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS two-devices"* ]]
  run cut -d' ' -f2- "${FAKE}/releases"
  [ "${output}" = "$(printf 'cleanup-expired emulator-5560\nowner-disconnected emulator-5562')" ]
}

@test "two-devices: fails when B is released while it is in use" {
  FAKE_RELEASE_AFTER_MS=8000 run_check --scenario two-devices --second-serial emulator-5562
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL two-devices"* ]]
}

@test "two-devices needs a different emulator as --second-serial" {
  run_check --scenario two-devices
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--second-serial"* ]]
  run_check --scenario two-devices --second-serial emulator-5560
  [ "${status}" -eq 2 ]
}
