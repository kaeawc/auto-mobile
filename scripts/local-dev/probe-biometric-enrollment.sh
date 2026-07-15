#!/usr/bin/env bash
# Live-emulator smoke test for the `emu finger` biometric enrollment/match/unlock
# sequence documented in docs/design-docs/plat/android/biometrics.md.
#
# This is a best-effort probe, not a hermetic unit test. The fake-backed unit
# coverage lives in test/features/action/BiometricAuth.test.ts; this script
# exercises the same sequence against real emulator hardware where the
# fingerprint HAL, lock screen, and `emu finger` transport actually exist.
#
# It SKIPS cleanly (exit 0) when no emulator is available or the running device
# does not expose `emu finger`, so it is safe to invoke from a live-device leg
# without gating CI on the presence of hardware. Set REQUIRE_DEVICE=true to turn
# an unavailable/unsupported device into a hard failure instead.
#
# adb helpers deliberately swallow their own errors (returning 0) because every
# individual adb call here is best-effort: pass/fail is decided by the observed
# enrollment count and keyguard state, not by adb exit codes. Keeping the
# helpers non-failing also avoids set -e-suppression footguns (SC2310).

set -euo pipefail

AVD_NAME="${AVD_NAME:-Pixel_9}"
ADB_SERIAL="${ADB_SERIAL:-}"
DEVICE_PIN="${DEVICE_PIN:-1234}"
ENROLLED_FINGER_ID="${ENROLLED_FINGER_ID:-1}"
UNENROLLED_FINGER_ID="${UNENROLLED_FINGER_ID:-2}"
ENROLL_TOUCH_CYCLES="${ENROLL_TOUCH_CYCLES:-8}"
BOOT_TIMEOUT_SECONDS="${BOOT_TIMEOUT_SECONDS:-180}"
EMULATOR_PORT="${EMULATOR_PORT:-5554}"
EMULATOR_ARGS="${EMULATOR_ARGS:-}"
REQUIRE_DEVICE="${REQUIRE_DEVICE:-false}"
KILL_ON_EXIT="${KILL_ON_EXIT:-false}"

EMULATOR_PID=""
STARTED_EMULATOR="false"

log() {
  printf '\n==> %s\n' "$*"
}

# shellcheck disable=SC2317,SC2329 # Invoked indirectly from the cleanup trap.
warn() {
  printf 'WARN: %s\n' "$*" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Skip cleanly unless the caller demanded a device (REQUIRE_DEVICE=true).
skip_or_fail() {
  local reason="$1"
  if [[ "${REQUIRE_DEVICE}" == "true" ]]; then
    fail "${reason}"
  fi
  printf 'SKIP: %s\n' "${reason}"
  exit 0
}

# Prints the resolved tool path (empty when not found); always returns 0 so
# callers gate on the captured value rather than on a set -e-suppressed status.
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
  command -v "${command_name}" 2> /dev/null || true
}

ADB_BIN="$(find_sdk_tool "platform-tools/adb" "adb")"

[[ -n "${ADB_BIN}" ]] || skip_or_fail "adb not found. Set ANDROID_SDK_ROOT or ANDROID_HOME."

# Best-effort adb wrapper: never fails the script itself (see header note).
adb_cmd() {
  "${ADB_BIN}" -s "${ADB_SERIAL}" "$@" || true
}

# shellcheck disable=SC2317,SC2329 # Invoked indirectly via `trap cleanup EXIT`.
cleanup() {
  if [[ "${KILL_ON_EXIT}" == "true" && "${STARTED_EMULATOR}" == "true" && -n "${ADB_SERIAL}" ]]; then
    warn "KILL_ON_EXIT=true, stopping ${ADB_SERIAL}"
    adb_cmd emu kill > /dev/null 2>&1
  elif [[ -n "${EMULATOR_PID}" ]]; then
    warn "Leaving emulator process running (pid ${EMULATOR_PID}). Set KILL_ON_EXIT=true to stop it."
  fi
}
trap cleanup EXIT

# Prints the serial of a running emulator matching AVD_NAME (empty if none).
running_serial_for_avd() {
  local serial
  while read -r serial; do
    [[ -n "${serial}" ]] || continue
    local avd
    avd="$("${ADB_BIN}" -s "${serial}" emu avd name 2> /dev/null | tr -d '\r' | awk 'NF {print; exit}')"
    if [[ "${avd}" == "${AVD_NAME}" ]]; then
      printf '%s\n' "${serial}"
      return 0
    fi
  done < <("${ADB_BIN}" devices 2> /dev/null | awk 'NR > 1 && $2 == "device" && $1 ~ /^emulator-/ {print $1}')
  return 0
}

# Prints the first running emulator serial (empty if none).
first_running_emulator() {
  "${ADB_BIN}" devices 2> /dev/null \
    | awk 'NR > 1 && $2 == "device" && $1 ~ /^emulator-/ {print $1; exit}' || true
}

# Returns 0 once the device reports boot completion, 1 on timeout.
wait_for_boot() {
  local deadline=$((SECONDS + BOOT_TIMEOUT_SECONDS))

  adb_cmd wait-for-device
  while ((SECONDS < deadline)); do
    local boot_completed sys_boot_completed
    boot_completed="$(adb_cmd shell getprop dev.bootcomplete | tr -d '\r')"
    sys_boot_completed="$(adb_cmd shell getprop sys.boot_completed | tr -d '\r')"
    if [[ "${boot_completed}" == "1" && "${sys_boot_completed}" == "1" ]]; then
      return 0
    fi
    sleep 2
  done

  return 1
}

# Confirm this is an emulator exposing `emu finger`, else skip.
require_finger_support() {
  local is_emulator
  is_emulator="$(adb_cmd shell getprop ro.kernel.qemu | tr -d '\r')"
  if [[ "${is_emulator}" != "1" ]]; then
    skip_or_fail "device ${ADB_SERIAL} is not an emulator (ro.kernel.qemu=${is_emulator:-unset}); emu finger unavailable."
  fi

  local emu_help
  emu_help="$(adb_cmd emu help | tr -d '\r')"
  if [[ "${emu_help}" != *finger* ]]; then
    skip_or_fail "emulator ${ADB_SERIAL} does not expose 'emu finger' commands."
  fi
}

keyguard_showing() {
  local window_dump keyguard_state
  window_dump="$(adb_cmd shell dumpsys window | tr -d '\r')"
  keyguard_state="$(
    printf '%s\n' "${window_dump}" \
      | sed -nE \
        -e 's/.*isKeyguardShowing=(true|false).*/isKeyguardShowing=\1/p' \
        -e 's/.*mShowingLockscreen=(true|false).*/isKeyguardShowing=\1/p' \
        -e 's/^[[:space:]]*showing=(true|false)[[:space:]]*$/isKeyguardShowing=\1/p' \
        -e 's/^[[:space:]]*mIsShowing=(true|false)[[:space:]]*$/isKeyguardShowing=\1/p' \
      | head -1
  )"
  printf '%s\n' "${keyguard_state:-unknown}"
}

enrolled_print_count() {
  adb_cmd shell dumpsys fingerprint \
    | tr -d '\r' \
    | grep -o '"id":[0-9]*' \
    | wc -l \
    | tr -d ' '
}

enroll_fingerprint() {
  log "Enrolling fingerprint id ${ENROLLED_FINGER_ID} (PIN ${DEVICE_PIN})"
  adb_cmd shell locksettings set-pin "${DEVICE_PIN}"
  adb_cmd shell cmd lock_settings set-pin --old "${DEVICE_PIN}" "${DEVICE_PIN}"
  adb_cmd shell cmd lock_settings set-disabled --old "${DEVICE_PIN}" false
  adb_cmd shell settings put secure lock_screen_lock_after_timeout 0
  adb_cmd shell am start -a android.settings.FINGERPRINT_ENROLL > /dev/null 2>&1
  sleep 1
  adb_cmd shell input text "${DEVICE_PIN}"
  adb_cmd shell input keyevent 66
  sleep 1

  local cycle
  for ((cycle = 0; cycle < ENROLL_TOUCH_CYCLES; cycle++)); do
    adb_cmd emu finger touch "${ENROLLED_FINGER_ID}"
    adb_cmd emu finger remove "${ENROLLED_FINGER_ID}"
    sleep 1
  done

  adb_cmd shell cmd fingerprint sync > /dev/null 2>&1
}

lock_device() {
  # Enrollment can leave API 29 in a credential Settings activity that does not
  # show keyguard until the task is backgrounded.
  adb_cmd shell input keyevent 3
  sleep 1
  # Two keyevent 26 presses ensure the keyguard is shown (first may only wake).
  adb_cmd shell input keyevent 26
  sleep 2
  adb_cmd shell input keyevent 26
  sleep 1
}

prime_fingerprint_unlock() {
  log "Priming fingerprint unlock with PIN"
  lock_device
  adb_cmd shell input text "${DEVICE_PIN}"
  adb_cmd shell input keyevent 66
  sleep 1
  printf 'keyguard after PIN prime: %s\n' "$(keyguard_showing)"
}

log "Probe configuration"
printf 'AVD_NAME=%s\nADB_SERIAL=%s\nENROLLED_FINGER_ID=%s\nUNENROLLED_FINGER_ID=%s\nREQUIRE_DEVICE=%s\n' \
  "${AVD_NAME}" "${ADB_SERIAL:-<auto>}" "${ENROLLED_FINGER_ID}" "${UNENROLLED_FINGER_ID}" "${REQUIRE_DEVICE}"

if [[ -z "${ADB_SERIAL}" ]]; then
  ADB_SERIAL="$(running_serial_for_avd)"
fi
if [[ -z "${ADB_SERIAL}" ]]; then
  ADB_SERIAL="$(first_running_emulator)"
fi

if [[ -z "${ADB_SERIAL}" ]]; then
  EMULATOR_BIN="$(find_sdk_tool "emulator/emulator" "emulator")"
  if [[ -z "${EMULATOR_BIN}" ]]; then
    skip_or_fail "no running emulator and emulator binary not found; nothing to probe."
  fi

  log "Starting AVD ${AVD_NAME}"
  emulator_args_array=("-no-window" "-no-audio" "-no-snapshot")
  if [[ -n "${EMULATOR_ARGS}" ]]; then
    extra_emulator_args=()
    while IFS= read -r arg; do
      [[ -n "${arg}" ]] || continue
      extra_emulator_args+=("${arg}")
    done <<< "${EMULATOR_ARGS}"
    emulator_args_array+=("${extra_emulator_args[@]}")
  fi
  "${EMULATOR_BIN}" -avd "${AVD_NAME}" -port "${EMULATOR_PORT}" "${emulator_args_array[@]}" \
    > /tmp/auto-mobile-biometric-probe-emulator.log 2>&1 &
  EMULATOR_PID="$!"
  STARTED_EMULATOR="true"
  ADB_SERIAL="emulator-${EMULATOR_PORT}"
fi

log "Waiting for ${ADB_SERIAL} to boot"
# Invoke separately (not in a condition) so set -e stays armed inside the call.
set +e
wait_for_boot
boot_status=$?
set -e
if [[ "${boot_status}" -ne 0 ]]; then
  skip_or_fail "device ${ADB_SERIAL} did not boot within ${BOOT_TIMEOUT_SECONDS}s"
fi

require_finger_support

enroll_fingerprint

log "Verifying enrollment via dumpsys fingerprint"
enroll_count="$(enrolled_print_count)"
printf 'enrolled prints: %s\n' "${enroll_count}"
enroll_result="failed"
if [[ "${enroll_count}" =~ ^[0-9]+$ && "${enroll_count}" -ge 1 ]]; then
  enroll_result="succeeded"
fi

prime_fingerprint_unlock

log "Validating unlock with enrolled finger id ${ENROLLED_FINGER_ID}"
lock_device
before_match="$(keyguard_showing)"
adb_cmd emu finger touch "${ENROLLED_FINGER_ID}"
adb_cmd emu finger remove "${ENROLLED_FINGER_ID}"
sleep 1
after_match="$(keyguard_showing)"
printf 'keyguard before match: %s\n' "${before_match:-unknown}"
printf 'keyguard after match:  %s\n' "${after_match:-unknown}"
match_result="failed"
if [[ "${after_match}" == "isKeyguardShowing=false" ]]; then
  match_result="succeeded"
fi

log "Validating non-enrolled finger id ${UNENROLLED_FINGER_ID} does NOT unlock"
lock_device
adb_cmd emu finger touch "${UNENROLLED_FINGER_ID}"
adb_cmd emu finger remove "${UNENROLLED_FINGER_ID}"
sleep 1
after_mismatch="$(keyguard_showing)"
printf 'keyguard after mismatch: %s\n' "${after_mismatch:-unknown}"
mismatch_result="failed"
if [[ "${after_mismatch}" == "isKeyguardShowing=true" ]]; then
  mismatch_result="succeeded"
fi

log "Summary"
printf 'enrollment (dumpsys fingerprint): %s\n' "${enroll_result}"
printf 'unlock with enrolled finger:      %s\n' "${match_result}"
printf 'reject non-enrolled finger:       %s\n' "${mismatch_result}"

if [[ "${enroll_result}" == "succeeded" && "${match_result}" == "succeeded" && "${mismatch_result}" == "succeeded" ]]; then
  log "emu finger enrollment/match/unlock smoke test PASSED"
  exit 0
fi

fail "emu finger smoke test did not pass on ${ADB_SERIAL} (see summary above)."
