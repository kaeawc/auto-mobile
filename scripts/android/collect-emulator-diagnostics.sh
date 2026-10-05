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

# Diagnostics must never mask the original failure, including filesystem errors.
set +e
run_with_timeout "${adb_timeout_seconds}" mkdir -p "${diagnostics_dir}"
mkdir_status=$?
if [[ "$mkdir_status" -ne 0 ]]; then exit 0; fi
printf '%s\n' "${reason}" > "${diagnostics_dir}/failure-reason.txt"

# Match the executable name, not the argument string (which can contain this
# script's name). Never signal or change any emulator process.
# shellcheck disable=SC2016 # awk field references must remain literal.
run_with_timeout "${adb_timeout_seconds}" ps -eo pid,ppid,comm,args \
  | run_with_timeout "${adb_timeout_seconds}" awk 'NR == 1 || $3 ~ /(^|\/)(emulator|qemu[^/]*)$/' \
  > "${diagnostics_dir}/host-processes.txt" 2>&1
kvm_device="${AUTOMOBILE_KVM_DEVICE:-/dev/kvm}"
{
  printf 'KVM device: %s\n' "$kvm_device"
  if [[ -e "$kvm_device" ]]; then
    run_with_timeout "${adb_timeout_seconds}" ls -l "$kvm_device"
  else
    printf 'KVM device is absent.\n'
  fi
  readable=no; writable=no
  if [[ -r "$kvm_device" ]]; then readable=yes; fi
  if [[ -w "$kvm_device" ]]; then writable=yes; fi
  printf 'Current user access: readable=%s writable=%s\n' "$readable" "$writable"
} > "${diagnostics_dir}/host-kvm.txt" 2>&1
if command -v free >/dev/null 2>&1; then
  run_with_timeout "${adb_timeout_seconds}" free -m > "${diagnostics_dir}/host-memory.txt" 2>&1
else
  run_with_timeout "${adb_timeout_seconds}" cat /proc/meminfo > "${diagnostics_dir}/host-memory.txt" 2>&1
fi
run_with_timeout "${adb_timeout_seconds}" df -h > "${diagnostics_dir}/host-disk.txt" 2>&1

# There is no canonical emulator log path. Search only these shallow globs;
# the temporary root is overridable to keep tests isolated from host files.
avd_home="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
emulator_tmp_dir="${AUTOMOBILE_EMULATOR_TMP_DIR:-/tmp/android-${USER:-runner}}"
{
  printf 'Search: %s/*emulator*.log, %s/*.avd/*.log, %s/*emu*, %s/emulator*.log\n' \
    "$diagnostics_dir" "$avd_home" "$emulator_tmp_dir" "$emulator_tmp_dir"
  found_log=false
  shopt -s nullglob
  for emulator_log in "$diagnostics_dir"/*emulator*.log "$avd_home"/*.avd/*.log \
    "$emulator_tmp_dir"/*emu* "$emulator_tmp_dir"/emulator*.log; do
    [[ -f "$emulator_log" ]] || continue
    found_log=true
    printf '\nEmulator log: %s (last 200 lines)\n' "$emulator_log"
    run_with_timeout "${adb_timeout_seconds}" tail -n 200 "$emulator_log"
  done
  if [[ "$found_log" == false ]]; then printf 'Emulator logs: none found.\n'; fi
} > "${diagnostics_dir}/emulator-log-tail.txt" 2>&1

if ! command -v adb >/dev/null 2>&1; then
  printf '%s\n' "adb is unavailable; no on-device diagnostics could be captured." \
    > "${diagnostics_dir}/adb-unavailable.txt"
  exit 0
fi

run_with_timeout "${adb_timeout_seconds}" adb devices -l > "${diagnostics_dir}/adb-devices.txt" 2>&1
# shellcheck disable=SC2016 # awk field references must remain literal.
serial="$(run_with_timeout "${adb_timeout_seconds}" awk '$2 == "device" { print $1; exit }' "${diagnostics_dir}/adb-devices.txt")"
if [[ -z "${serial}" ]]; then
  printf '%s\n' "No online adb device was available for on-device diagnostics." \
    > "${diagnostics_dir}/no-online-device.txt"
  exit 0
fi

run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell getprop > "${diagnostics_dir}/getprop.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell ps -A > "${diagnostics_dir}/processes.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell dumpsys activity services \
  > "${diagnostics_dir}/activity-services.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell dumpsys accessibility \
  > "${diagnostics_dir}/accessibility.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" forward --list \
  > "${diagnostics_dir}/adb-forwards.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" shell dumpsys package dev.jasonpearson.automobile.ctrlproxy \
  > "${diagnostics_dir}/ctrl-proxy-package.txt" 2>&1
run_with_timeout "${adb_timeout_seconds}" adb -s "${serial}" logcat -d -v threadtime \
  > "${diagnostics_dir}/logcat.txt" 2>&1
exit 0
