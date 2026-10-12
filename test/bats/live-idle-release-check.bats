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
if [[ "$1" == "-s" && "$3 $4 $5" == "emu avd name" ]]; then
  printf '%s\r\nOK\r\n' "${FAKE_AVD_NAME:-Pixel_9_API_36}"
  exit 0
fi
exit 1
EOF

  mkdir -p "${FAKE}/avd/Pixel_9_API_36.avd"
  printf '%s\n' 'AvdId=Pixel_9_API_36' 'hw.device.name = pixel_9' \
    'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/' \
    > "${FAKE}/avd/Pixel_9_API_36.avd/config.ini"
  export ANDROID_AVD_HOME="${FAKE}/avd"

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
      release "${dev}" "${FAKE_HEARTBEAT_RELEASE_REASON:-heartbeat-timeout}"
      return
    fi
  else
    rm -f "${dir}/stopped_since"
    printf '%s\n' "${t}" > "${dir}/last_beat"
    if [[ "${FAKE_HEARTBEAT_COUNTS_AS_USE:-0}" == 1 ]]; then
      printf '%s\n' "${t}" > "${dir}/last_tool"
    fi
  fi
  if [[ "${FAKE_NEVER_IDLE_RELEASE:-0}" != 1 ]] && ((t > $(cat "${dir}/last_tool") + idle_ms + ${FAKE_IDLE_RELEASE_LAG_MS:-2000})); then
    release "${dev}" "${FAKE_IDLE_RELEASE_REASON:-cleanup-expired}"
  elif [[ -n "${FAKE_RELEASE_AFTER_MS:-}" ]] && ((t - $(cat "${dir}/acquired") >= FAKE_RELEASE_AFTER_MS)); then
    release "${dev}" bug
  fi
}

active_sessions() {
  local dir dev entries=() jitter
  for dir in "${state}"/emulator-*; do
    [[ -d "${dir}" && -f "${dir}/session" ]] || continue
    scan_device "$(basename "${dir}")"
  done
  for dir in "${state}"/emulator-*; do
    [[ -d "${dir}" && -f "${dir}/session" ]] || continue
    dev="$(basename "${dir}")"
    # FAKE_ACTIVITY_JITTER_MS: once the session has idled 8 s, the unmoved lastToolActivityAt reads
    # back that many ms earlier, as the daemon's wall/monotonic conversion does (#11368).
    jitter=0
    if (($(cat "${dir}/last_beat") - $(cat "${dir}/last_tool") >= 8000)); then
      jitter=$((-${FAKE_ACTIVITY_JITTER_MS:-0}))
    fi
    entries+=("$(jq -cn --arg id "$(cat "${dir}/session")" --arg dev "${dev}" \
      --argjson tool "$(($(cat "${dir}/last_tool") + jitter))" --argjson beat "$(cat "${dir}/last_beat")" \
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
      [[ "${FAKE_DAEMON_START_FAIL:-0}" != 1 ]] || exit 1
      env | grep -E '^(AUTOMOBILE|AUTO_MOBILE)_' | sort > "${FAKE}/daemon.env"
      ;;
    stop) ;;
    session-info)
      for arg in "$@"; do
        [[ "${arg}" != --port && "${arg}" != --strict-port ]] || exit 2
      done
      session="$4"
      calls=0
      [[ ! -f "${FAKE}/session-info.calls" ]] || calls="$(cat "${FAKE}/session-info.calls")"
      calls=$((calls + 1))
      printf '%s\n' "${calls}" > "${FAKE}/session-info.calls"
      device="$(device_for_session "${session}")"
      if ((calls <= ${FAKE_SESSION_INFO_TRANSIENT_CALLS:-0})); then
        case "${FAKE_SESSION_INFO_TRANSIENT_SHAPE:-releasing}" in
          releasing)
            jq -cn --arg session "${session}" --arg device "${device:-emulator-5560}" \
              '{sessionId: $session, assignedDevice: $device, platform: "android", releasing: true}'
            exit 0
            ;;
          no-reason)
            jq -cn --arg session "${session}" \
              '{ok: false, error: ("Session not found: " + $session), code: "daemon_session_not_found"}'
            exit 1
            ;;
          garbage)
            printf '%s\n' 'not json'
            exit 1
            ;;
        esac
      fi
      if [[ -n "${device}" || "${FAKE_SESSION_INFO_STILL_LIVE:-0}" == 1 ]]; then
        jq -cn --arg session "${session}" --arg device "${device:-emulator-5560}" \
          '{sessionId: $session, assignedDevice: $device, platform: "android"}'
        exit 0
      fi
      reason=""
      if [[ -f "${FAKE}/releases" ]]; then
        while read -r time released_reason released_serial; do
          if [[ "$(session_for "${released_serial}")" == "${session}" ]]; then
            reason="${released_reason}"
          fi
        done < "${FAKE}/releases"
      fi
      idle=false
      if [[ ("${reason}" == cleanup-expired && "${FAKE_IDLE_FLAG_MISSING:-0}" != 1) ||
        ("${reason}" == heartbeat-timeout && "${FAKE_HEARTBEAT_RELEASE_IDLE:-0}" == 1) ]]; then
        idle=true
      fi
      jq -cn --arg session "${session}" --arg reason "${reason}" --argjson idle "${idle}" \
        '{ok: false, error: ("Session not found: " + $session), code: "daemon_session_not_found"}
        + (if $reason != "" then {releaseReason: $reason} else {} end)
        + (if $idle then {idle: true} else {} end)'
      exit 1
      ;;
    active-sessions)
      if [[ "${FAKE_ABORT_AFTER_FAILURE:-0}" == 1 && -f "${FAKE}/releases" ]] &&
        grep -q ' bug ' "${FAKE}/releases"; then exit 1; fi
      active_sessions
      ;;
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
# Bun on macOS never delivers stdin EOF for a named FIFO (#11073): model it by detecting one.
stdin_is_fifo=0
if lsof -a -p "$$" -d 0 -Fn 2> /dev/null | grep -q '^n/'; then
  stdin_is_fifo=1
fi
printf '%s\n' "${stdin_is_fifo}" > "${FAKE}/stdin_is_fifo"
trap 'exit 0' TERM
while IFS= read -r line; do
  id="$(jq -r '.id // empty' <<< "${line}")"
  [[ -n "${id}" ]] || continue
  method="$(jq -r '.method' <<< "${line}")"
  if [[ "${method}" == initialize ]]; then
    reply "${id}" '{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"0"}}'
    continue
  fi
  tool="$(jq -r '.params.name' <<< "${line}")"
  # The owner of a lazily expired session is refused on its next call (#10964/#10979).
  if [[ "${tool}" == observe ]]; then
    observed="$(jq -r '.params.arguments.deviceId // empty' <<< "${line}")"
    if [[ "${FAKE_REFUSE_WHILE_HELD:-0}" == 1 ||
      (-n "${observed}" && ! -d "${state}/${observed}" && -f "${FAKE}/releases") ]]; then
      jq -cn --argjson id "${id}" '{jsonrpc: "2.0", id: $id, result: {isError: true, content: [{type: "text", text: "{\"error\":{\"code\":\"no_active_device_session\",\"reason\":\"cleanup-expired\",\"idle\":true}}"}]}}'
      continue
    fi
  fi
  printf '%s %s\n' "${tool}" "$(jq -c '.params.arguments' <<< "${line}")" >> "${FAKE}/tool.calls"
  target=""
  session_arg="$(jq -r '.params.arguments.sessionUuid // empty' <<< "${line}")"
  # A released owner cannot re-use its connection binding or its old UUID.
  device_arg="$(jq -r '.params.arguments.deviceId // empty' <<< "${line}")"
  released_device="${device_arg}"
  if [[ -n "${session_arg}" && "${session_arg}" == "${FAKE_SESSION_UUID}" ]]; then
    released_device=emulator-5560
  fi
  if [[ "${tool}" == homeScreen && -n "${released_device}" &&
    ! -d "${state}/${released_device}" && -f "${FAKE}/releases" &&
    "${FAKE_RELEASE_NOT_TERMINAL:-0}" != 1 ]]; then
    code=no_active_device_session
    [[ -z "${session_arg}" ]] || code="${FAKE_RELEASE_SESSION_CODE:-session_ownership_lost}"
    next_action="${FAKE_RELEASE_NEXT_ACTION:-acquire_new_session}"
    refusal="$(jq -cn --arg code "${code}" --arg next "${next_action}" --arg session "${session_arg}" \
      --arg reason "${FAKE_REFUSAL_REASON:-cleanup-expired}" --argjson missing "${FAKE_REFUSAL_IDLE_MISSING:-0}" \
      '{error: ({code: $code, retryable: false, nextAction: $next, sessionUuid: $session, reason: $reason}
        + (if $missing == 1 then {} else {idle: true} end))}')"
    if [[ "${FAKE_RELEASE_REACQUIRE:-0}" == 1 ]]; then
      mkdir -p "${state}/${released_device}"
      session_for "${released_device}" > "${state}/${released_device}/session"
      printf '%s\n' "$$" > "${state}/${released_device}/proxy_pid"
      now > "${state}/${released_device}/acquired"
      now > "${state}/${released_device}/last_beat"
      now > "${state}/${released_device}/last_tool"
    fi
    if [[ "${FAKE_RELEASE_RPC_ERROR:-0}" == 1 ]]; then
      jq -cn --argjson id "${id}" --arg text "${refusal}" \
        '{jsonrpc: "2.0", id: $id, error: {code: -32603, message: ("MCP error -32603: " + $text), data: ($text | fromjson)}}'
    else
      reply "${id}" "$(jq -cn --arg text "${refusal}" \
        '{isError: true, content: [{type: "text", text: $text}]}')"
    fi
    continue
  fi
  if [[ "${tool}" == getAndroid || "${tool}" == provisionDevice ]]; then
    # provisionDevice names the AVD, not the serial; the fake runs one emulator for it.
    target="$(jq -r '.params.arguments.deviceId // "emulator-5560"' <<< "${line}")"
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
if [[ "${stdin_is_fifo}" == 1 ]]; then
  while true; do command sleep 0.05; done
fi
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
# The real stream pushes a terminal SESSION_ENDED error frame when the session is released.
if [[ "${FAKE_STREAM_NO_SESSION_ENDED:-0}" != 1 ]]; then
  printf '%s\n' '{"type":"error","success":false,"code":"SESSION_ENDED","error":"Observation stream ended: session_ended"}'
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
  [ ! -e "${EVIDENCE}/failed-scenarios.txt" ]
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
  [ ! -e "${EVIDENCE}/failed-scenarios.txt" ]
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

@test "fails the idle scenario when release lags the idle window by the old suspect grace" {
  FAKE_IDLE_RELEASE_LAG_MS=8000 run_check --scenario idle
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

@test "stdin-eof: the proxy sees EOF on an anonymous pipe, not a FIFO, so stop does not wait" {
  run_check --scenario stdin-eof
  [ "${status}" -eq 0 ]
  [ "$(cat "${FAKE}/stdin_is_fifo")" = 0 ]
  [[ "${output}" != *"did not exit after stdin closed"* ]]
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

@test "observe-only: the owner's refusal after the release is the release signal" {
  run_check --scenario observe-only
  [ "${status}" -eq 0 ]
  # The loop observed once more after the release and was refused, rather than dying.
  [ "$(grep -c '^observe ' "${FAKE}/tool.calls")" -ge 2 ]
  [[ "${output}" == *"PASS observe-only"* ]]
}

@test "observe-only: a refusal while the device is still held fails" {
  FAKE_REFUSE_WHILE_HELD=1 run_check --scenario observe-only
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"refused with no_active_device_session while"* ]]
}

@test "observe-only: fails when a read counts as use" {
  FAKE_READS_COUNT_AS_USE=1 run_check --scenario observe-only
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL observe-only"*"a read must not count as use"* ]]
}

@test "idle: a few ms of wall-clock jitter on an unmoved lastToolActivityAt is not activity" {
  FAKE_ACTIVITY_JITTER_MS=2 run_check --scenario idle
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS idle"* ]]
}

@test "idle: a shift beyond the jitter bound still fails" {
  FAKE_ACTIVITY_JITTER_MS=50 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"heartbeats moved lastToolActivityAt"* ]]
}

@test "observe-only: a few ms of wall-clock jitter is not activity" {
  FAKE_ACTIVITY_JITTER_MS=2 run_check --scenario observe-only
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS observe-only"* ]]
}

@test "all: a failing scenario does not hide the scenarios after it" {
  FAKE_SELECTOR_NOT_CREDITED=1 run_check --scenario all
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"PASS idle"* ]]
  [[ "${output}" == *"FAIL selector"* ]]
  [[ "${output}" == *"PASS stream"* ]]
  [[ "${output}" == *"FAILED scenarios: selector"* ]]
  [[ "${output}" != *"all requested scenarios passed"* ]]
  [ "$(cat "${EVIDENCE}/failed-scenarios.txt")" = selector ]
  grep -qx -- "--daemon stop --port 3920 --strict-port" "${FAKE}/daemon.calls"
}

@test "provision: a provisionDevice session is driven by deviceId and stays held" {
  run_check --scenario provision
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS provision"* ]]
  # #11065: the exact-device schema, derived from the emulator's own AVD, with no operationId.
  grep -qx 'provisionDevice {"device":{"platform":"android","name":"Pixel_9_API_36","spec":{"runtime":"system-images;android-36;google_apis;arm64-v8a","deviceType":"pixel_9"}}}' "${FAKE}/tool.calls"
  run grep -q operationId "${FAKE}/tool.calls"
  [ "${status}" -ne 0 ]
}

@test "provision: refuses when the emulator's AVD config cannot be found" {
  FAKE_AVD_NAME=Missing_AVD run_check --scenario provision
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"no config.ini for AVD Missing_AVD"* ]]
  [ ! -e "${FAKE}/tool.calls" ]
}

@test "stream: the subscription ends with SESSION_ENDED at the idle release and frames are kept as evidence" {
  run_check --scenario stream
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"PASS stream"* ]]
  grep -q '"command":"subscribe"' "${FAKE}/nc.requests"
  grep -q "\"sessionUuid\":\"${SESSION_UUID}\"" "${FAKE}/nc.requests"
  grep -q subscription_response "${EVIDENCE}/stream.stream.frames"
  grep -q SESSION_ENDED "${EVIDENCE}/stream.stream.frames"
}

@test "stream: fails when the idle release never ends the subscription" {
  FAKE_STREAM_NO_SESSION_ENDED=1 run_check --scenario stream
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"did not end with SESSION_ENDED"* ]]
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


@test "idle: release is terminal for deviceId and sessionUuid calls, with evidence" {
  run_check --scenario idle
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"terminal"*"no_active_device_session"*"session_ownership_lost"* ]]
  [ "$(wc -l < "${EVIDENCE}/idle.refusals.log" | tr -d ' ')" = 2 ]
  jq -e -s '.[0].result.isError and .[1].result.isError' "${EVIDENCE}/idle.refusals.log"
  grep -q no_active_device_session "${EVIDENCE}/idle.refusals.log"
  grep -q session_ownership_lost "${EVIDENCE}/idle.refusals.log"
  grep -q acquire_new_session "${EVIDENCE}/idle.refusals.log"
  [ "$(tail -n 2 "${FAKE}/tool.calls")" = "$(printf 'homeScreen {"deviceId":"emulator-5560"}\nhomeScreen {"sessionUuid":"%s"}' "${SESSION_UUID}")" ]
  [ ! -e "${EVIDENCE}/failed-scenarios.txt" ]
}

@test "idle: a successful post-release control call fails the terminal contract" {
  FAKE_RELEASE_NOT_TERMINAL=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL idle: a control call after the idle release succeeded; an idle release must be terminal for the session"* ]]
}

@test "idle: a refusal without acquire_new_session fails" {
  FAKE_RELEASE_NEXT_ACTION=retry run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL idle:"*"expected"*"acquire_new_session"*"reply"* ]]
  grep -q retry "${EVIDENCE}/idle.refusals.log"
}

@test "idle: sessionUuid refusal must name session_ownership_lost" {
  FAKE_RELEASE_SESSION_CODE=no_active_device_session run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL idle:"*"expected"*"session_ownership_lost"*"reply"* ]]
  [ "$(wc -l < "${EVIDENCE}/idle.refusals.log" | tr -d ' ')" = 2 ]
}

@test "idle: a refused call must not re-acquire the device" {
  FAKE_RELEASE_REACQUIRE=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL idle: a refused call re-acquired emulator-5560 after its idle release"* ]]
}

@test "idle: JSON-RPC error refusals satisfy the terminal contract" {
  FAKE_RELEASE_RPC_ERROR=1 run_check --scenario idle
  [ "${status}" -eq 0 ]
  jq -e -s 'length == 2 and all(.[]; .error != null)' "${EVIDENCE}/idle.refusals.log"
}

@test "single-scenario failure records exactly its name" {
  FAKE_NEVER_IDLE_RELEASE=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [ "$(cat "${EVIDENCE}/failed-scenarios.txt")" = idle ]
  [ "$(wc -l < "${EVIDENCE}/failed-scenarios.txt" | tr -d ' ')" = 1 ]
}

@test "a passing direct run clears a stale failed-scenario verdict" {
  mkdir -p "${EVIDENCE}"
  printf 'idle\nstream\n' > "${EVIDENCE}/failed-scenarios.txt"
  run_check --scenario idle
  [ "${status}" -eq 0 ]
  [ ! -e "${EVIDENCE}/failed-scenarios.txt" ]
}

@test "a daemon setup failure never records a scenario" {
  FAKE_DAEMON_START_FAIL=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"private daemon did not start"* ]]
  [ ! -e "${EVIDENCE}/failed-scenarios.txt" ]
}

@test "all: failed verdict is recorded before a parent query aborts between scenarios" {
  FAKE_RELEASE_AFTER_MS=8000 FAKE_ABORT_AFTER_FAILURE=1 run_check --scenario all
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"FAIL active"* ]]
  [[ "${output}" == *"could not query --daemon active-sessions"* ]]
  [ "$(cat "${EVIDENCE}/failed-scenarios.txt")" = active ]
}

@test "all: multiple failed scenarios are listed once in order" {
  FAKE_SELECTOR_NOT_CREDITED=1 FAKE_STREAM_NO_SESSION_ENDED=1 run_check --scenario all
  [ "${status}" -eq 1 ]
  [ "$(cat "${EVIDENCE}/failed-scenarios.txt")" = $'selector\nstream' ]
}

@test "release reason: idle records daemon ground truth and queries without launch flags" {
  run_check --scenario idle
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"idle: daemon recorded the release as cleanup-expired (idle: true)"* ]]
  [ -s "${EVIDENCE}/idle.release.log" ]
  jq -e '.releaseReason == "cleanup-expired" and .idle == true' \
    < <(cut -d' ' -f2- "${EVIDENCE}/idle.release.log")
  grep -qx -- "--daemon session-info ${SESSION_UUID} --json" "${FAKE}/daemon.calls"
  run grep 'session-info.*--port\|session-info.*--strict-port' "${FAKE}/daemon.calls"
  [ "${status}" -eq 1 ]
}

@test "release reason: idle rejects another daemon reason" {
  FAKE_IDLE_RELEASE_REASON=heartbeat-timeout run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"the idle release was recorded as 'heartbeat-timeout'; an idle end must carry reason cleanup-expired"* ]]
}

@test "release reason: idle requires the daemon idle flag" {
  FAKE_IDLE_FLAG_MISSING=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"the idle release (cleanup-expired) does not carry idle: true"* ]]
}

@test "release reason: idle refusal requires idle true" {
  FAKE_REFUSAL_IDLE_MISSING=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"deviceId refusal after the idle release does not carry idle: true; reply: '"* ]]
}

@test "release reason: idle refusal rejects a heartbeat reason" {
  FAKE_REFUSAL_REASON=heartbeat-timeout run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"deviceId refusal after the idle release names reason 'heartbeat-timeout'; expected cleanup-expired (or the proxy-local replay-lease-expired)"* ]]
}

@test "release reason: idle refusal accepts and logs the proxy-local reason" {
  FAKE_REFUSAL_REASON=replay-lease-expired run_check --scenario idle
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"daemon recorded the release as cleanup-expired (idle: true)"* ]]
  [[ "${output}" == *"deviceId reason: replay-lease-expired; sessionUuid reason: replay-lease-expired"* ]]
}

@test "release reason: JSON-RPC idle refusal requires idle true" {
  FAKE_RELEASE_RPC_ERROR=1 FAKE_REFUSAL_IDLE_MISSING=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"deviceId refusal after the idle release does not carry idle: true"* ]]
}

@test "release reason: JSON-RPC idle refusal accepts the proxy-local reason" {
  FAKE_RELEASE_RPC_ERROR=1 FAKE_REFUSAL_REASON=replay-lease-expired run_check --scenario idle
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"deviceId reason: replay-lease-expired; sessionUuid reason: replay-lease-expired"* ]]
}

@test "release reason: heartbeat loss has no idle field" {
  run_check --scenario no-heartbeat
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"no-heartbeat: daemon recorded the release as heartbeat-timeout (no idle field)"* ]]
  [ -s "${EVIDENCE}/no-heartbeat.release.log" ]
}

@test "release reason: heartbeat loss rejects an idle field" {
  FAKE_HEARTBEAT_RELEASE_IDLE=1 run_check --scenario no-heartbeat
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"the heartbeat-loss release carries an idle field; only an idle end may"* ]]
}

@test "release reason: heartbeat loss rejects an idle reason" {
  FAKE_HEARTBEAT_RELEASE_REASON=cleanup-expired run_check --scenario no-heartbeat
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"the heartbeat-loss release was recorded as 'cleanup-expired'; expected heartbeat-timeout or missing-first-heartbeat"* ]]
}

@test "release reason: heartbeat loss accepts missing-first-heartbeat" {
  FAKE_HEARTBEAT_RELEASE_REASON=missing-first-heartbeat run_check --scenario no-heartbeat
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"daemon recorded the release as missing-first-heartbeat (no idle field)"* ]]
}

@test "release reason: observe-only logs an idle end" {
  run_check --scenario observe-only
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"observe-only: daemon recorded the release as cleanup-expired (idle: true)"* ]]
}

@test "release reason: observe-only rejects a heartbeat end" {
  FAKE_IDLE_RELEASE_REASON=heartbeat-timeout run_check --scenario observe-only
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"the idle release was recorded as 'heartbeat-timeout'; an idle end must carry reason cleanup-expired"* ]]
}

@test "release reason: stream logs an idle end" {
  run_check --scenario stream
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"stream: daemon recorded the release as cleanup-expired (idle: true)"* ]]
}

@test "release reason: stream rejects a heartbeat end" {
  FAKE_IDLE_RELEASE_REASON=heartbeat-timeout run_check --scenario stream
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"the idle release was recorded as 'heartbeat-timeout'; an idle end must carry reason cleanup-expired"* ]]
}

@test "release reason: two-devices queries A while B is held" {
  run_check --scenario two-devices --second-serial emulator-5562
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"two-devices: daemon recorded the release as cleanup-expired (idle: true)"* ]]
  run grep session-info "${FAKE}/daemon.calls"
  [ "${output}" = "--daemon session-info ${SESSION_UUID} --json" ]
}

@test "release reason: two-devices requires A's idle flag" {
  FAKE_IDLE_FLAG_MISSING=1 run_check --scenario two-devices --second-serial emulator-5562
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"the idle release (cleanup-expired) does not carry idle: true"* ]]
}

@test "release reason: daemon still reporting a released session live fails" {
  FAKE_SESSION_INFO_STILL_LIVE=1 run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"session-info still reports session ${SESSION_UUID} live 30 s after active-sessions stopped listing it"* ]]
}

@test "release reason: idle waits for two releasing replies" {
  FAKE_SESSION_INFO_TRANSIENT_CALLS=2 FAKE_SESSION_INFO_TRANSIENT_SHAPE=releasing run_check --scenario idle
  [ "${status}" -eq 0 ]
  [ "$(wc -l < "${EVIDENCE}/idle.release.log" | tr -d ' ')" -eq 3 ]
}

@test "release reason: idle waits for two no-reason replies" {
  FAKE_SESSION_INFO_TRANSIENT_CALLS=2 FAKE_SESSION_INFO_TRANSIENT_SHAPE=no-reason run_check --scenario idle
  [ "${status}" -eq 0 ]
  [ "$(wc -l < "${EVIDENCE}/idle.release.log" | tr -d ' ')" -eq 3 ]
}

@test "release reason: idle waits for two garbage replies" {
  FAKE_SESSION_INFO_TRANSIENT_CALLS=2 FAKE_SESSION_INFO_TRANSIENT_SHAPE=garbage run_check --scenario idle
  [ "${status}" -eq 0 ]
  [ "$(wc -l < "${EVIDENCE}/idle.release.log" | tr -d ' ')" -eq 3 ]
}

@test "release reason: heartbeat loss waits for two releasing replies" {
  FAKE_SESSION_INFO_TRANSIENT_CALLS=2 FAKE_SESSION_INFO_TRANSIENT_SHAPE=releasing run_check --scenario no-heartbeat
  [ "${status}" -eq 0 ]
  [ "$(wc -l < "${EVIDENCE}/no-heartbeat.release.log" | tr -d ' ')" -eq 3 ]
}

@test "release reason: a final first reply does not poll" {
  run_check --scenario idle
  [ "${status}" -eq 0 ]
  [ "$(grep -c session-info "${FAKE}/daemon.calls")" -eq 1 ]
}

@test "release reason: daemon never names a reason fails after 30 seconds" {
  FAKE_SESSION_INFO_TRANSIENT_CALLS=1000 FAKE_SESSION_INFO_TRANSIENT_SHAPE=no-reason run_check --scenario idle
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"named no releaseReason for session ${SESSION_UUID} within 30 s of its release"* ]]
}

@test "neighbour pins: active stdin-eof selector and provision do not query release reasons" {
  for scenario in active stdin-eof selector provision; do
    run_check --scenario "${scenario}"
    [ "${status}" -eq 0 ]
    run grep session-info "${FAKE}/daemon.calls"
    [ "${status}" -eq 1 ]
  done
}
