#!/usr/bin/env bash
#
# Run the x86_64 deviceCondition memory-pressure payload on an x86_64 emulator
# (#16402). Prepare Release ships this binary, but only the arm64 build had run
# on a device. This starts it with a small allocation, waits for READY, checks
# it dropped to the shell user, then stops it and removes its files. lmkd kill
# behaviour is out of scope: it needs a payload larger than MemAvailable.
#
# Usage: lmk-pressure-emulator-smoke.sh <build-dir>
#   <build-dir> holds x86_64/lmk_pressure (scripts/android/build-lmk-pressure.sh).
#
# Environment (test seams):
#   ADB                   adb executable (default: adb)
#   SMOKE_POLL_SECONDS    delay between READY checks (default: 1)
#   SMOKE_READY_ATTEMPTS  READY checks before failing (default: 30)

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: lmk-pressure-emulator-smoke.sh <build-dir>" >&2
  exit 2
fi

binary="$1/x86_64/lmk_pressure"
adb="${ADB:-adb}"
poll_seconds="${SMOKE_POLL_SECONDS:-1}"
attempts="${SMOKE_READY_ATTEMPTS:-30}"
remote="/data/local/tmp/automobile-lmk-pressure-smoke"
output="${remote}.out"
megabytes=64
shell_uid=2000
pid=""

if [ ! -f "$binary" ]; then
  echo "FAIL: $binary not found; run scripts/android/build-lmk-pressure.sh first" >&2
  exit 1
fi

abi="$("$adb" shell getprop ro.product.cpu.abi | tr -d '\r')"
if [ "$abi" != "x86_64" ]; then
  echo "FAIL: expected an x86_64 device, got $abi" >&2
  exit 1
fi

cleanup() {
  if [ -n "$pid" ]; then
    "$adb" shell "kill $pid 2>/dev/null; true" > /dev/null || true
  fi
  "$adb" shell "rm -f $remote $output" > /dev/null || true
}
trap cleanup EXIT

"$adb" push "$binary" "$remote" > /dev/null
"$adb" shell "chmod 755 $remote" > /dev/null
pid="$("$adb" shell "nohup $remote $megabytes 60 >$output 2>&1 </dev/null & echo \$!" | tr -d '\r')"

ready=""
for ((attempt = 0; attempt < attempts; attempt++)); do
  ready="$("$adb" shell "cat $output 2>/dev/null; true" | tr -d '\r')"
  if grep -qx "READY $megabytes" <<<"$ready"; then
    break
  fi
  sleep "$poll_seconds"
done
if ! grep -qx "READY $megabytes" <<<"$ready"; then
  echo "FAIL: payload did not report READY $megabytes; output:" >&2
  printf '%s\n' "${ready:-<empty>}" >&2
  exit 1
fi

uid="$("$adb" shell "grep Uid /proc/$pid/status 2>/dev/null; true" | tr -d '\r' | awk '{print $2}')"
if [ "$uid" != "$shell_uid" ]; then
  echo "FAIL: payload runs as uid ${uid:-unknown}, expected $shell_uid" >&2
  exit 1
fi

"$adb" shell "kill $pid 2>/dev/null; true" > /dev/null
if "$adb" shell "test -d /proc/$pid" > /dev/null 2>&1; then
  echo "FAIL: payload $pid is still running after kill" >&2
  exit 1
fi
pid=""

echo "PASS: x86_64 lmk-pressure payload reached READY $megabytes as uid $shell_uid and stopped"
