#!/usr/bin/env bash
# Best-effort Android emulator diagnostics collection for CI failures.
set -euo pipefail

# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../ios/run_with_timeout.sh"

adb_timeout_seconds="${AUTOMOBILE_EMULATOR_DIAGNOSTICS_TIMEOUT_SECONDS:-10}"

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

# Diagnostics must never mask the boot failure. Temporarily disable errexit so
# each bounded best-effort command can fail and collection can continue.
set +e
run_with_timeout "${adb_timeout_seconds}" adb devices -l > "${diagnostics_dir}/adb-devices.txt" 2>&1
serial="$(awk '$2 == "device" { print $1; exit }' "${diagnostics_dir}/adb-devices.txt")"
if [[ -z "${serial}" ]]; then
  set -e
  printf '%s\n' "No online adb device was available for on-device diagnostics." \
    > "${diagnostics_dir}/no-online-device.txt"
  exit 0
fi

run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell getprop > "${diagnostics_dir}/getprop.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell ps -A > "${diagnostics_dir}/processes.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell dumpsys activity services \
  > "${diagnostics_dir}/activity-services.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell dumpsys package dev.jasonpearson.automobile.ctrlproxy \
  > "${diagnostics_dir}/ctrl-proxy-package.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" logcat -d -v threadtime \
  > "${diagnostics_dir}/logcat.txt" 2>&1
set -e
