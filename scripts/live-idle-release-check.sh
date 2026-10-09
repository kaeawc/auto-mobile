#!/usr/bin/env bash
# Live idle-release check (#10671).
#
# Drives a private AutoMobile daemon against one emulator and checks both sides
# of the device-session release windows (src/daemon/sessionLivenessWindows.ts):
#
#   active        A stdio proxy that heartbeats AND makes tool calls keeps the
#                 device past the idle window.
#   no-heartbeat  When the proxy's heartbeats stop (the process is suspended
#                 with SIGSTOP, so its socket stays open), the device is
#                 released about 10 s later.
#   idle          A proxy that keeps heartbeating but makes no tool calls holds
#                 the device until the idle window ends, and then loses it.
#   stdin-eof     A proxy whose stdin closes (the MCP host went away) exits on its
#                 own and its device is released within the no-heartbeat budget.
#   selector      Calls that name only `deviceId` (no sessionUuid) are credited to
#                 the session holding that device (#10692): it outlives the idle
#                 window, and lastToolActivityAt advances with each call.
#   two-devices   One proxy holds two emulators (needs --second-serial). Using
#                 only B lets A go at its own idle deadline while B stays held.
#   stream        An observation-stream subscriber (nc -U on the aux socket) stays
#                 subscribed across the idle release; the release is recorded next
#                 to the frames the stream pushed (no device_session_ended: the
#                 device epoch outlives the agent session).
#   provision     Like selector, for a session minted by provisionDevice
#                 (#10821). Opt-in only: provisionDevice is not enabled everywhere,
#                 so it is not part of `all`.
#
# Every scenario also checks the emulator still answers adb afterwards (release
# never kills the device) and saves the daemon log lines naming the session
# next to the `--daemon active-sessions` snapshots under the evidence dir.
#
# The daemon is fully private: its socket, pid, lock, aux sockets, data, logs,
# database, coordination and iOS cache directories live in one work directory,
# it listens on an explicit --port with --strict-port, and the idle window is
# shortened with AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS. It never touches the
# resident daemon or ~/.auto-mobile. The emulator must not be held by another
# daemon: CtrlProxy forwarding is leased per device.
#
# This is a live, opt-in check. It never runs on pull requests or in fast
# validation; the only CI entry point is the dispatch-only workflow
# .github/workflows/live-idle-release.yml.
#
# Status-returning helpers (proxy_alive, wait_for_release, daemon_cmd,
# active_sessions_json, stop_daemon, stop_proxy) are called in conditions on
# purpose. Each checks its own commands explicitly and fails through die, so none
# relies on errexit inside it.
# shellcheck disable=SC2310
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

# Test seams: the BATS suite substitutes fakes for bun (the server), adb, sleep
# and the clock. Production uses the real tools.
BUN="${AUTOMOBILE_IDLE_CHECK_BUN:-bun}"
ADB="${AUTOMOBILE_IDLE_CHECK_ADB:-adb}"
SLEEP_CMD="${AUTOMOBILE_IDLE_CHECK_SLEEP:-sleep}"
NOW_CMD="${AUTOMOBILE_IDLE_CHECK_NOW:-}"
NC="${AUTOMOBILE_IDLE_CHECK_NC:-nc}"

# Mirrors src/daemon/sessionLivenessWindows.ts: owner lease 4 s + suspect grace
# 4 s + one 2 s monitor scan.
SUSPECT_GRACE_MS=4000
MONITOR_SCAN_MS=2000
NO_HEARTBEAT_BUDGET_MS=10000

serial=""
second_serial=""
port=""
confirm_live=false
idle_timeout_ms=20000
active_ms=""
call_interval_ms=5000
slack_ms=5000
acquire_timeout_s=600
scenario="all"
server="${REPO_ROOT}/dist/src/index.js"
work_dir=""
evidence_dir=""
keep_work_dir=false

created_work_dir=false
proxy_pid=""
proxy_fds_open=false
subscriber_pid=""
subscriber_fd_open=false
daemon_started=false
request_id=0
session_id=""
current_scenario=""
# Set by query_device_entry and wait_for_release; globals, not stdout, so a failed
# query can never be mistaken for an empty (released) answer inside $(...).
entry=""
released_at=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/live-idle-release-check.sh --confirm-live --serial <emulator-serial> --port <port> [options]

Checks idle release live against one emulator with a private daemon (#10671).

Required:
  --serial <serial>          Emulator to drive, e.g. emulator-5560. Must not be held by another daemon.
  --port <port>              Explicit daemon port (1024-65535, outside the resident 3000-3010 range).
  --second-serial <serial>   Second emulator for the two-devices scenario (required by it, ignored otherwise).
  --confirm-live             Acknowledge that this acquires and releases a real emulator.

Options:
  --idle-timeout-ms <ms>     AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS for the private daemon (default 20000).
  --active-ms <ms>           How long the active scenario keeps calling (default idle + 10000).
  --call-interval-ms <ms>    Gap between observe calls in the active scenario (default 5000).
  --slack-ms <ms>            Tolerance added to every release bound (default 5000).
  --acquire-timeout-s <s>    Timeout for getAndroid (default 600).
  --scenario <name>          all, active, no-heartbeat, idle, stdin-eof, selector, stream, two-devices
                             or provision (default all; all omits two-devices without --second-serial,
                             and never runs provision).
  --server <path>            Server entry (default dist/src/index.js; run `bun run build` first).
  --work-dir <dir>           Private daemon directory (default a fresh /tmp/am-idle.XXXXXX).
  --evidence-dir <dir>       Where evidence is kept (default scratch/live-idle-release-check/<time>).
  --keep-work-dir            Keep the private daemon directory after a successful run.
  -h, --help                 Show this help.
EOF
}

log() {
  printf '[idle-check] %s\n' "$*" >&2
}

die() {
  if [[ -n "${current_scenario}" ]]; then
    log "FAIL ${current_scenario}: $*"
  else
    log "error: $*"
  fi
  exit 1
}

require_value() {
  local flag="$1" value="${2:-}"
  if [[ -z "${value}" || "${value}" == --* ]]; then
    log "error: ${flag} requires a value."
    exit 2
  fi
}

require_integer() {
  local flag="$1" value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    log "error: ${flag} must be a non-negative integer, got '${value}'."
    exit 2
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --serial)
        require_value "$1" "${2:-}"
        serial="$2"
        shift 2
        ;;
      --port)
        require_value "$1" "${2:-}"
        port="$2"
        shift 2
        ;;
      --second-serial)
        require_value "$1" "${2:-}"
        second_serial="$2"
        shift 2
        ;;
      --confirm-live)
        confirm_live=true
        shift
        ;;
      --idle-timeout-ms)
        require_value "$1" "${2:-}"
        idle_timeout_ms="$2"
        shift 2
        ;;
      --active-ms)
        require_value "$1" "${2:-}"
        active_ms="$2"
        shift 2
        ;;
      --call-interval-ms)
        require_value "$1" "${2:-}"
        call_interval_ms="$2"
        shift 2
        ;;
      --slack-ms)
        require_value "$1" "${2:-}"
        slack_ms="$2"
        shift 2
        ;;
      --acquire-timeout-s)
        require_value "$1" "${2:-}"
        acquire_timeout_s="$2"
        shift 2
        ;;
      --scenario)
        require_value "$1" "${2:-}"
        scenario="$2"
        shift 2
        ;;
      --server)
        require_value "$1" "${2:-}"
        server="$2"
        shift 2
        ;;
      --work-dir)
        require_value "$1" "${2:-}"
        work_dir="$2"
        shift 2
        ;;
      --evidence-dir)
        require_value "$1" "${2:-}"
        evidence_dir="$2"
        shift 2
        ;;
      --keep-work-dir)
        keep_work_dir=true
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        log "error: unknown argument: $1"
        usage >&2
        exit 2
        ;;
    esac
  done
}

validate_args() {
  if [[ "${confirm_live}" != true ]]; then
    log "error: this check acquires a real emulator; pass --confirm-live to run it."
    exit 2
  fi
  if [[ -z "${serial}" ]]; then
    log "error: --serial is required."
    exit 2
  fi
  if [[ ! "${serial}" =~ ^emulator-[0-9]+$ ]]; then
    log "error: --serial must be an emulator serial (emulator-NNNN), got '${serial}'."
    exit 2
  fi
  if [[ -z "${port}" ]]; then
    log "error: --port is required so the private daemon never falls back to the resident range."
    exit 2
  fi
  require_integer --port "${port}"
  if ((port < 1024 || port > 65535)) || ((port >= 3000 && port <= 3010)); then
    log "error: --port must be 1024-65535 and outside the resident daemon's 3000-3010 range."
    exit 2
  fi
  require_integer --idle-timeout-ms "${idle_timeout_ms}"
  require_integer --call-interval-ms "${call_interval_ms}"
  require_integer --slack-ms "${slack_ms}"
  require_integer --acquire-timeout-s "${acquire_timeout_s}"
  # The no-heartbeat scenario must be able to tell a heartbeat release from an
  # idle one, so the idle window has to outlast the no-heartbeat bound.
  if ((idle_timeout_ms <= NO_HEARTBEAT_BUDGET_MS + slack_ms)); then
    log "error: --idle-timeout-ms must exceed $((NO_HEARTBEAT_BUDGET_MS + slack_ms)) (no-heartbeat budget plus slack)."
    exit 2
  fi
  if [[ -z "${active_ms}" ]]; then
    active_ms=$((idle_timeout_ms + NO_HEARTBEAT_BUDGET_MS))
  fi
  require_integer --active-ms "${active_ms}"
  if ((active_ms <= idle_timeout_ms)); then
    log "error: --active-ms must exceed --idle-timeout-ms so the active scenario outlasts the idle window."
    exit 2
  fi
  if ((call_interval_ms == 0 || call_interval_ms >= idle_timeout_ms)); then
    log "error: --call-interval-ms must be positive and shorter than the idle window."
    exit 2
  fi
  case "${scenario}" in
    all | active | no-heartbeat | idle | stdin-eof | selector | stream | two-devices | provision) ;;
    *)
      log "error: --scenario must be all, active, no-heartbeat, idle, stdin-eof, selector, stream, two-devices or provision."
      exit 2
      ;;
  esac
  if [[ -n "${second_serial}" ]]; then
    if [[ ! "${second_serial}" =~ ^emulator-[0-9]+$ || "${second_serial}" == "${serial}" ]]; then
      log "error: --second-serial must be a different emulator serial (emulator-NNNN), got '${second_serial}'."
      exit 2
    fi
  fi
  if [[ "${scenario}" == two-devices && -z "${second_serial}" ]]; then
    log "error: the two-devices scenario needs --second-serial."
    exit 2
  fi
  if ! command -v "${NC}" > /dev/null 2>&1 && [[ "${scenario}" == stream || "${scenario}" == all ]]; then
    log "error: the stream scenario needs nc with -U support."
    exit 2
  fi
  if [[ ! -f "${server}" ]]; then
    log "error: server entry ${server} is missing; run \`bun run build\` first."
    exit 2
  fi
  command -v jq > /dev/null 2>&1 || {
    log "error: jq is required."
    exit 2
  }
}

now_ms() {
  if [[ -n "${NOW_CMD}" ]]; then
    "${NOW_CMD}"
  else
    printf '%s\n' "$(($(date +%s) * 1000))"
  fi
}

# Sleep whole seconds, rounding up and never less than one.
sleep_ms() {
  local seconds=$((($1 + 999) / 1000))
  if ((seconds < 1)); then
    seconds=1
  fi
  "${SLEEP_CMD}" "${seconds}"
}

setup_private_namespace() {
  if [[ -z "${work_dir}" ]]; then
    # /tmp, not $TMPDIR: macOS's per-user TMPDIR is too long for Unix socket paths.
    work_dir="$(mktemp -d /tmp/am-idle.XXXXXX)"
    created_work_dir=true
  fi
  mkdir -p "${work_dir}"
  work_dir="$(cd -- "${work_dir}" && pwd)"
  local longest_socket="${work_dir}/observation-stream.sock"
  if ((${#longest_socket} >= 100)); then
    die "work dir ${work_dir} is too long for Unix socket paths; pass a shorter --work-dir."
  fi
  if [[ -z "${evidence_dir}" ]]; then
    evidence_dir="${REPO_ROOT}/scratch/live-idle-release-check/$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "${evidence_dir}" "${work_dir}/data" "${work_dir}/logs" "${work_dir}/db" \
    "${work_dir}/coord" "${work_dir}/ios-cache"

  # Drop every inherited daemon selector and session-timing knob so nothing from
  # the caller's shell can point this run at the resident daemon or change the
  # windows under test.
  local name
  while IFS= read -r name; do
    case "${name}" in
      AUTOMOBILE_DAEMON_* | AUTO_MOBILE_DAEMON_* | AUTOMOBILE_SESSION_* | AUTO_MOBILE_SESSION_* | \
        AUTOMOBILE_DB_* | AUTO_MOBILE_DB_*)
        unset "${name}"
        ;;
    esac
  done < <(compgen -e)

  export AUTOMOBILE_DAEMON_SOCKET_PATH="${work_dir}/d.sock"
  export AUTOMOBILE_DAEMON_PID_FILE_PATH="${work_dir}/d.pid"
  export AUTOMOBILE_DAEMON_LOCK_FILE_PATH="${work_dir}/d.lock"
  export AUTOMOBILE_DAEMON_LAUNCH_CWD="${work_dir}"
  export AUTOMOBILE_AUX_SOCKET_DIR="${work_dir}"
  # Arms the private-daemon orphan watchdog (#10497) explicitly (#10906).
  export AUTOMOBILE_HARNESS_PRIVATE_DAEMON=1
  export AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH="${work_dir}/w.sock"
  export AUTOMOBILE_DATA_DIR="${work_dir}/data"
  export AUTOMOBILE_LOG_DIR="${work_dir}/logs"
  export AUTOMOBILE_DB_DIR="${work_dir}/db"
  export AUTOMOBILE_COORDINATION_DIR="${work_dir}/coord"
  export AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR="${work_dir}/ios-cache"
  export AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS="${idle_timeout_ms}"
  log "private daemon in ${work_dir} on port ${port}; idle window ${idle_timeout_ms} ms"
  log "evidence in ${evidence_dir}"
}

daemon_cmd() {
  local command="$1"
  shift
  "${BUN}" "${server}" --daemon "${command}" "$@" --port "${port}" --strict-port
}

start_daemon() {
  daemon_cmd start >> "${work_dir}/daemon-cli.log" 2>&1 || die "private daemon did not start; see ${work_dir}/daemon-cli.log"
  daemon_started=true
}

stop_daemon() {
  if [[ "${daemon_started}" != true ]]; then
    return 0
  fi
  daemon_started=false
  daemon_cmd stop >> "${work_dir}/daemon-cli.log" 2>&1
}

active_sessions_json() {
  local output
  output="$(daemon_cmd active-sessions 2>> "${work_dir}/daemon-cli.log")" || return 1
  # The reply is the last line; anything before it is incidental CLI output.
  printf '%s\n' "${output}" | tail -n 1
}

# Set entry to the active-sessions entry holding the emulator (default: --serial), or to ""
# when none does.
query_device_entry() {
  local target="${1:-${serial}}" snapshot
  snapshot="$(active_sessions_json)" || die "could not query --daemon active-sessions"
  printf '%s %s\n' "$(now_ms)" "${snapshot}" >> "${evidence_dir}/${current_scenario:-setup}.sessions.log"
  entry="$(jq -c --arg device "${target}" \
    '[.sessions[]? | select(.assignedDevice == $device and .releasing != true)] | first // empty' \
    <<< "${snapshot}")" || die "--daemon active-sessions printed invalid JSON: ${snapshot}"
}

entry_field() {
  jq -r --arg field "$2" '.[$field] | if . == null then "null" else tostring end' <<< "$1"
}

proxy_alive() {
  [[ -n "${proxy_pid}" ]] && kill -0 "${proxy_pid}" 2> /dev/null
}

start_proxy() {
  rm -f "${work_dir}/mcp.in" "${work_dir}/mcp.out"
  mkfifo "${work_dir}/mcp.in" "${work_dir}/mcp.out"
  "${BUN}" "${server}" --port "${port}" --strict-port \
    < "${work_dir}/mcp.in" > "${work_dir}/mcp.out" 2>> "${work_dir}/proxy.stderr" &
  proxy_pid=$!
  # Open the writer first: the proxy opens its stdin before its stdout.
  exec 7> "${work_dir}/mcp.in"
  exec 8< "${work_dir}/mcp.out"
  proxy_fds_open=true
  mcp_request initialize \
    '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"live-idle-release-check","version":"1"}}' \
    60
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}' >&7
}

close_proxy_fds() {
  if [[ "${proxy_fds_open}" == true ]]; then
    exec 7>&- 8<&-
    proxy_fds_open=false
  fi
}

# Close the proxy's stdin and wait for it to exit; only this run's proxy is ever signalled.
stop_proxy() {
  if [[ -z "${proxy_pid}" ]]; then
    return 0
  fi
  kill -CONT "${proxy_pid}" 2> /dev/null || true
  close_proxy_fds
  local waited=0
  while proxy_alive && ((waited < 15)); do
    "${SLEEP_CMD}" 1
    waited=$((waited + 1))
  done
  if proxy_alive; then
    log "proxy ${proxy_pid} did not exit after stdin closed; sending SIGTERM"
    kill -TERM "${proxy_pid}" 2> /dev/null || true
  fi
  wait "${proxy_pid}" 2> /dev/null || true
  proxy_pid=""
}

# Send one JSON-RPC request and wait for its response; any error fails the scenario.
mcp_request() {
  local method="$1" params="$2" timeout_s="$3"
  request_id=$((request_id + 1))
  jq -cn --argjson id "${request_id}" --arg method "${method}" --argjson params "${params}" \
    '{jsonrpc: "2.0", id: $id, method: $method, params: $params}' >&7 ||
    die "could not send ${method} to the proxy"
  local line deadline=$((SECONDS + timeout_s))
  while ((SECONDS < deadline)); do
    if ! IFS= read -r -t "$((deadline - SECONDS + 1))" -u 8 line; then
      break
    fi
    if jq -e --argjson id "${request_id}" '.id == $id' <<< "${line}" > /dev/null 2>&1; then
      if jq -e '.error != null' <<< "${line}" > /dev/null; then
        die "${method} failed: $(jq -c '.error' <<< "${line}")"
      fi
      if jq -e '.result.isError == true' <<< "${line}" > /dev/null; then
        die "${method} returned an error: $(jq -c '.result.content' <<< "${line}")"
      fi
      return 0
    fi
  done
  die "no response to ${method} within ${timeout_s} s; see ${work_dir}/proxy.stderr"
}

call_tool() {
  local name="$1" arguments="$2" timeout_s="$3"
  mcp_request tools/call "$(jq -cn --arg name "${name}" --argjson arguments "${arguments}" \
    '{name: $name, arguments: $arguments}')" "${timeout_s}"
}

# Through the running proxy, acquire `device` with `tool` (getAndroid or provisionDevice) and
# set session_id/entry to the session holding it.
acquire_with() {
  local tool="$1" device="$2"
  call_tool "${tool}" "$(jq -cn --arg device "${device}" '{deviceId: $device}')" "${acquire_timeout_s}"
  local attempts=0
  query_device_entry "${device}"
  while [[ -z "${entry}" ]] && ((attempts < 30)); do
    "${SLEEP_CMD}" 1
    attempts=$((attempts + 1))
    query_device_entry "${device}"
  done
  [[ -n "${entry}" ]] || die "${tool} succeeded but no active session holds ${device}"
  session_id="$(entry_field "${entry}" sessionId)"
  local holder
  holder="$(entry_field "${entry}" holderKind)"
  [[ "${holder}" == "stdio-proxy" ]] || die "session ${session_id} reports holderKind ${holder}, expected stdio-proxy"
  log "${current_scenario}: ${device} held by session ${session_id} (${holder})"
}

# Start a proxy, acquire the emulator through it, and find the session holding it.
acquire_device() {
  start_proxy
  acquire_with getAndroid "${serial}"
}

# Poll until the emulator is no longer held (setting released_at) or the deadline passes.
wait_for_release() {
  local deadline="$1" now
  while true; do
    now="$(now_ms)" || die "could not read the clock"
    query_device_entry
    if [[ -z "${entry}" ]]; then
      released_at="${now}"
      return 0
    fi
    if ((now >= deadline)); then
      return 1
    fi
    "${SLEEP_CMD}" 1
  done
}

assert_device_alive() {
  local state device="${ADB_SERIAL_OVERRIDE:-${serial}}"
  state="$("${ADB}" -s "${device}" get-state 2> /dev/null || true)"
  [[ "${state}" == "device" ]] || die "${device} no longer answers adb (state '${state}'); release must not kill the device"
}

save_daemon_log_lines() {
  if [[ -n "${session_id}" && -d "${AUTOMOBILE_LOG_DIR}" ]]; then
    grep -rh -- "${session_id}" "${AUTOMOBILE_LOG_DIR}" > "${evidence_dir}/${current_scenario}.daemon.log" 2> /dev/null || true
  fi
}

finish_scenario() {
  save_daemon_log_lines
  assert_device_alive
  log "PASS ${current_scenario}"
  current_scenario=""
  session_id=""
}

# Stop the proxy and require the release that follows its exit.
release_by_proxy_exit() {
  stop_proxy
  local deadline=$(($(now_ms) + NO_HEARTBEAT_BUDGET_MS + slack_ms))
  wait_for_release "${deadline}" || die "${serial} still held after the proxy exited"
}

scenario_active() {
  current_scenario="active"
  acquire_device
  local start now
  start="$(now_ms)"
  now="${start}"
  while ((now - start < active_ms)); do
    call_tool observe "$(jq -cn --arg session "${session_id}" '{sessionUuid: $session}')" 120
    query_device_entry
    [[ -n "${entry}" ]] || die "${serial} was released after $((now - start)) ms while the proxy heartbeated and called tools"
    sleep_ms "${call_interval_ms}"
    now="$(now_ms)"
  done
  query_device_entry
  [[ -n "${entry}" ]] || die "${serial} was released at the end of the active window"
  log "active: held for $((now - start)) ms of calls (idle window ${idle_timeout_ms} ms)"
  release_by_proxy_exit
  finish_scenario
}

scenario_no_heartbeat() {
  current_scenario="no-heartbeat"
  acquire_device
  # Suspend the proxy: its socket stays open, so only the missing heartbeats can release.
  kill -STOP "${proxy_pid}"
  local stopped
  stopped="$(now_ms)"
  wait_for_release $((stopped + NO_HEARTBEAT_BUDGET_MS + slack_ms)) ||
    die "${serial} still held $((NO_HEARTBEAT_BUDGET_MS + slack_ms)) ms after heartbeats stopped"
  log "no-heartbeat: released $((released_at - stopped)) ms after heartbeats stopped (budget ${NO_HEARTBEAT_BUDGET_MS} ms)"
  stop_proxy
  finish_scenario
}

scenario_idle() {
  current_scenario="idle"
  acquire_device
  local acquired first last
  acquired="$(now_ms)"
  query_device_entry
  first="${entry}"
  [[ -n "${first}" ]] || die "${serial} released right after getAndroid"
  local window
  window=$(($(entry_field "${first}" idleReleaseAt) - $(entry_field "${first}" lastToolActivityAt)))
  if ((window < idle_timeout_ms || window > idle_timeout_ms + SUSPECT_GRACE_MS + slack_ms)); then
    die "idleReleaseAt is ${window} ms after the last tool activity; expected about ${idle_timeout_ms} ms"
  fi

  # Held, heartbeating, and not counted as used, until just before the idle window ends.
  local now="${acquired}"
  while ((now < acquired + idle_timeout_ms - slack_ms)); do
    query_device_entry
    [[ -n "${entry}" ]] || die "${serial} released $((now - acquired)) ms into the ${idle_timeout_ms} ms idle window"
    proxy_alive || die "the proxy exited during the idle window"
    "${SLEEP_CMD}" 1
    now="$(now_ms)"
  done
  query_device_entry
  last="${entry}"
  [[ -n "${last}" ]] || die "${serial} released before the idle window ended"
  [[ "$(entry_field "${last}" lastToolActivityAt)" == "$(entry_field "${first}" lastToolActivityAt)" ]] ||
    die "heartbeats moved lastToolActivityAt; a heartbeat must not count as use"
  local first_beat last_beat
  first_beat="$(entry_field "${first}" lastOwnerHeartbeatAt)"
  last_beat="$(entry_field "${last}" lastOwnerHeartbeatAt)"
  if [[ "${last_beat}" == "null" ]] || { [[ "${first_beat}" != "null" ]] && ((last_beat <= first_beat)); }; then
    die "lastOwnerHeartbeatAt did not advance (${first_beat} -> ${last_beat}); the proxy is not heartbeating"
  fi

  wait_for_release $((acquired + idle_timeout_ms + SUSPECT_GRACE_MS + MONITOR_SCAN_MS + slack_ms)) ||
    die "${serial} still held after the ${idle_timeout_ms} ms idle window"
  proxy_alive || die "the proxy exited before the release, so this was not an idle release"
  log "idle: released $((released_at - acquired)) ms after the last tool call (idle window ${idle_timeout_ms} ms)"
  stop_proxy
  finish_scenario
}

# Call observe by device id only, every call interval for active_ms, requiring the device to stay
# held and lastToolActivityAt to advance with the calls (the proxy credited them to the session).
drive_selector_calls() {
  local start now before after
  start="$(now_ms)"
  now="${start}"
  before="$(entry_field "${entry}" lastToolActivityAt)"
  while ((now - start < active_ms)); do
    call_tool observe "$(jq -cn --arg device "${serial}" '{deviceId: $device}')" 120
    query_device_entry
    [[ -n "${entry}" ]] || die "${serial} was released after $((now - start)) ms of calls that named only its deviceId"
    after="$(entry_field "${entry}" lastToolActivityAt)"
    if [[ "${after}" == "null" ]] || ((after <= before)); then
      die "a call naming only deviceId did not advance lastToolActivityAt (${before} -> ${after}); it was not credited to the session"
    fi
    before="${after}"
    sleep_ms "${call_interval_ms}"
    now="$(now_ms)"
  done
  log "${current_scenario}: held for $((now - start)) ms of deviceId-only calls (idle window ${idle_timeout_ms} ms)"
}

scenario_selector() {
  current_scenario="selector"
  acquire_device
  drive_selector_calls
  release_by_proxy_exit
  finish_scenario
}

scenario_provision() {
  current_scenario="provision"
  start_proxy
  acquire_with provisionDevice "${serial}"
  drive_selector_calls
  release_by_proxy_exit
  finish_scenario
}

scenario_stdin_eof() {
  current_scenario="stdin-eof"
  acquire_device
  call_tool observe "$(jq -cn --arg session "${session_id}" '{sessionUuid: $session}')" 120
  query_device_entry
  [[ -n "${entry}" ]] || die "${serial} was released right after a tool call"
  # Closing stdin is the MCP host going away; the proxy has to notice and exit by itself.
  local closed waited=0
  closed="$(now_ms)"
  close_proxy_fds
  while proxy_alive && ((waited < 15)); do
    "${SLEEP_CMD}" 1
    waited=$((waited + 1))
  done
  ! proxy_alive || die "the proxy did not exit within 15 s of its stdin closing"
  wait_for_release $((closed + NO_HEARTBEAT_BUDGET_MS + slack_ms)) ||
    die "${serial} still held $((NO_HEARTBEAT_BUDGET_MS + slack_ms)) ms after the proxy's stdin closed"
  log "stdin-eof: released $((released_at - closed)) ms after stdin closed (budget ${NO_HEARTBEAT_BUDGET_MS} ms)"
  stop_proxy
  finish_scenario
}

scenario_two_devices() {
  current_scenario="two-devices"
  start_proxy
  acquire_with getAndroid "${serial}"
  local session_a="${session_id}" acquired_a
  acquired_a="$(now_ms)"
  acquire_with getAndroid "${second_serial}"
  local session_b="${session_id}"
  [[ "${session_a}" != "${session_b}" ]] || die "both emulators report session ${session_a}; expected one session each"

  # Only B is used. A must go at its own idle deadline while B stays held and heartbeating.
  local now="${acquired_a}" released_a=""
  local deadline=$((acquired_a + idle_timeout_ms + SUSPECT_GRACE_MS + MONITOR_SCAN_MS + slack_ms))
  while [[ -z "${released_a}" ]]; do
    call_tool observe "$(jq -cn --arg session "${session_b}" '{sessionUuid: $session}')" 120
    now="$(now_ms)"
    query_device_entry "${second_serial}"
    [[ -n "${entry}" ]] || die "${second_serial} was released while it was in use"
    query_device_entry "${serial}"
    if [[ -z "${entry}" ]]; then
      released_a="${now}"
    elif ((now >= deadline)); then
      die "${serial} still held after its ${idle_timeout_ms} ms idle window although only ${second_serial} was used"
    else
      sleep_ms "${call_interval_ms}"
    fi
  done
  if ((released_a - acquired_a < idle_timeout_ms - slack_ms)); then
    die "${serial} was released only $((released_a - acquired_a)) ms after its last use, before its ${idle_timeout_ms} ms idle window"
  fi
  proxy_alive || die "the proxy exited before ${serial} was released"
  query_device_entry "${second_serial}"
  [[ -n "${entry}" ]] || die "${second_serial} was released together with ${serial}"
  log "two-devices: ${serial} released $((released_a - acquired_a)) ms after its last use; ${second_serial} still held"
  # B follows the proxy out.
  stop_proxy
  local wait_until=$(($(now_ms) + NO_HEARTBEAT_BUDGET_MS + slack_ms))
  while true; do
    query_device_entry "${second_serial}"
    [[ -n "${entry}" ]] || break
    (($(now_ms) < wait_until)) || die "${second_serial} still held after the proxy exited"
    "${SLEEP_CMD}" 1
  done
  assert_device_alive
  ADB_SERIAL_OVERRIDE="${second_serial}" assert_device_alive
  finish_scenario
}

start_stream_subscriber() {
  local socket="${AUTOMOBILE_AUX_SOCKET_DIR}/observation-stream.sock"
  rm -f "${work_dir}/stream.in"
  mkfifo "${work_dir}/stream.in"
  : > "${evidence_dir}/${current_scenario}.stream.frames"
  "${NC}" -U "${socket}" < "${work_dir}/stream.in" >> "${evidence_dir}/${current_scenario}.stream.frames" \
    2>> "${work_dir}/stream.stderr" &
  subscriber_pid=$!
  exec 9> "${work_dir}/stream.in"
  subscriber_fd_open=true
  jq -cn --arg device "${serial}" '{id: "1", command: "subscribe", deviceId: $device}' >&9 ||
    die "could not subscribe to the observation stream"
}

stop_stream_subscriber() {
  if [[ "${subscriber_fd_open}" == true ]]; then
    exec 9>&-
    subscriber_fd_open=false
  fi
  if [[ -n "${subscriber_pid}" ]]; then
    "${SLEEP_CMD}" 1
    kill "${subscriber_pid}" 2> /dev/null || true
    wait "${subscriber_pid}" 2> /dev/null || true
    subscriber_pid=""
  fi
}

# A subscriber on the held device sees the idle release as a session event, not as the end of the
# stream: the subscription must be acknowledged, and no device_session_ended frame may arrive,
# because releasing the agent's session leaves the device's epoch (and its stream) running.
scenario_stream() {
  current_scenario="stream"
  acquire_device
  start_stream_subscriber
  local acquired frames="${evidence_dir}/stream.stream.frames"
  acquired="$(now_ms)"
  local attempts=0
  while ! grep -q '"subscription_response"' "${frames}" 2> /dev/null && ((attempts < 15)); do
    "${SLEEP_CMD}" 1
    attempts=$((attempts + 1))
  done
  grep -q '"subscription_response"' "${frames}" || die "the observation stream never acknowledged the subscription"
  jq -e -s 'map(select(.type == "subscription_response")) | first | .success == true' "${frames}" > /dev/null ||
    die "the observation stream refused the subscription: $(head -c 300 "${frames}")"
  wait_for_release $((acquired + idle_timeout_ms + SUSPECT_GRACE_MS + MONITOR_SCAN_MS + slack_ms)) ||
    die "${serial} still held after the ${idle_timeout_ms} ms idle window"
  # Give a late frame time to arrive before judging the stream.
  "${SLEEP_CMD}" 2
  kill -0 "${subscriber_pid}" 2> /dev/null || die "the observation stream closed the subscriber when the session was idle-released"
  if grep -q '"device_session_ended"' "${frames}"; then
    die "the idle release pushed device_session_ended; the device epoch must outlive the agent session"
  fi
  log "stream: subscription stayed open across the idle release; frames in ${frames}"
  stop_stream_subscriber
  stop_proxy
  finish_scenario
}

cleanup() {
  local status=$?
  stop_stream_subscriber || true
  if [[ -n "${proxy_pid}" ]]; then
    stop_proxy || true
  fi
  close_proxy_fds
  if [[ -n "${work_dir}" ]]; then
    if ! stop_daemon; then
      log "warning: the private daemon did not stop; keeping ${work_dir} for inspection"
      keep_work_dir=true
    fi
    if [[ -d "${AUTOMOBILE_LOG_DIR:-}" && -n "${evidence_dir}" ]]; then
      cp -R "${AUTOMOBILE_LOG_DIR}" "${evidence_dir}/daemon-logs" 2> /dev/null || true
    fi
    if ((status != 0)); then
      keep_work_dir=true
    fi
    if [[ "${created_work_dir}" == true && "${keep_work_dir}" != true ]]; then
      rm -rf "${work_dir}"
    elif [[ "${keep_work_dir}" == true ]]; then
      log "kept ${work_dir}"
    fi
  fi
  exit "${status}"
}

# Run every scenario, each in its own subshell, so one failing scenario (its die exits only that
# subshell) does not hide the verdict of the scenarios after it. The run still fails if any did.
run_all_scenarios() {
  local names=(active no-heartbeat idle stdin-eof selector stream)
  local name status failed=()
  if [[ -n "${second_serial}" ]]; then
    names+=(two-devices)
  fi
  for name in "${names[@]}"; do
    # errexit is off around the subshell (a `||` would disable it inside too), then back on in it.
    set +e
    (
      set -e
      trap 'stop_stream_subscriber || true; stop_proxy || true; close_proxy_fds' EXIT
      "scenario_${name//-/_}"
    )
    status=$?
    set -e
    if ((status != 0)); then
      failed+=("${name}")
      # The failed scenario's proxy is gone; give its device time to release before the next one.
      wait_for_release $(($(now_ms) + NO_HEARTBEAT_BUDGET_MS + slack_ms)) || true
    fi
  done
  if ((${#failed[@]} > 0)); then
    log "FAILED scenarios: ${failed[*]}"
    exit 1
  fi
}

main() {
  parse_args "$@"
  validate_args
  [[ "$("${ADB}" -s "${serial}" get-state 2> /dev/null || true)" == "device" ]] ||
    die "${serial} is not an online adb device"
  trap cleanup EXIT
  # A write to a proxy that died must fail the write, not kill this script silently.
  trap '' PIPE
  trap 'exit 130' INT
  trap 'exit 143' TERM
  setup_private_namespace
  start_daemon
  case "${scenario}" in
    all) run_all_scenarios ;;
    active) scenario_active ;;
    no-heartbeat) scenario_no_heartbeat ;;
    idle) scenario_idle ;;
    stdin-eof) scenario_stdin_eof ;;
    selector) scenario_selector ;;
    stream) scenario_stream ;;
    two-devices) scenario_two_devices ;;
    provision) scenario_provision ;;
  esac
  log "all requested scenarios passed"
}

main "$@"
