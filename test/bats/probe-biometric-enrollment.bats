#!/usr/bin/env bats
#
# Tests for scripts/local-dev/probe-biometric-enrollment.sh.
#
# The script is a live-emulator smoke test; these BATS cases drive it against a
# mock `adb` so the enrollment/match/unlock control flow is exercised without a
# real device, and confirm the skip-cleanly contract when no device exists.

SCRIPT="scripts/local-dev/probe-biometric-enrollment.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  ORIG_ANDROID_HOME="${ANDROID_HOME-}"
  ORIG_ANDROID_HOME_SET="${ANDROID_HOME+x}"
  ORIG_ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT-}"
  ORIG_ANDROID_SDK_ROOT_SET="${ANDROID_SDK_ROOT+x}"
  export INVOCATION_FILE="${MOCK_BIN}/adb-invocations"
  export KEYGUARD_STATE_FILE="${MOCK_BIN}/keyguard-state"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
  if [ -n "$ORIG_ANDROID_HOME_SET" ]; then
    export ANDROID_HOME="$ORIG_ANDROID_HOME"
  else
    unset ANDROID_HOME
  fi
  if [ -n "$ORIG_ANDROID_SDK_ROOT_SET" ]; then
    export ANDROID_SDK_ROOT="$ORIG_ANDROID_SDK_ROOT"
  else
    unset ANDROID_SDK_ROOT
  fi
}

# A stateful mock emulator: `emu finger touch 1` (the enrolled id) unlocks the
# keyguard, any other finger leaves it locked, and `input keyevent 26` re-locks.
make_mock_adb() {
  printf 'isKeyguardShowing=true' > "${KEYGUARD_STATE_FILE}"
  cat > "${MOCK_BIN}/adb" << 'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then
  serial="$2"
  shift 2
else
  serial=""
fi
printf '%s %s\n' "${serial}" "$*" >> "${INVOCATION_FILE}"

case "$*" in
  "devices")
    printf 'List of devices attached\nemulator-5554\tdevice\n'
    exit 0
    ;;
  "-s emulator-5554 emu avd name"|"emu avd name")
    echo "Pixel_9"
    exit 0
    ;;
  "wait-for-device")
    exit 0
    ;;
  "shell getprop dev.bootcomplete"|"shell getprop sys.boot_completed")
    echo "1"
    exit 0
    ;;
  "shell getprop ro.kernel.qemu")
    echo "1"
    exit 0
    ;;
  "emu help")
    printf 'android console command help:\n  finger        manage emulator fingerprint\n  kill          kill the emulator\n'
    exit 0
    ;;
  "shell locksettings set-pin 1234"|"shell cmd lock_settings set-pin --old 1234 1234"|"shell cmd lock_settings set-disabled --old 1234 false"|"shell settings put secure lock_screen_lock_after_timeout 0")
    exit 0
    ;;
  "shell am start -a android.settings.FINGERPRINT_ENROLL")
    exit 0
    ;;
  "shell input text 1234")
    exit 0
    ;;
  "shell input keyevent 66")
    printf 'isKeyguardShowing=false' > "${KEYGUARD_STATE_FILE}"
    exit 0
    ;;
  "shell cmd fingerprint sync")
    exit 0
    ;;
  "shell dumpsys fingerprint")
    echo 'prints:[{"id":0,"count":1,"deviceId":0}]'
    exit 0
    ;;
  "shell input keyevent 26")
    printf 'isKeyguardShowing=true' > "${KEYGUARD_STATE_FILE}"
    exit 0
    ;;
  "emu finger touch 1")
    printf 'isKeyguardShowing=false' > "${KEYGUARD_STATE_FILE}"
    exit 0
    ;;
  "emu finger remove "*|"emu finger touch "*)
    exit 0
    ;;
  "shell dumpsys window")
    if [ "${KEYGUARD_FIELD_STYLE:-modern}" = "legacy" ]; then
      state="$(sed 's/isKeyguardShowing=//' "${KEYGUARD_STATE_FILE}")"
      printf '    KeyguardServiceDelegate\n'
      printf '      showing=%s\n' "${state}"
      printf '      KeyguardStateMonitor\n'
      printf '        mIsShowing=%s\n' "${state}"
    else
      cat "${KEYGUARD_STATE_FILE}"
      printf '\n'
    fi
    exit 0
    ;;
esac

exit 0
SCRIPT
  chmod +x "${MOCK_BIN}/adb"
  unset ANDROID_HOME
  unset ANDROID_SDK_ROOT
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "skips cleanly when adb is not on PATH" {
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  unset ANDROID_HOME
  unset ANDROID_SDK_ROOT

  run env BOOT_TIMEOUT_SECONDS=5 bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP:"* ]]
  [[ "$output" == *"adb not found"* ]]
}

@test "fails instead of skipping when REQUIRE_DEVICE=true and adb missing" {
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  unset ANDROID_HOME
  unset ANDROID_SDK_ROOT

  run env REQUIRE_DEVICE=true BOOT_TIMEOUT_SECONDS=5 bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ERROR:"* ]]
  [[ "$output" == *"adb not found"* ]]
}

@test "runs the enrollment/match/unlock sequence against a mock emulator" {
  make_mock_adb

  run env ADB_SERIAL=emulator-5554 BOOT_TIMEOUT_SECONDS=5 ENROLL_TOUCH_CYCLES=2 bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"enrollment (dumpsys fingerprint): succeeded"* ]]
  [[ "$output" == *"unlock with enrolled finger:      succeeded"* ]]
  [[ "$output" == *"reject non-enrolled finger:       succeeded"* ]]
  [[ "$output" == *"smoke test PASSED"* ]]

  # The documented enrollment + validation adb calls were actually issued.
  grep -q "emu finger touch 1" "$INVOCATION_FILE"
  grep -q "emu finger touch 2" "$INVOCATION_FILE"
  grep -q "shell dumpsys fingerprint" "$INVOCATION_FILE"
  grep -q "shell locksettings set-pin 1234" "$INVOCATION_FILE"
  grep -q "shell cmd lock_settings set-pin --old 1234 1234" "$INVOCATION_FILE"
  grep -q "shell cmd lock_settings set-disabled --old 1234 false" "$INVOCATION_FILE"
  grep -q "shell settings put secure lock_screen_lock_after_timeout 0" "$INVOCATION_FILE"
  grep -q "shell input keyevent 3" "$INVOCATION_FILE"
}

@test "accepts legacy API 29 KeyguardServiceDelegate keyguard output" {
  make_mock_adb

  run env ADB_SERIAL=emulator-5554 BOOT_TIMEOUT_SECONDS=5 ENROLL_TOUCH_CYCLES=2 KEYGUARD_FIELD_STYLE=legacy bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"keyguard before match: isKeyguardShowing=true"* ]]
  [[ "$output" == *"keyguard after match:  isKeyguardShowing=false"* ]]
  [[ "$output" == *"keyguard after mismatch: isKeyguardShowing=true"* ]]
  [[ "$output" == *"smoke test PASSED"* ]]
}

@test "skips cleanly when the device does not expose emu finger" {
  make_mock_adb
  # Override emu help so `finger` is absent.
  cat > "${MOCK_BIN}/adb" << 'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then shift 2; fi
case "$*" in
  "wait-for-device") exit 0 ;;
  "shell getprop dev.bootcomplete"|"shell getprop sys.boot_completed") echo "1"; exit 0 ;;
  "shell getprop ro.kernel.qemu") echo "1"; exit 0 ;;
  "emu help") printf 'android console command help:\n  kill  kill the emulator\n'; exit 0 ;;
esac
exit 0
SCRIPT
  chmod +x "${MOCK_BIN}/adb"

  run env ADB_SERIAL=emulator-5554 BOOT_TIMEOUT_SECONDS=5 bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP:"* ]]
  [[ "$output" == *"does not expose 'emu finger'"* ]]
}

@test "skips cleanly when the target is not an emulator" {
  make_mock_adb
  cat > "${MOCK_BIN}/adb" << 'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then shift 2; fi
case "$*" in
  "wait-for-device") exit 0 ;;
  "shell getprop dev.bootcomplete"|"shell getprop sys.boot_completed") echo "1"; exit 0 ;;
  "shell getprop ro.kernel.qemu") echo ""; exit 0 ;;
esac
exit 0
SCRIPT
  chmod +x "${MOCK_BIN}/adb"

  run env ADB_SERIAL=emulator-5554 BOOT_TIMEOUT_SECONDS=5 bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP:"* ]]
  [[ "$output" == *"is not an emulator"* ]]
}
