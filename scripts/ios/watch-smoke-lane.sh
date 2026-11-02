#!/usr/bin/env bash
# Advisory watchOS smoke. Owns one fresh simulator and a private daemon namespace.
# One shell owns logging and cleanup; interruption stops the active timed command.
# Usage: watch-smoke-lane.sh <watchos-version|latest>
# Seams: XCRUN_BIN, LSOF_BIN, AUTO_MOBILE_CMD (whitespace-separated argv), WATCH_SMOKE_LOG_DIR.
# Exit: 0 pass, 1 setup/check failure, 2 usage/isolation refusal, 3 runtime unavailable.
set -euo pipefail

if [[ $# -ne 1 || ! ${1:-} =~ ^(latest|[0-9]+(\.[0-9]+)*)$ ]]; then
  echo 'usage: watch-smoke-lane.sh <watchos-version|latest>' >&2
  exit 2
fi
requested="$1"
# Require an existing, owner-only directory. Canonicalize before checking aliases.
aux_parent="${AUTOMOBILE_AUX_SOCKET_DIR:-}"
if [[ ${aux_parent} != /* || ! -d ${aux_parent} || ! -O ${aux_parent} ]]; then
  echo 'watch-smoke-lane: AUTOMOBILE_AUX_SOCKET_DIR must be an existing private non-default absolute directory' >&2
  exit 2
fi
aux_parent="$(cd "${aux_parent}" && pwd -P)"
aux_mode="$(stat -c '%a' "${aux_parent}" 2>/dev/null || stat -f '%Lp' "${aux_parent}")"
if [[ ${aux_mode} != 700 || ${aux_parent} == / || ${aux_parent} == /tmp || ${aux_parent} == /private/tmp || ${aux_parent} == "${HOME}" || ${aux_parent} == "${HOME}/.auto-mobile" || ${aux_parent} == "${HOME}/.auto-mobile/"* ]]; then
  echo 'watch-smoke-lane: AUTOMOBILE_AUX_SOCKET_DIR must be private (mode 700) and non-default' >&2
  exit 2
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${script_dir}/../.."
xcrun_bin="${XCRUN_BIN:-xcrun}"
log_dir="${WATCH_SMOKE_LOG_DIR:-scratch/watch-smoke-lane/${requested}}"
mkdir -p "${log_dir}"
log_dir="$(cd "${log_dir}" && pwd)"
exec > >(tee -a "${log_dir}/smoke.log") 2>&1
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${script_dir}/run_with_timeout.sh"
export AUTO_MOBILE_CMD="${AUTO_MOBILE_CMD:-bun run src/index.ts --debug --embedded-sdk --cli}"
# shellcheck source=scripts/lib/session-release.sh
source "${script_dir}/../lib/session-release.sh"
fail() { echo "watch-smoke-lane: FAIL: $*" >&2; exit 1; }
daemon_port="${WATCH_SMOKE_DAEMON_PORT-$((40000 + $$ % 25536))}"
if [[ ! ${daemon_port} =~ ^[0-9]{1,5}$ ]] || ((10#${daemon_port} < 40000 || 10#${daemon_port} > 65535)); then
  echo 'watch-smoke-lane: WATCH_SMOKE_DAEMON_PORT must be numeric and between 40000 and 65535 (never 3000)' >&2
  exit 2
fi
daemon_port=$((10#${daemon_port}))
lsof_bin="${LSOF_BIN:-lsof}"
command -v "${lsof_bin}" >/dev/null || fail 'lsof is required to check the private daemon port'
if "${lsof_bin}" -nP -iTCP:"${daemon_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "private daemon port ${daemon_port} is already listening"
fi
read -r -a cli_base <<< "${AUTO_MOBILE_CMD}"
daemon_base=()
daemon_flags=()
in_flags=0
has_entrypoint=0
for word in ${cli_base[@]+"${cli_base[@]}"}; do
  case "${word}" in
    *.ts | *.js | *.mjs | *.cjs | *.mts | *.cts) has_entrypoint=1; break ;;
  esac
done
after_entrypoint=0
for word in ${cli_base[@]+"${cli_base[@]}"}; do
  # --cli is a command boundary: parseValueOptions stops there, hiding --port.
  # Preserve all startup flags so daemon and client reuse-critical options match.
  [[ ${word} == --cli ]] && continue
  daemon_base+=("${word}")
  if [[ ${has_entrypoint} == 1 ]]; then
    # Runtime options belong only in the executable prefix.
    if [[ ${after_entrypoint} == 1 ]]; then in_flags=1; fi
    case "${word}" in
      *.ts | *.js | *.mjs | *.cjs | *.mts | *.cts) after_entrypoint=1 ;;
    esac
  elif [[ ${word} == --* ]]; then
    in_flags=1
  fi
  if [[ ${in_flags} == 1 ]]; then daemon_flags+=("${word}"); fi
done
[[ ${#daemon_base[@]} -gt 0 ]] || fail 'AUTO_MOBILE_CMD has no executable'
udid=""
aux_dir=""
daemon_started=0
session_uuid=""
inflight_dir="$(mktemp -d "${log_dir}/inflight.XXXXXX")"
terminate() {
  trap - INT TERM
  local record command_pid watcher_pid _caller_pid
  for record in "${inflight_dir}"/pgid.*; do
    [[ -f ${record} ]] || continue
    read -r command_pid watcher_pid _caller_pid < "${record}" || continue
    # run_with_timeout gives the command and watchdog their own groups.
    kill -TERM -"${command_pid}" -"${watcher_pid}" 2>/dev/null || true
    sleep 0.1
    kill -KILL -"${command_pid}" -"${watcher_pid}" 2>/dev/null || true
    wait "${command_pid}" "${watcher_pid}" 2>/dev/null || true
  done
  exit 1
}
cleanup() {
  local result=$? release_output cleanup_status
  trap - EXIT
  if [[ -n ${udid} ]]; then
    if [[ ${result} -ne 0 ]]; then
      set +e
      run_with_timeout 30 "${xcrun_bin}" simctl io "${udid}" screenshot "${log_dir}/failure.png"
      set -e
    fi
  fi
  if [[ -n ${session_uuid} ]]; then
    # The shared helper exits; use a subshell so owned-resource cleanup continues.
    set +e
    release_output="$(session_release_on_exit 2>&1)"
    cleanup_status=$?
    set -e
    if [[ ${cleanup_status} -ne 0 ]]; then result=1; fi
    if [[ -n ${release_output} ]]; then
      echo "${release_output}" >&2
      result=1
    fi
  fi
  if [[ ${daemon_started} == 1 ]]; then
    set +e
    run_with_timeout 60 ${daemon_base[@]+"${daemon_base[@]}"} --daemon stop
    cleanup_status=$?
    set -e
    if [[ ${cleanup_status} -ne 0 ]]; then
      echo 'watch-smoke-lane: private daemon stop failed' >&2
      result=1
    fi
  fi
  if [[ -n ${udid} ]]; then
    set +e
    run_with_timeout 60 "${xcrun_bin}" simctl shutdown "${udid}"
    run_with_timeout 120 "${xcrun_bin}" simctl delete "${udid}"
    cleanup_status=$?
    set -e
    if [[ ${cleanup_status} -ne 0 ]]; then
      echo "watch-smoke-lane: could not delete owned simulator ${udid}" >&2
      result=1
    fi
  fi
  [[ -z ${aux_dir} ]] || rm -rf -- "${aux_dir}"
  rm -rf -- "${inflight_dir}"
  exit "${result}"
}
trap cleanup EXIT
trap terminate INT TERM

set +e
runtimes="$(run_with_timeout 60 "${xcrun_bin}" simctl list runtimes available watchOS --json)"
command_status=$?
set -e
[[ ${command_status} -eq 0 ]] || fail 'could not list runtimes'
runtime="$(jq -cer --arg p "${requested}" '
  [.runtimes[] | select(.isAvailable != false)
   | select(.identifier | startswith("com.apple.CoreSimulator.SimRuntime.watchOS-"))
   | select($p == "latest" or .version == $p or (.version | startswith($p + ".")))]
  | sort_by(.version | split(".") | map(tonumber)) | last // {}' <<< "${runtimes}")" || fail 'could not parse runtimes'
if [[ ${runtime} == '{}' ]]; then
  echo "watch-smoke-lane: no matching watchOS runtime for ${requested}; skipping"
  exit 3
fi
runtime_id="$(jq -er '.identifier' <<< "${runtime}")"
version="$(jq -er '.version' <<< "${runtime}")"
device_type="$(jq -er '[.supportedDeviceTypes[] | select(.productFamily == "Apple Watch")][0].identifier // empty' <<< "${runtime}")" || fail 'runtime has no supported Apple Watch device type'
run_tag=runlocal
if [[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]]; then run_tag="run${GITHUB_RUN_ID}"; fi
set +e
udid="$(run_with_timeout 60 "${xcrun_bin}" simctl create "watch-smoke-${version}-${run_tag}-epoch$(date +%s)-$$" "${device_type}" "${runtime_id}")"
command_status=$?
set -e
[[ ${command_status} -eq 0 ]] || fail 'simctl create failed'
[[ ${udid} =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || { udid=""; fail 'simctl create returned invalid UDID'; }
set +e
run_with_timeout 60 "${xcrun_bin}" simctl boot "${udid}"
command_status=$?
set -e
[[ ${command_status} -eq 0 ]] || fail 'boot failed'
set +e
run_with_timeout 300 "${xcrun_bin}" simctl bootstatus "${udid}" -b
command_status=$?
set -e
[[ ${command_status} -eq 0 ]] || fail 'boot readiness failed'

# Clear inherited routing, then supply every state location in this lane's namespace.
while IFS= read -r name; do
  case "${name}" in
    AUTOMOBILE_DAEMON_* | AUTO_MOBILE_DAEMON_* | AUTOMOBILE_SESSION_* | AUTO_MOBILE_SESSION_*) unset "${name}" ;;
  esac
done <<< "$(compgen -e)"
aux_dir="$(mktemp -d "${aux_parent}/lane.XXXXXX")"
export AUTOMOBILE_AUX_SOCKET_DIR="${aux_dir}"
export AUTOMOBILE_DAEMON_SOCKET_PATH="${aux_dir}/control.sock"
export AUTOMOBILE_DAEMON_PID_FILE_PATH="${aux_dir}/daemon.pid"
export AUTOMOBILE_DAEMON_LOCK_FILE_PATH="${aux_dir}/daemon.lock"
export AUTOMOBILE_DAEMON_TOKEN_FILE_PATH="${aux_dir}/daemon.token"
export AUTOMOBILE_DATA_DIR="${aux_dir}/data"
export AUTOMOBILE_DB_DIR="${aux_dir}/db"
export AUTOMOBILE_DB_PATH="${AUTOMOBILE_DB_DIR}/auto-mobile.db"
unset AUTO_MOBILE_DB_PATH
export AUTOMOBILE_LOG_DIR="${log_dir}/daemon"
export AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA="${log_dir}/derived-data"
export AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true
# Build the existing fixture and service, without creating another target or simulator.
set +e
AUTOMOBILE_RUN_WITH_TIMEOUT_PGID_FILE="${inflight_dir}/pgid" run_with_timeout 600 xcodebuild build-for-testing \
  -project ios/control-proxy/CtrlProxy.xcodeproj -scheme CtrlProxyWatch \
  -destination "platform=watchOS Simulator,id=${udid}" \
  -derivedDataPath "${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA}" CODE_SIGNING_ALLOWED=NO
command_status=$?
set -e
[[ ${command_status} -eq 0 ]] || fail 'fixture build failed'
set +e
run_with_timeout 60 "${xcrun_bin}" simctl install "${udid}" \
  "${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA}/Build/Products/Debug-watchsimulator/CtrlProxyWatch.app"
command_status=$?
set -e
[[ ${command_status} -eq 0 ]] || fail 'fixture install failed'
# DaemonClient connects to AUTOMOBILE_DAEMON_SOCKET_PATH, not the HTTP port
# (wire/constants.ts, client/clientSocketConnector.ts). AUX also isolates state;
# ordinary CLI calls and cleanup share this socket env and need no --port.
call_tool() {
  local step="$1" command_status
  local -a session_args=() target_args=(--deviceId "${udid}")
  shift
  if [[ ${step} == startDevice ]]; then
    target_args=(--platform watchos --deviceId "${udid}")
  else
    [[ -n ${session_uuid} ]] || fail "${step} requires an acquired session"
    session_args=(--session-uuid "${session_uuid}")
  fi
  set +e
  run_with_timeout 300 ${cli_base[@]+"${cli_base[@]}"} ${session_args[@]+"${session_args[@]}"} "${step}" ${target_args[@]+"${target_args[@]}"} "$@" > "${log_dir}/${step}.json"
  command_status=$?
  set -e
  [[ ${command_status} -eq 0 ]] || fail "${step} CLI failed"
  cat "${log_dir}/${step}.json"
  jq -e --arg step "${step}" 'def ok: .success == true or ($step == "startDevice" and .success != false) or ($step == "observe" and (.screenshotPath | type == "string"));
    if .isError == true then false elif .content? then
    [.content[] | select(.type == "text") | .text | fromjson?] | any(ok)
    else ok end'  "${log_dir}/${step}.json" >/dev/null || fail "${step} returned failure"
}
# Acquisition is the only sessionless tool call, always pinned to this lane's UDID.
# A failed start can leave a daemon behind; arm cleanup before attempting it.
daemon_started=1
# runStartup passes only the tail after --daemon start to parseDaemonArgs;
# prefix flags configure this launcher but must also be repeated for its child.
set +e
run_with_timeout 60 ${daemon_base[@]+"${daemon_base[@]}"} --daemon start ${daemon_flags[@]+"${daemon_flags[@]}"} --port "${daemon_port}"
command_status=$?
set -e
[[ ${command_status} -eq 0 ]] || fail 'private daemon start failed'
call_tool startDevice
jq 'if .content? then [.content[] | select(.type == "text") | .text | fromjson?][0] else . end' \
  "${log_dir}/startDevice.json" > "${log_dir}/session.json"
session_uuid="$(jq -er '(.runtime.session.sessionUuid // .sessionUuid) | select(type == "string" and length > 0)' \
  "${log_dir}/session.json")" || fail 'startDevice returned no session UUID; refusing sessionless calls'
install_session_release_trap "${session_uuid}"
# Compose release with owned-resource cleanup and preserve this lane's signal exit codes.
trap cleanup EXIT
trap terminate INT TERM
check_identifier() {
  # Observe can put label-only watch rows in context; full nodes use resource-id.
  jq -e --arg id "$1" 'any(.context[]?; .elementId == $id or .label == $id) or
    any(.skeleton[]?; .elementId == $id) or
    any(.viewHierarchy? | .. | objects; .["resource-id"]? == $id)' \
    "${log_dir}/hierarchy.json" >/dev/null || fail "missing identifier $1"
}
observe() {
  call_tool observe --platform watchos
  # Decode MCP text envelopes while retaining plain CLI JSON results.
  jq 'if .content? then [.content[] | select(.type == "text") | .text | fromjson?][0] else . end' \
    "${log_dir}/observe.json" > "${log_dir}/hierarchy.json"
  jq -e '.hierarchyUnavailable == null and
    ((.context | type == "array") or (.skeleton | type == "array") or (.viewHierarchy.hierarchy | type == "object"))' \
    "${log_dir}/hierarchy.json" >/dev/null || \
    fail "watchOS observe returned no hierarchy for session ${session_uuid} on ${udid}; identifier checks require a connected watch runner (see ${log_dir}/observe.json)"
}
observe
cp "${log_dir}/observe.json" "${log_dir}/before.json"
check_identifier watch-smoke-row
run_with_timeout 30 "${xcrun_bin}" simctl io "${udid}" screenshot "${log_dir}/before.png"
call_tool tapOn --selector '{"text":"watch-smoke-row"}'
observe
check_identifier watch-smoke-next
run_with_timeout 30 "${xcrun_bin}" simctl io "${udid}" screenshot "${log_dir}/after.png"
echo 'watch-smoke-lane: PASS'
