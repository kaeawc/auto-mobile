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

result="$(cd "${repo_root}" && bun run src/index.ts --boot-device --platform android --name "${avd_name}" --timeout-ms "${timeout_ms}")"
device_id="$(printf '%s' "${result}" | jq -r '.deviceId')"
if [[ -z "${device_id}" || "${device_id}" == "null" ]]; then
  echo "error: AutoMobile Android boot returned no deviceId" >&2
  exit 1
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "emulator_serial=${device_id}" >> "${GITHUB_OUTPUT}"
fi
echo "${device_id}"
