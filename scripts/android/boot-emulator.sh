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
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "emulator_serial=${device_id}" >> "${GITHUB_OUTPUT}"
fi
echo "${device_id}"
