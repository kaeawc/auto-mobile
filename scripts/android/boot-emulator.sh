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
unlock_keyguard
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "emulator_serial=${device_id}" >> "${GITHUB_OUTPUT}"
fi
echo "${device_id}"
