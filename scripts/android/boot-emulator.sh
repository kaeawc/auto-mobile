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
boot_log="${diagnostics_dir}/boot-device.log"

progress() {
  if [[ "${AUTOMOBILE_BOOT_PROGRESS:-false}" == "true" ]]; then
    echo "[android-emulator] $*"
  fi
}

capture_diagnostics() {
  local reason="$1"
  local serial=""

  mkdir -p "${diagnostics_dir}"
  printf '%s\n' "${reason}" > "${diagnostics_dir}/failure-reason.txt"

  if ! command -v adb >/dev/null 2>&1; then
    printf '%s\n' "adb is unavailable; no on-device diagnostics could be captured." \
      > "${diagnostics_dir}/adb-unavailable.txt"
    return
  fi

  adb devices -l > "${diagnostics_dir}/adb-devices.txt" 2>&1 || true
  serial="$(awk '$2 == "device" { print $1; exit }' "${diagnostics_dir}/adb-devices.txt")"
  if [[ -z "${serial}" ]]; then
    printf '%s\n' "No online adb device was available for on-device diagnostics." \
      > "${diagnostics_dir}/no-online-device.txt"
    return
  fi

  adb -s "${serial}" shell getprop > "${diagnostics_dir}/getprop.txt" 2>&1 || true
  adb -s "${serial}" shell ps -A > "${diagnostics_dir}/processes.txt" 2>&1 || true
  adb -s "${serial}" shell dumpsys activity services \
    > "${diagnostics_dir}/activity-services.txt" 2>&1 || true
  adb -s "${serial}" shell dumpsys package dev.jasonpearson.automobile.ctrlproxy \
    > "${diagnostics_dir}/ctrl-proxy-package.txt" 2>&1 || true
  adb -s "${serial}" logcat -d -v threadtime \
    > "${diagnostics_dir}/logcat.txt" 2>&1 || true
}

mkdir -p "${diagnostics_dir}"
progress "Starting AutoMobile Android boot for AVD '${avd_name}' (deadline ${timeout_ms}ms)."
set +e
if [[ "${AUTOMOBILE_BOOT_PROGRESS:-false}" == "true" ]]; then
  (cd "${repo_root}" && bun run src/index.ts --boot-device --platform android --name "${avd_name}" --timeout-ms "${timeout_ms}") \
    2>&1 | tee "${boot_log}"
  boot_status="${PIPESTATUS[0]}"
else
  (cd "${repo_root}" && bun run src/index.ts --boot-device --platform android --name "${avd_name}" --timeout-ms "${timeout_ms}") \
    2>&1 | tee "${boot_log}" >/dev/null
  boot_status="${PIPESTATUS[0]}"
fi
set -e

if [[ "${boot_status}" -ne 0 ]]; then
  capture_diagnostics "AutoMobile Android boot failed with exit code ${boot_status}."
  progress "Boot failed; diagnostics are in ${diagnostics_dir}."
  exit "${boot_status}"
fi

if ! device_id="$(jq -er '.deviceId' "${boot_log}")"; then
  capture_diagnostics "AutoMobile Android boot returned no usable deviceId."
  echo "error: AutoMobile Android boot returned no deviceId" >&2
  progress "Boot returned no device id; diagnostics are in ${diagnostics_dir}."
  exit 1
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "emulator_serial=${device_id}" >> "${GITHUB_OUTPUT}"
fi
echo "${device_id}"
