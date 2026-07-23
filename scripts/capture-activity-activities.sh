#!/usr/bin/env bash
#
# Capture a real `dumpsys activity activities` sample for one Android API level.
#
# Boots a headless emulator for the requested level, drives a known, non-trivial
# back stack (home baseline + Settings task with depth + a second app task), then
# saves the verbatim `dumpsys activity activities` output as a fixture with a
# device/API provenance header. See issue #4329.
#
# The emulator is torn down on exit. System images are NOT uninstalled: the sweep
# is run against a developer machine whose images are reused (issue #4329 note).
#
# Usage:
#   scripts/capture-activity-activities.sh <api-level> [out-dir]
#
# Requires: ANDROID_HOME (or ~/Library/Android/sdk), JDK 21 on JAVA_HOME.

set -euo pipefail

API_LEVEL="${1:?usage: capture-activity-activities.sh <api-level> [out-dir]}"
OUT_DIR="${2:-test/features/observe/activityActivitiesDumps}"

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
EMULATOR="$SDK/emulator/emulator"
AVDMANAGER="$SDK/cmdline-tools/latest/bin/avdmanager"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

# arm64-v8a on Apple Silicon, x86_64 elsewhere (issue #4329).
case "$(uname -m)" in
  arm64|aarch64) ABI="arm64-v8a" ;;
  *) ABI="x86_64" ;;
esac

TAG="google_apis"
PKG="system-images;android-${API_LEVEL};${TAG};${ABI}"
AVD_NAME="am-capture-api${API_LEVEL}"
PORT=5560
SERIAL="emulator-${PORT}"

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || true)}"

log() { echo "[capture api${API_LEVEL}] $*" >&2; }

EMU_PID=""
cleanup() {
  if [ -n "$EMU_PID" ] && kill -0 "$EMU_PID" 2>/dev/null; then
    log "shutting down emulator (pid $EMU_PID)"
    "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
  "$AVDMANAGER" delete avd -n "$AVD_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Ensure the system image is present (install once; kept afterwards).
if [ ! -d "$SDK/system-images/android-${API_LEVEL}/${TAG}/${ABI}" ]; then
  log "installing $PKG"
  # `yes` feeds the license prompts. It dies of SIGPIPE (141) when sdkmanager
  # exits before draining stdin, which under `pipefail` would abort this script
  # even on a SUCCESSFUL install -- so tolerate the pipeline status and decide
  # success by whether the image directory now exists.
  yes | "$SDKMANAGER" "$PKG" >/dev/null || true
  [ -d "$SDK/system-images/android-${API_LEVEL}/${TAG}/${ABI}" ] || {
    log "image install failed: $PKG"
    exit 1
  }
fi

# 2. Create a throwaway AVD for this capture.
"$AVDMANAGER" delete avd -n "$AVD_NAME" >/dev/null 2>&1 || true
log "creating AVD $AVD_NAME"
echo "no" | "$AVDMANAGER" create avd -n "$AVD_NAME" -k "$PKG" --abi "$ABI" --force >/dev/null

# 3. Boot headless.
log "booting emulator on port $PORT"
"$EMULATOR" -avd "$AVD_NAME" -port "$PORT" -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu swiftshader_indirect -wipe-data >/dev/null 2>&1 &
EMU_PID=$!

log "waiting for device"
"$ADB" -s "$SERIAL" wait-for-device
# Wait for full boot (sys.boot_completed=1).
boot=""
for _ in $(seq 1 120); do
  boot="$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$boot" = "1" ] && break
  sleep 2
done
[ "$boot" = "1" ] || { log "boot timed out"; exit 1; }
log "boot completed"
sleep 3

# adb-shell prefix as an ARRAY, not a function: a function invoked in an `|| true`
# best-effort condition disables `set -e` inside it, which the shell-sete gate
# rejects (SC2310, issues #3637/#3640). An external command in `||` does not.
ADB_SH=("$ADB" -s "$SERIAL" shell)

# 4. Drive a known back stack. These steps are best-effort: a failed wake or a
# missing second app must not abort the capture, hence `|| true`.
"${ADB_SH[@]}" input keyevent 82 >/dev/null 2>&1 || true   # wake
"${ADB_SH[@]}" wm dismiss-keyguard >/dev/null 2>&1 || true
"${ADB_SH[@]}" input keyevent 3 >/dev/null 2>&1 || true    # HOME -> launcher task baseline
sleep 1
# Settings task, then a sub-setting to add depth (a second Hist row in one task).
"${ADB_SH[@]}" am start -a android.settings.SETTINGS >/dev/null 2>&1 || true
sleep 2
"${ADB_SH[@]}" am start -a android.settings.WIFI_SETTINGS >/dev/null 2>&1 || true
sleep 2
# A second, distinct app -> a separate task (multi-task modern Task{} blocks).
"${ADB_SH[@]}" am start -a android.intent.action.MAIN -c android.intent.category.APP_CONTACTS >/dev/null 2>&1 \
  || "${ADB_SH[@]}" am start -a android.intent.action.MAIN -c android.intent.category.APP_CALCULATOR >/dev/null 2>&1 \
  || true
sleep 3

# 5. Capture verbatim.
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/api${API_LEVEL}-home-settings-secondapp.log"
RELEASE="$("${ADB_SH[@]}" getprop ro.build.version.release | tr -d '\r')"
SDK_INT="$("${ADB_SH[@]}" getprop ro.build.version.sdk | tr -d '\r')"
FINGERPRINT="$("${ADB_SH[@]}" getprop ro.build.fingerprint | tr -d '\r')"
DUMP="$("${ADB_SH[@]}" dumpsys activity activities)"

{
  echo "# Real 'adb shell dumpsys activity activities' capture (issue #4329)."
  echo "# API level (ro.build.version.sdk): ${SDK_INT}"
  echo "# Android release (ro.build.version.release): ${RELEASE}"
  echo "# System image: ${PKG}"
  echo "# Build fingerprint: ${FINGERPRINT}"
  echo "# Scenario: HOME (launcher) + Settings (with wifi sub-setting) + second app task."
  echo "# Captured by scripts/capture-activity-activities.sh; do not hand-edit."
  echo "#"
  printf '%s\n' "$DUMP"
} > "$OUT_FILE"

log "wrote $OUT_FILE ($(wc -l < "$OUT_FILE" | tr -d ' ') lines)"
echo "$OUT_FILE"
