#!/usr/bin/env bats
#
# Tests for scripts/local-dev/probe-android-locale.sh.

SCRIPT="scripts/local-dev/probe-android-locale.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  ORIG_ANDROID_HOME="${ANDROID_HOME-}"
  ORIG_ANDROID_HOME_SET="${ANDROID_HOME+x}"
  ORIG_ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT-}"
  ORIG_ANDROID_SDK_ROOT_SET="${ANDROID_SDK_ROOT+x}"
  export INVOCATION_FILE="${MOCK_BIN}/adb-invocations"
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

make_mock_adb() {
  cat > "${MOCK_BIN}/adb" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "-s" ]; then
  serial="$2"
  shift 2
else
  serial=""
fi
printf '%s %s\n' "${serial}" "$*" >> "${INVOCATION_FILE}"

case "$*" in
  "wait-for-device")
    exit 0
    ;;
  "root")
    echo "adbd cannot run as root in production builds"
    exit 1
    ;;
  "shell id")
    echo "uid=2000(shell) gid=2000(shell)"
    exit 0
    ;;
  "shell getprop dev.bootcomplete"|"shell getprop sys.boot_completed")
    echo "1"
    exit 0
    ;;
  "shell getprop ro.build.version.sdk")
    echo "36"
    exit 0
    ;;
  "shell setprop persist.sys.locale fr-FR")
    echo "Failed to set property 'persist.sys.locale' to 'fr-FR'." >&2
    exit 1
    ;;
  "shell cmd locale get-app-locales com.android.settings")
    echo "Locales for com.android.settings for user 0 are []"
    exit 0
    ;;
  "shell cmd locale set-app-locales com.android.settings --locales fr-FR"|"shell cmd locale set-app-locales com.android.settings --locales ")
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

@test "uses supplied ADB_SERIAL without requiring emulator binary" {
  make_mock_adb

  run env ADB_SERIAL=emulator-5554 KILL_ON_EXIT=true BOOT_TIMEOUT_SECONDS=5 bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" != *"emulator not found"* ]]
  [[ "$output" == *"system setprop before adb root: failed"* ]]
  [[ "$output" == *"adb root: failed"* ]]
  [[ "$output" == *"system setprop after adb root: skipped"* ]]
  [[ "$output" == *"per-app cmd locale: succeeded"* ]]
  if grep -q "emu kill" "$INVOCATION_FILE"; then
    echo "script should not kill externally supplied ADB_SERIAL" >&2
    return 1
  fi
}
