#!/usr/bin/env bash
# Thin CI adapter for AutoMobile's daemon-free Android boot product.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

avd_name="test"
timeout_ms="600000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --avd-name) avd_name="$2"; shift 2 ;;
    --timeout-ms) timeout_ms="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

diagnostics_dir="${AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR:-${repo_root}/scratch/android-emulator-diagnostics}"
boot_stdout_log="${diagnostics_dir}/boot-device.log"
boot_stderr_log="${diagnostics_dir}/boot-device.stderr.log"

progress() {
  if [[ "${AUTOMOBILE_BOOT_PROGRESS:-false}" == "true" ]]; then
    echo "[android-emulator] $*"
  fi
}

keyguard_showing() {
  local output
  output="$(adb -s "${device_id}" shell dumpsys window policy 2>&1 || true)"
  if [[ "${output}" != *isKeyguardShowing=* && "${output}" != *mShowingLockscreen=* ]]; then
    output+=$'\n'"$(adb -s "${device_id}" shell dumpsys window 2>&1 || true)"
  fi
  printf '%s\n' "${output}" | sed -nE \
    -e 's/.*(isKeyguardShowing|mShowingLockscreen)=(true|false).*/\2/p' \
    -e 's/^[[:space:]]*showing=(true|false)[[:space:]]*$/\1/p' \
    | sed -n '1p'
}

unlock_keyguard() {
  local attempts="${AUTOMOBILE_KEYGUARD_RETRIES:-5}"
  local delay="${AUTOMOBILE_KEYGUARD_RETRY_SLEEP_SECONDS:-2}"
  local attempt state policy_dump
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    state="$(keyguard_showing)"
    if [[ "${state}" == false ]]; then
      progress "Keyguard verified unlocked."
      return 0
    fi
    if [[ "${state}" == true ]]; then
      progress "Keyguard is showing; requesting dismissal (attempt ${attempt}/${attempts})."
      adb -s "${device_id}" shell wm dismiss-keyguard >/dev/null 2>&1 || true
      adb -s "${device_id}" shell input keyevent 82 >/dev/null 2>&1 || true
    else
      progress "Keyguard state is not yet readable (attempt ${attempt}/${attempts})."
    fi
    sleep "${delay}"
  done

  state="$(keyguard_showing)"
  if [[ "${state}" == false ]]; then return 0; fi
  policy_dump="$(adb -s "${device_id}" shell dumpsys window policy 2>&1 || true)"
  printf '%s\n' "${policy_dump}" > "${diagnostics_dir}/keyguard-window-policy.txt"
  if [[ -z "${state}" ]]; then
    printf 'warning: Android keyguard state remains unreadable; continuing boot; policy diagnostics: %s\n' \
      "${diagnostics_dir}/keyguard-window-policy.txt" >&2
    return 0
  fi
  printf 'error: Android keyguard did not become verified-unlocked (state: %s); policy diagnostics: %s\n' \
    "${state:-unknown}" "${diagnostics_dir}/keyguard-window-policy.txt" >&2
  "${script_dir}/collect-emulator-diagnostics.sh" "${diagnostics_dir}" \
    "Android keyguard did not become verified-unlocked (state: ${state:-unknown})."
  progress "Keyguard unlock failed; diagnostics are in ${diagnostics_dir}."
  exit 1
}

# Window titles of the system ANR and crash dialogs currently on screen, one per line.
system_error_dialogs() {
  adb -s "${device_id}" shell dumpsys window windows 2>/dev/null \
    | grep -E '^[[:space:]]*Window #[0-9]+ Window\{' \
    | grep -oE 'Application (Not Responding|Error): [A-Za-z0-9._:]+' \
    | sort -u || true
}

# A slow software-rendered boot can ANR SystemUI or the launcher, and the ANR dialog stays up after
# the process recovers. It sits centered on the display, where a test that taps the middle of a
# target lands on "Close app" mid-test; for SystemUI that kills it and re-locks the device (nightly
# Foldable Posture lane). Cancel such dialogs before tests start. Cancelling an ANR or crash dialog
# kills its process ("user request after error"), so a cancelled SystemUI dialog waits for SystemUI
# to restart and then verifies the keyguard again. A dialog that survives only warns.
systemui_pid() {
  adb -s "${device_id}" shell pidof com.android.systemui 2>/dev/null | tr -d '[:space:]' || true
}

wait_for_systemui_restart() {
  local previous_pid="$1"
  local attempts="${AUTOMOBILE_SYSTEMUI_RESTART_RETRIES:-30}"
  local delay="${AUTOMOBILE_SYSTEMUI_RESTART_SLEEP_SECONDS:-1}"
  local attempt pid
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    pid="$(systemui_pid)"
    if [[ -n "${pid}" && "${pid}" != "${previous_pid}" ]]; then
      progress "SystemUI restarted (pid ${previous_pid:-none} -> ${pid})."
      return 0
    fi
    sleep "${delay}"
  done
  printf 'warning: SystemUI did not restart after its error dialog was dismissed (pid %s)\n' \
    "${previous_pid:-none}" >&2
}

dismiss_system_error_dialogs() {
  local attempts="${AUTOMOBILE_ERROR_DIALOG_RETRIES:-3}"
  local delay="${AUTOMOBILE_ERROR_DIALOG_RETRY_SLEEP_SECONDS:-1}"
  local attempt dialogs initial systemui_before=""
  local -a broadcast_pids=()
  initial="$(system_error_dialogs)"
  if [[ -z "${initial}" ]]; then
    return 0
  fi
  printf '%s\n' "${initial}" > "${diagnostics_dir}/system-error-dialogs.txt"
  if [[ "${initial}" == *": com.android.systemui"* ]]; then
    systemui_before="$(systemui_pid)"
  fi
  dialogs="${initial}"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    progress "Dismissing system error dialogs (attempt ${attempt}/${attempts}): ${dialogs//$'\n'/, }"
    # `am broadcast` waits for every receiver, and a still-hung ANR process may be one of them; send
    # it in the background so the bounded dialog check below decides when to give up.
    adb -s "${device_id}" shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 &
    broadcast_pids+=("$!")
    sleep "${delay}"
    dialogs="$(system_error_dialogs)"
    if [[ -z "${dialogs}" ]]; then
      break
    fi
  done
  kill ${broadcast_pids[@]+"${broadcast_pids[@]}"} 2>/dev/null || true
  wait ${broadcast_pids[@]+"${broadcast_pids[@]}"} 2>/dev/null || true
  if [[ "${initial}" == *": com.android.systemui"* ]]; then
    wait_for_systemui_restart "${systemui_before}"
    unlock_keyguard
    dialogs="$(system_error_dialogs)"
  fi
  if [[ -n "${dialogs}" ]]; then
    printf 'warning: system error dialogs are still showing after boot: %s\n' "${dialogs//$'\n'/, }" >&2
  fi
}

# Post-boot package optimisation (artd/dexopt) runs for minutes after a cold emulator boot and
# stalls system_server up to ~2.7 s, so the first taps of a test time out at 5 s (nightly Foldable
# Posture lane, #10806). Run the background dexopt job once, synchronously and bounded, so the stall
# is spent here instead of inside a test. `cmd package bg-dexopt-job` blocks until the job finishes
# on API 34+; the host-side deadline covers images where it does not. Timeout only warns.
# AUTOMOBILE_POST_BOOT_SETTLE_SECONDS=0 disables the step.
settle_post_boot_optimization() {
  local budget="${AUTOMOBILE_POST_BOOT_SETTLE_SECONDS:-120}"
  local step="${AUTOMOBILE_POST_BOOT_SETTLE_POLL_SECONDS:-1}"
  local deadline job_pid booted
  if [[ "${budget}" -le 0 ]]; then
    return 0
  fi
  deadline=$((SECONDS + budget))
  while ((SECONDS < deadline)); do
    booted="$(adb -s "${device_id}" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "${booted}" == 1 ]] && break
    sleep "${step}"
  done
  if [[ "${booted:-}" != 1 ]]; then
    printf 'warning: sys.boot_completed was not set within %ss; skipping post-boot settle\n' "${budget}" >&2
    return 0
  fi
  progress "Waiting up to ${budget}s for background dexopt to finish."
  adb -s "${device_id}" shell cmd package bg-dexopt-job >/dev/null 2>&1 &
  job_pid="$!"
  while kill -0 "${job_pid}" 2>/dev/null; do
    if ((SECONDS >= deadline)); then
      kill "${job_pid}" 2>/dev/null || true
      wait "${job_pid}" 2>/dev/null || true
      printf 'warning: background dexopt did not finish within %ss; continuing\n' "${budget}" >&2
      return 0
    fi
    sleep "${step}"
  done
  wait "${job_pid}" 2>/dev/null || true
  progress "Background dexopt settled."
}

mkdir -p "${diagnostics_dir}"
progress "Starting AutoMobile Android boot for AVD '${avd_name}' (deadline ${timeout_ms}ms)."
set +e
tail_pid=""
if [[ "${AUTOMOBILE_BOOT_PROGRESS:-false}" == "true" ]]; then
  : > "${boot_stdout_log}"
  tail -f "${boot_stdout_log}" &
  tail_pid="$!"
fi
(cd "${repo_root}" && bun run src/index.ts --boot-device --platform android --name "${avd_name}" --timeout-ms "${timeout_ms}") \
  > "${boot_stdout_log}" 2> "${boot_stderr_log}"
boot_status="$?"
if [[ -n "${tail_pid}" ]]; then
  kill "${tail_pid}" 2>/dev/null || true
  wait "${tail_pid}" 2>/dev/null || true
fi
set -e

if [[ "${boot_status}" -ne 0 ]]; then
  "${script_dir}/collect-emulator-diagnostics.sh" "${diagnostics_dir}" \
    "AutoMobile Android boot failed with exit code ${boot_status}."
  progress "Boot failed; diagnostics are in ${diagnostics_dir}."
  exit "${boot_status}"
fi

if ! device_id="$(jq -er '.deviceId | strings | select(length > 0)' "${boot_stdout_log}")" || [[ -z "${device_id//[[:space:]]/}" ]]; then
  "${script_dir}/collect-emulator-diagnostics.sh" "${diagnostics_dir}" \
    "AutoMobile Android boot returned no usable deviceId."
  echo "error: AutoMobile Android boot returned no deviceId" >&2
  progress "Boot returned no device id; diagnostics are in ${diagnostics_dir}."
  exit 1
fi
settle_post_boot_optimization
unlock_keyguard
dismiss_system_error_dialogs
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "emulator_serial=${device_id}" >> "${GITHUB_OUTPUT}"
fi
echo "${device_id}"
