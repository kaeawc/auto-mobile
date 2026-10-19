#!/usr/bin/env bash
# Boot an Android AVD and probe system-wide vs per-app locale commands.

set -euo pipefail

AVD_NAME="${AVD_NAME:-Pixel_9}"
LOCALE="${LOCALE:-fr-FR}"
APP_ID="${APP_ID:-com.android.settings}"
ADB_SERIAL="${ADB_SERIAL:-}"
BOOT_TIMEOUT_SECONDS="${BOOT_TIMEOUT_SECONDS:-180}"
EMULATOR_PORT="${EMULATOR_PORT:-5554}"
EMULATOR_ARGS="${EMULATOR_ARGS:-}"
KILL_ON_EXIT="${KILL_ON_EXIT:-false}"

EMULATOR_PID=""
STARTED_EMULATOR="false"

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

find_sdk_tool() {
  local relative_path="$1"
  local command_name="$2"

  if [[ -n "${ANDROID_SDK_ROOT:-}" && -x "${ANDROID_SDK_ROOT}/${relative_path}" ]]; then
    printf '%s\n' "${ANDROID_SDK_ROOT}/${relative_path}"
    return 0
  fi
  if [[ -n "${ANDROID_HOME:-}" && -x "${ANDROID_HOME}/${relative_path}" ]]; then
    printf '%s\n' "${ANDROID_HOME}/${relative_path}"
    return 0
  fi
  if command -v "${command_name}" >/dev/null 2>&1; then
    command -v "${command_name}"
    return 0
  fi
  # Not finding the tool is a normal outcome: callers test for empty output.
  return 0
}

ADB_BIN="$(find_sdk_tool "platform-tools/adb" "adb")"

[[ -n "${ADB_BIN}" ]] || fail "adb not found. Set ANDROID_SDK_ROOT or ANDROID_HOME."

adb_cmd() {
  "${ADB_BIN}" -s "${ADB_SERIAL}" "$@"
}

# adb_cmd for probes whose failure is expected and must not abort the script.
adb_cmd_best_effort() {
  "${ADB_BIN}" -s "${ADB_SERIAL}" "$@" || true
}

# Run a command the same way an `if` condition would (errexit is ignored
# inside it) and record its exit status in RUN_STATUS. Calling through "$@"
# keeps that explicit instead of a function name in a condition.
RUN_STATUS=0
run_capture_status() {
local run_rc=0
"$@" || run_rc=$?
RUN_STATUS="${run_rc}"
}

cleanup() {
  if [[ "${KILL_ON_EXIT}" == "true" && "${STARTED_EMULATOR}" == "true" && -n "${ADB_SERIAL}" ]]; then
    warn "KILL_ON_EXIT=true, stopping ${ADB_SERIAL}"
    adb_cmd_best_effort emu kill >/dev/null 2>&1
  elif [[ -n "${EMULATOR_PID}" ]]; then
    warn "Leaving emulator process running (pid ${EMULATOR_PID}). Set KILL_ON_EXIT=true to stop it."
  fi
}
trap cleanup EXIT

running_serial_for_avd() {
  local serial
  while read -r serial; do
    [[ -n "${serial}" ]] || continue
    local avd
    avd="$("${ADB_BIN}" -s "${serial}" emu avd name 2>/dev/null | tr -d '\r' | awk 'NF {print; exit}' || true)"
    if [[ "${avd}" == "${AVD_NAME}" ]]; then
      printf '%s\n' "${serial}"
      return 0
    fi
  done < <("${ADB_BIN}" devices | awk 'NR > 1 && $2 == "device" && $1 ~ /^emulator-/ {print $1}')
  # No running emulator for this AVD is a normal outcome: callers test for empty output.
  return 0
}

wait_for_boot() {
  local failure_message="$1"
  local deadline=$((SECONDS + BOOT_TIMEOUT_SECONDS))

  adb_cmd wait-for-device
  while (( SECONDS < deadline )); do
    local boot_completed sys_boot_completed
    boot_completed="$(adb_cmd_best_effort shell getprop dev.bootcomplete 2>/dev/null | tr -d '\r')"
    sys_boot_completed="$(adb_cmd_best_effort shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    if [[ "${boot_completed}" == "1" && "${sys_boot_completed}" == "1" ]]; then
      return 0
    fi
    sleep 2
  done

  fail "${failure_message}"
}

read_locale_state() {
  printf 'id: '
  adb_cmd_best_effort shell id
  printf 'ro.debuggable: '
  adb_cmd_best_effort shell getprop ro.debuggable
  printf 'ro.secure: '
  adb_cmd_best_effort shell getprop ro.secure
  printf 'ro.build.tags: '
  adb_cmd_best_effort shell getprop ro.build.tags
  printf 'sdk: '
  adb_cmd_best_effort shell getprop ro.build.version.sdk
  printf 'persist.sys.locale: '
  adb_cmd_best_effort shell getprop persist.sys.locale
  printf 'settings system_locales: '
  adb_cmd_best_effort shell settings get system system_locales
  printf 'am get-config locale line: '
  adb_cmd shell am get-config 2>/dev/null | tr -d '\r' | awk 'NR == 1 {print}'
}

try_system_locale_setprop() {
  local label="$1"

  log "Trying system locale via setprop (${label})"
  set +e
  local output
  output="$(adb_cmd shell setprop persist.sys.locale "${LOCALE}" 2>&1)"
  local status=$?
  set -e

  if (( status != 0 )); then
    printf 'setprop failed (%s):\n%s\n' "${label}" "${output}"
    return 1
  fi

  printf 'setprop succeeded (%s). Restarting Android framework for read-back...\n' "${label}"
  adb_cmd shell stop
  sleep 2
  adb_cmd shell start
  wait_for_boot "device did not finish booting after framework restart"
  read_locale_state
  return 0
}

try_adb_root() {
  log "Trying adb root"
  set +e
  local output
  output="$("${ADB_BIN}" -s "${ADB_SERIAL}" root 2>&1)"
  local status=$?
  set -e
  printf '%s\n' "${output}"
  "${ADB_BIN}" -s "${ADB_SERIAL}" wait-for-device || true
  sleep 1
  read_locale_state
  return "${status}"
}

try_app_locale() {
  local sdk
  sdk="$(adb_cmd shell getprop ro.build.version.sdk | tr -d '\r')"
  if [[ ! "${sdk}" =~ ^[0-9]+$ || "${sdk}" -lt 33 ]]; then
    warn "Skipping per-app locale probe: sdk=${sdk:-unknown}, requires Android 13/API 33+."
    return 1
  fi

  log "Trying per-app locale for ${APP_ID}"
  adb_cmd_best_effort shell cmd locale get-app-locales "${APP_ID}"
  adb_cmd shell cmd locale set-app-locales "${APP_ID}" --locales "${LOCALE}"
  adb_cmd shell cmd locale get-app-locales "${APP_ID}"

  log "Resetting per-app locale for ${APP_ID}"
  adb_cmd shell cmd locale set-app-locales "${APP_ID}" --locales ""
  adb_cmd shell cmd locale get-app-locales "${APP_ID}"
}

log "Probe configuration"
printf 'AVD_NAME=%s\nLOCALE=%s\nAPP_ID=%s\nEMULATOR_PORT=%s\nEMULATOR_ARGS=%s\n' \
  "${AVD_NAME}" "${LOCALE}" "${APP_ID}" "${EMULATOR_PORT}" "${EMULATOR_ARGS}"

if [[ -z "${ADB_SERIAL}" ]]; then
  ADB_SERIAL="$(running_serial_for_avd)"
fi

if [[ -z "${ADB_SERIAL}" ]]; then
  log "Starting AVD ${AVD_NAME}"
  EMULATOR_BIN="$(find_sdk_tool "emulator/emulator" "emulator")"
  [[ -n "${EMULATOR_BIN}" ]] || fail "emulator not found. Set ANDROID_SDK_ROOT or ANDROID_HOME, or pass ADB_SERIAL for an already running emulator."

  emulator_args_array=("-no-window" "-no-audio" "-no-snapshot")
  if [[ -n "${EMULATOR_ARGS}" ]]; then
    extra_emulator_args=()
    while IFS= read -r arg; do
      [[ -n "${arg}" ]] || continue
      extra_emulator_args+=("${arg}")
    done <<< "${EMULATOR_ARGS}"
    emulator_args_array+=(${extra_emulator_args[@]+"${extra_emulator_args[@]}"})
  fi
  "${EMULATOR_BIN}" -avd "${AVD_NAME}" -port "${EMULATOR_PORT}" "${emulator_args_array[@]}" >/tmp/auto-mobile-locale-probe-emulator.log 2>&1 &
  EMULATOR_PID="$!"
  STARTED_EMULATOR="true"
  ADB_SERIAL="emulator-${EMULATOR_PORT}"
fi

log "Waiting for ${ADB_SERIAL} to boot"
wait_for_boot "device ${ADB_SERIAL} did not boot within ${BOOT_TIMEOUT_SECONDS}s"

log "Initial locale/root state"
read_locale_state

system_without_root="failed"
run_capture_status try_system_locale_setprop "before adb root"
if (( RUN_STATUS == 0 )); then
  system_without_root="succeeded"
fi

root_result="failed"
run_capture_status try_adb_root
if (( RUN_STATUS == 0 )); then
  root_result="succeeded"
fi

system_after_root="skipped"
set +e
root_identity=$(adb_cmd shell id)
root_identity_status=$?
set -e
if (( root_identity_status == 0 )) && [[ "${root_identity}" == *'uid=0(root)'* ]]; then
  system_after_root="failed"
  run_capture_status try_system_locale_setprop "after adb root"
  if (( RUN_STATUS == 0 )); then
    system_after_root="succeeded"
  fi
else
  warn "adbd is not root after adb root; skipping second system setprop attempt."
fi

app_locale="failed"
run_capture_status try_app_locale
if (( RUN_STATUS == 0 )); then
  app_locale="succeeded"
fi

log "Summary"
printf 'system setprop before adb root: %s\n' "${system_without_root}"
printf 'adb root: %s\n' "${root_result}"
printf 'system setprop after adb root: %s\n' "${system_after_root}"
printf 'per-app cmd locale: %s\n' "${app_locale}"
