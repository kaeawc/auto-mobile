#!/usr/bin/env bash
# Advisory end-to-end check for saved home-screen prototypes.
set -euo pipefail

adb_bin="${ADB_BIN:-adb}"
cli_words="${AUTO_MOBILE_CMD:-auto-mobile --debug --embedded-sdk --cli}"
read -r -a cli_base <<< "$cli_words"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
device_id="${1:-}"
session_uuid="${SMOKE_SESSION_UUID:-}"
acquired_session=0
saved_id=""
launch_available=1
cli_stdout=""
cli_stderr=""
cli_status=0
spec='{"id":"smoke-saved-12269","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Saved smoke"}}'
label='Saved smoke 12269'

# shellcheck source=scripts/lib/session-release.sh
source "${script_dir}/../lib/session-release.sh"

cli() {
  "${cli_base[@]}" "$@"
}

# Keep machine-readable stdout isolated from diagnostics printed on stderr.
call_cli() {
  local stdout_file stderr_file
  cli_status=0
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  set +e
  cli "$@" >"$stdout_file" 2>"$stderr_file"
  cli_status=$?
  set -e
  cli_stdout="$(cat "$stdout_file")"
  cli_stderr="$(cat "$stderr_file")"
  rm -f "$stdout_file" "$stderr_file"
  return 0
}

step_error() { echo "error: $1: $2" >&2; exit 1; }

result_json() {
  jq -c 'if .content? then ([.content[] | select(.type == "text") | .text | (fromjson? // empty)][0] // {}) else . end' <<< "$1" 2>/dev/null || printf '{}\n'
}

has_id() {
  jq -e --arg id "$saved_id" 'any(.savedPrototypes[]?; .id == $id)' <<< "$1" >/dev/null 2>&1
}

delete_saved() {
  call_cli prototype --session-uuid "$session_uuid" --deviceId "$device_id" --action deleteSaved --id "$saved_id"
  [[ "$cli_status" -eq 0 && "$(jq -r '.success // false' <<< "$(result_json "$cli_stdout")")" == true ]]
}

cleanup_saved() {
  local status=$?
  if [[ $status -ne 0 && -n "$saved_id" ]]; then
    set +e
    delete_saved
    set -e
  fi
  if [[ "$acquired_session" -eq 1 ]]; then
    (exit "$status")
    session_release_on_exit
  fi
  return "$status"
}
trap cleanup_saved EXIT

if [[ -z "$device_id" ]]; then
  device_id="$("$adb_bin" devices | awk '$2 == "device" { print $1; exit }')"
fi
if [[ -z "$device_id" ]]; then echo 'error: no connected Android device' >&2; exit 1; fi
if ! "$adb_bin" -s "$device_id" root >/dev/null 2>&1; then
  echo 'skipped: launch step: adb root unavailable (SavedPrototypeActivity is not exported)'
  launch_available=0
else
  "$adb_bin" -s "$device_id" wait-for-device
fi
if [[ -z "$session_uuid" ]]; then
  call_cli getAndroid --deviceId "$device_id" --automation-ready-timeout-ms 120000
  session_result="$cli_stdout"
  [[ "$cli_status" -eq 0 ]] || { echo "error: could not acquire Android session${cli_stderr:+: $cli_stderr}" >&2; exit 1; }
  session_uuid="$(jq -er 'if (.runtime?.session?.sessionUuid // .sessionUuid) then (.runtime.session.sessionUuid // .sessionUuid) elif .content? then (.content[] | select(.type == "text") | .text | fromjson | (.runtime.session.sessionUuid // .sessionUuid)) else empty end | select(type == "string" and length > 0)' <<< "$session_result")" || { echo "error: could not parse Android session UUID${cli_stderr:+: $cli_stderr}" >&2; exit 1; }
  acquired_session=1
  install_session_release_trap "$session_uuid"
  trap cleanup_saved EXIT
fi

call_saved() { call_cli prototype --session-uuid "$session_uuid" --deviceId "$device_id" --action "$1" "${@:2}"; }
list_result=""
list_status=0
call_saved listSaved
list_result="$cli_stdout"
list_status="$cli_status"
parsed="$(result_json "$list_result")"
code="$(jq -r '.errorCode // empty' <<< "$parsed")"
if [[ "$code" == unsupported_capability ]]; then echo 'skipped: capability prototype_saved_v1 not advertised'; exit 0; fi
if [[ "$code" == unsupported_platform ]]; then echo 'skipped: saved prototypes are not supported on this platform'; exit 0; fi
if [[ "$list_result" =~ [Uu]nknown.*action|[Ii]nvalid.*action || "$cli_stderr" =~ [Uu]nknown.*action|[Ii]nvalid.*action ]]; then
  echo 'skipped: capability prototype_saved_v1 not advertised'
  echo "reason: ${list_result}${cli_stderr:+ $cli_stderr}" >&2
  exit 0
fi
if [[ $list_status -ne 0 || "$(jq -r '.success // false' <<< "$parsed")" != true ]]; then echo "error: listSaved: ${list_result}${cli_stderr:+ $cli_stderr}" >&2; exit 1; fi

call_saved deleteSaved --id smoke-saved-12269
stale_result="$cli_stdout"
stale_parsed="$(result_json "$stale_result")"
if [[ "$cli_status" -ne 0 || "$(jq -r '.success // false' <<< "$stale_parsed")" != true ]]; then
  [[ "$(jq -r '.errorCode // empty' <<< "$stale_parsed")" == not_found ]] || step_error deleteSaved "could not remove stale entry: ${stale_result}${cli_stderr:+ $cli_stderr}"
fi
call_saved save --spec "$spec" --label "$label"
save_result="$cli_stdout"
[[ "$cli_status" -eq 0 ]] || step_error save "${save_result}${cli_stderr:+ $cli_stderr}"
parsed="$(result_json "$save_result")"
saved_id="$(jq -r 'select(.success == true) | .saved.id // empty' <<< "$parsed")"
[[ -n "$saved_id" ]] || step_error save "${save_result}${cli_stderr:+ $cli_stderr}"
echo 'ok: save'

call_saved listSaved
list_result="$cli_stdout"
[[ "$cli_status" -eq 0 ]] || step_error listSaved "${list_result}${cli_stderr:+ $cli_stderr}"
parsed="$(result_json "$list_result")"
set +e
has_id "$parsed"
has_id_status=$?
set -e
[[ "$has_id_status" -eq 0 ]] || step_error listSaved "saved id ${saved_id} not found${cli_stderr:+: $cli_stderr}"
echo 'ok: listSaved'

call_saved save --spec "$spec" --label "$label" --pin true
pin_result="$cli_stdout"
[[ "$cli_status" -eq 0 ]] || step_error pin "${pin_result}${cli_stderr:+ $cli_stderr}"
parsed="$(result_json "$pin_result")"
pinned="$(jq -r '.pinned // empty' <<< "$parsed")"
if [[ "$pinned" == unsupported ]]; then
  echo 'skipped: pin step: pinning not available in this build'
else
  [[ "$(jq -r '.success // false' <<< "$parsed")" == true ]] || step_error pin "${pin_result}${cli_stderr:+ $cli_stderr}"
  echo "ok: pin (pinned=${pinned})"
fi

if [[ "$launch_available" -eq 1 ]]; then
  # Saved prototype IDs are restricted to [a-z0-9-], so the deep-link URI needs no encoding.
  "$adb_bin" -s "$device_id" shell am start -W -n dev.jasonpearson.automobile.ctrlproxy/.prototype.SavedPrototypeActivity -d "automobile-saved-prototype:/${saved_id}" >/dev/null || step_error launch 'activity start failed'
  appeared=0
  for ((attempt=0; attempt<10; attempt++)); do
    activity_output="$("$adb_bin" -s "$device_id" shell dumpsys activity activities 2>/dev/null)"
    if [[ "$activity_output" == *SavedPrototypeActivity* ]]; then appeared=1; break; fi
    sleep "${SMOKE_POLL_SLEEP:-1}"
  done
  [[ $appeared -eq 1 ]] || step_error launch 'SavedPrototypeActivity did not appear'
  "$adb_bin" -s "$device_id" shell input keyevent 4 >/dev/null 2>&1 || true
  echo 'ok: launch'
fi

call_saved deleteSaved --id "$saved_id"
delete_result="$(result_json "$cli_stdout")"
[[ "$cli_status" -eq 0 && "$(jq -r '.success // false' <<< "$delete_result")" == true ]] || step_error deleteSaved "delete failed${cli_stderr:+: $cli_stderr}"
echo 'ok: deleteSaved'
call_saved listSaved
list_result="$cli_stdout"
[[ "$cli_status" -eq 0 ]] || step_error listSaved "${list_result}${cli_stderr:+ $cli_stderr}"
parsed="$(result_json "$list_result")"
set +e
has_id "$parsed"
has_id_status=$?
set -e
if [[ "$has_id_status" -eq 0 ]]; then step_error deleteSaved "saved id ${saved_id} still listed"; fi
