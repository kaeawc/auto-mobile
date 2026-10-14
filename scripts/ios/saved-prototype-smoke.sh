#!/usr/bin/env bash
# Advisory iOS simulator smoke for saved home-screen prototypes.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
device_id="${1:-}"
if [[ -z "$device_id" ]]; then echo 'usage: saved-prototype-smoke.sh <simulator-udid>' >&2; exit 1; fi
cli_words="${AUTO_MOBILE_CMD:-auto-mobile --debug --embedded-sdk --cli}"
read -r -a cli_base <<< "$cli_words"
xcrun_bin="${XCRUN_BIN:-xcrun}"
session_uuid="${SMOKE_SESSION_UUID:-}"
acquired_session=0
saved_id=""
bundle_id=""
cli_stdout=""
cli_stderr=""
cli_status=0
spec='{"id":"smoke-saved-12259","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Saved smoke"}}'
label='Saved smoke 12259'
template="${AUTOMOBILE_IOS_PROTOTYPE_VIEWER_TEMPLATE:-}"
viewer="${AUTOMOBILE_IOS_PROTOTYPE_VIEWER:-}"
skip_template='skipped: iOS prototype viewer template unavailable (set AUTOMOBILE_IOS_PROTOTYPE_VIEWER_TEMPLATE or provide the release asset)'
# shellcheck source=scripts/lib/session-release.sh disable=SC1091
source "${script_dir}/../lib/session-release.sh"
cli() { "${cli_base[@]}" "$@"; }
call_cli() {
  local stdout_file stderr_file
  cli_status=0; stdout_file="$(mktemp)"; stderr_file="$(mktemp)"
  set +e; cli "$@" >"$stdout_file" 2>"$stderr_file"; cli_status=$?; set -e
  cli_stdout="$(cat "$stdout_file")"; cli_stderr="$(cat "$stderr_file")"
  rm -f "$stdout_file" "$stderr_file"; return 0
}
result_json() { jq -c 'if .content? then ([.content[] | select(.type == "text") | .text | (fromjson? // empty)][0] // {}) else . end' <<< "$1" 2>/dev/null || printf '{}\n'; }
step_error() { echo "error: $1: $2" >&2; exit 1; }
call_saved() { call_cli --session-uuid "$session_uuid" prototype --deviceId "$device_id" --action "$1" "${@:2}"; }
delete_saved() { call_saved deleteSaved --id "$saved_id"; [[ "$cli_status" -eq 0 && "$(jq -r '.success // false' <<< "$(result_json "$cli_stdout")")" == true ]]; }
cleanup_saved() {
  local status=$?
  set +e
  if [[ $status -ne 0 && -n "$saved_id" && -n "$session_uuid" ]]; then delete_saved; fi
  set +e # call_cli re-enables errexit
  if [[ "$acquired_session" -eq 1 ]]; then (exit "$status"); session_release_on_exit; fi
  return "$status"
}
trap cleanup_saved EXIT
if [[ -z "$template" || ! -d "$template" ]]; then
  if [[ -z "$viewer" || ! -d "$viewer" ]]; then echo "$skip_template"; exit 0; fi
fi
if [[ -z "$session_uuid" ]]; then
  call_cli getApple --deviceId "$device_id"
  [[ "$cli_status" -eq 0 ]] || step_error getApple "${cli_stdout}${cli_stderr:+ $cli_stderr}"
  session_uuid="$(jq -er 'if (.runtime?.session?.sessionUuid // .sessionUuid) then (.runtime.session.sessionUuid // .sessionUuid) elif .content? then (.content[] | select(.type == "text") | .text | fromjson | (.runtime.session.sessionUuid // .sessionUuid)) else empty end | select(type == "string" and length > 0)' <<< "$cli_stdout")" || step_error getApple "could not parse session UUID${cli_stderr:+: $cli_stderr}"
  acquired_session=1; install_session_release_trap "$session_uuid"; trap cleanup_saved EXIT
fi
call_saved listSaved
list_output="$cli_stdout"; list_status="$cli_status"; parsed="$(result_json "$list_output")"
error_code="$(jq -r '.errorCode // empty' <<< "$parsed")"
if [[ "$error_code" == unsupported_capability || "$error_code" == unsupported_platform || "$list_output $cli_stderr" =~ [Uu]nknown.*action|[Ii]nvalid.*action|[Ii]nvalid\ enum ]]; then
  echo 'skipped: iOS saved prototype actions not available in this build'
  echo "reason: ${list_output}${cli_stderr:+ $cli_stderr}" >&2; exit 0
fi
[[ "$list_status" -eq 0 && "$(jq -r '.success // false' <<< "$parsed")" == true ]] || step_error listSaved "${list_output}${cli_stderr:+ $cli_stderr}"
call_saved deleteSaved --id smoke-saved-12259
stale="$(result_json "$cli_stdout")"
if [[ "$cli_status" -ne 0 || "$(jq -r '.success // false' <<< "$stale")" != true ]]; then
  [[ "$(jq -r '.errorCode // empty' <<< "$stale")" == not_found ]] || step_error deleteSaved "stale cleanup failed: ${cli_stdout}${cli_stderr:+ $cli_stderr}"
fi
call_saved save --spec "$spec" --label "$label"
save_output="$cli_stdout"; parsed="$(result_json "$save_output")"
if [[ "$cli_status" -ne 0 ]]; then
  missing_template_text="$(printf '%s' "$save_output $cli_stderr" | tr '[:upper:]' '[:lower:]')"
  if [[ "$missing_template_text" == *viewer_template* || "$missing_template_text" == *prototype-viewer-build* || "$missing_template_text" == *'viewer template'* ]]; then echo "$skip_template"; exit 0; fi
  step_error save "${save_output}${cli_stderr:+ $cli_stderr}"
fi
saved_id="$(jq -r 'select(.success == true) | .saved.id // empty' <<< "$parsed")"
slug="$(jq -r 'select(.success == true) | .saved.slug // empty' <<< "$parsed")"
[[ -n "$saved_id" && -n "$slug" ]] || step_error save "$save_output"
bundle_id="dev.jasonpearson.automobile.proto.${slug}"
echo 'ok: save'
call_saved listSaved; parsed="$(result_json "$cli_stdout")"
[[ "$cli_status" -eq 0 ]] || step_error listSaved "${cli_stdout}${cli_stderr:+ $cli_stderr}"
set +e
jq -e --arg id "$bundle_id" 'any(.savedPrototypes[]?; .id == $id)' <<< "$parsed" >/dev/null 2>&1
listed_status=$?
set -e
[[ "$listed_status" -eq 0 ]] || step_error listSaved "${bundle_id} not found"
echo 'ok: listSaved'
"$xcrun_bin" simctl launch "$device_id" "$bundle_id" >/dev/null || step_error launch 'simctl launch failed'
sleep "${SMOKE_LAUNCH_SETTLE_SECONDS:-2}"
echo 'ok: launch'
call_cli --session-uuid "$session_uuid" observe --platform ios --deviceId "$device_id"
parsed="$(result_json "$cli_stdout")"
[[ "$cli_status" -eq 0 ]] || step_error observe "${cli_stdout}${cli_stderr:+ $cli_stderr}"
if jq -e 'has("success") and (.success | type == "boolean")' <<< "$parsed" >/dev/null 2>&1; then [[ "$(jq -r '.success' <<< "$parsed")" == true ]] || step_error observe "$cli_stdout"; fi
echo 'ok: observe'
call_saved save --spec "$spec" --label "$label"; parsed="$(result_json "$cli_stdout")"
[[ "$cli_status" -eq 0 && "$(jq -r '.success // false' <<< "$parsed")" == true && "$(jq -r '.saved.replaced // false' <<< "$parsed")" == true ]] || step_error 'save again (replaced)' "${cli_stdout}${cli_stderr:+ $cli_stderr}"
echo 'ok: save again (replaced)'
call_saved deleteSaved --id "$bundle_id"; parsed="$(result_json "$cli_stdout")"
[[ "$cli_status" -eq 0 && "$(jq -r '.success // false' <<< "$parsed")" == true ]] || step_error deleteSaved "${cli_stdout}${cli_stderr:+ $cli_stderr}"
echo 'ok: deleteSaved'
saved_id="$bundle_id"
call_saved listSaved; parsed="$(result_json "$cli_stdout")"
[[ "$cli_status" -eq 0 ]] || step_error listSaved "${cli_stdout}${cli_stderr:+ $cli_stderr}"
set +e
jq -e --arg id "$bundle_id" 'any(.savedPrototypes[]?; .id == $id)' <<< "$parsed" >/dev/null 2>&1
listed_status=$?
set -e
if [[ "$listed_status" -eq 0 ]]; then step_error deleteSaved "${bundle_id} still listed"; fi
