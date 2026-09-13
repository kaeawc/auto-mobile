#!/usr/bin/env bash
# Best-effort Android emulator diagnostics collection for CI failures.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <diagnostics-dir> <failure-reason>" >&2
  exit 2
fi

diagnostics_dir="$1"
reason="$2"
serial=""

mkdir -p "${diagnostics_dir}"
printf '%s\n' "${reason}" > "${diagnostics_dir}/failure-reason.txt"

if ! command -v adb >/dev/null 2>&1; then
  printf '%s\n' "adb is unavailable; no on-device diagnostics could be captured." \
    > "${diagnostics_dir}/adb-unavailable.txt"
  exit 0
fi

adb devices -l > "${diagnostics_dir}/adb-devices.txt" 2>&1 || true
serial="$(awk '$2 == "device" { print $1; exit }' "${diagnostics_dir}/adb-devices.txt")"
if [[ -z "${serial}" ]]; then
  printf '%s\n' "No online adb device was available for on-device diagnostics." \
    > "${diagnostics_dir}/no-online-device.txt"
  exit 0
fi

adb -s "${serial}" shell getprop > "${diagnostics_dir}/getprop.txt" 2>&1 || true
adb -s "${serial}" shell ps -A > "${diagnostics_dir}/processes.txt" 2>&1 || true
adb -s "${serial}" shell dumpsys activity services \
  > "${diagnostics_dir}/activity-services.txt" 2>&1 || true
adb -s "${serial}" shell dumpsys package dev.jasonpearson.automobile.ctrlproxy \
  > "${diagnostics_dir}/ctrl-proxy-package.txt" 2>&1 || true
adb -s "${serial}" logcat -d -v threadtime \
  > "${diagnostics_dir}/logcat.txt" 2>&1 || true
