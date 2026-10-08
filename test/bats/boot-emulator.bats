#!/usr/bin/env bats

SCRIPT="scripts/android/boot-emulator.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  export PATH="${MOCK_BIN}:${PATH}"
  export ADB_LOG_FILE="${MOCK_BIN}/adb.log"
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
if [[ "$*" == *"dumpsys window policy" ]]; then
  printf 'isKeyguardShowing=false\n'
fi
MOCK
  chmod +x "${MOCK_BIN}/adb"
}

@test "dismisses a showing keyguard and verifies it cleared" {
  export KEYGUARD_COUNT_FILE="${MOCK_BIN}/keyguard-count"
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ADB_LOG_FILE"
if [[ "$*" == *"dumpsys window policy" ]]; then
  count=0
  [[ -f "$KEYGUARD_COUNT_FILE" ]] && count="$(<"$KEYGUARD_COUNT_FILE")"
  count=$((count + 1))
  printf '%s' "$count" > "$KEYGUARD_COUNT_FILE"
  if (( count == 1 )); then printf 'mShowingLockscreen=true\n'; else printf 'mShowingLockscreen=false\n'; fi
fi
MOCK
  chmod +x "${MOCK_BIN}/adb"
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"

  run env AUTOMOBILE_KEYGUARD_RETRY_SLEEP_SECONDS=0 bash "$SCRIPT"

  [ "$status" -eq 0 ]
  grep -Fq -- '-s emulator-5554 shell wm dismiss-keyguard' "$ADB_LOG_FILE"
  grep -Fq -- '-s emulator-5554 shell input keyevent 82' "$ADB_LOG_FILE"
  [ "$(grep -c 'dumpsys window policy' "$ADB_LOG_FILE")" -ge 2 ]
}

@test "already-unlocked boot does not send extra keyguard dismiss commands" {
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ADB_LOG_FILE"
if [[ "$*" == *"dumpsys window policy" ]]; then printf 'isKeyguardShowing=false\n'; fi
MOCK
  chmod +x "${MOCK_BIN}/adb"
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  if grep -Eq 'wm dismiss-keyguard|input keyevent 82' "$ADB_LOG_FILE"; then
    echo "already-unlocked boot sent an unnecessary dismissal command" >&2
    return 1
  fi
}

@test "unreadable keyguard state warns and continues boot with policy diagnostics" {
  export AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR="${MOCK_BIN}/diagnostics"
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ADB_LOG_FILE"
if [[ "$*" == *"dumpsys window policy" ]]; then printf 'Window policy dump without keyguard state\n'; fi
MOCK
  chmod +x "${MOCK_BIN}/adb"
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"

  run env AUTOMOBILE_KEYGUARD_RETRIES=2 AUTOMOBILE_KEYGUARD_RETRY_SLEEP_SECONDS=0 \
    AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR="${AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR}" bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"warning: Android keyguard state remains unreadable; continuing boot"* ]]
  [[ "$output" != *"error: Android keyguard"* ]]
  [[ "$output" == *"emulator-5554"* ]]
  [ "$(grep -c 'dumpsys window policy' "$ADB_LOG_FILE")" -eq 4 ]
  [ "$(<"${AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR}/keyguard-window-policy.txt")" = "Window policy dump without keyguard state" ]
}

@test "keyguard that never clears fails with bounded retries and policy diagnostics" {
  export AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR="${MOCK_BIN}/diagnostics"
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ADB_LOG_FILE"
if [[ "$*" == *"dumpsys window policy" ]]; then printf 'mShowingLockscreen=true\n'; fi
MOCK
  chmod +x "${MOCK_BIN}/adb"
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  cat > "${MOCK_BIN}/collect-emulator-diagnostics.sh" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
  # boot-emulator resolves this collector beside itself; use a temp copy of
  # the script tree so the failure path stays hermetic.
  mkdir -p "${MOCK_BIN}/scripts/android"
  cp scripts/android/boot-emulator.sh "${MOCK_BIN}/scripts/android/boot-emulator.sh"
  cp "${MOCK_BIN}/collect-emulator-diagnostics.sh" "${MOCK_BIN}/scripts/android/collect-emulator-diagnostics.sh"
  chmod +x "${MOCK_BIN}/scripts/android/collect-emulator-diagnostics.sh"

  run env AUTOMOBILE_KEYGUARD_RETRIES=2 AUTOMOBILE_KEYGUARD_RETRY_SLEEP_SECONDS=0 \
    AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR="${AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR}" \
    bash "${MOCK_BIN}/scripts/android/boot-emulator.sh"

  [ "$status" -eq 1 ]
  [[ "$output" == *"keyguard did not become verified-unlocked"* ]]
  [ "$(grep -c 'dumpsys window policy' "$ADB_LOG_FILE")" -eq 4 ]
  [ "$(<"${AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR}/keyguard-window-policy.txt")" = "mShowingLockscreen=true" ]
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

@test "forwards the selected AVD to the daemon-free boot product" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$BUN_ARGS_FILE"
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  args_file="$(mktemp)"
  run env BUN_ARGS_FILE="$args_file" bash -c 'cd /tmp && "$1" --avd-name pixel_ci' _ "$(pwd)/$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = "emulator-5554" ]
  [[ "$(<"$args_file")" == *"--timeout-ms"* ]]
  [[ "$(<"$args_file")" == *"600000"* ]]
  rm -f "$args_file"
}

@test "parses device JSON from stdout when boot writes a warning to stderr" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
echo "warning: something" >&2
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"

  run env bash -c 'cd /tmp && "$1" --avd-name pixel_ci' _ "$(pwd)/$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$output" = "emulator-5554" ]
}

@test "waits for progress-mode boot output before parsing device JSON" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
sleep 0.2
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  cat > "${MOCK_BIN}/tail" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$TAIL_ARGS_FILE"
MOCK
  chmod +x "${MOCK_BIN}/tail"
  tail_args_file="$(mktemp)"

  run env AUTOMOBILE_BOOT_PROGRESS=true TAIL_ARGS_FILE="$tail_args_file" bash -c 'cd /tmp && "$1" --avd-name pixel_ci' _ "$(pwd)/$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"emulator-5554"* ]]
  [[ "$(<"$tail_args_file")" == "-f "*"/boot-device.log" ]]
  rm -f "$tail_args_file"
}

@test "rejects an empty boot device ID and collects diagnostics" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{"deviceId":""}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' 'List of devices attached'
MOCK
  cat > "${MOCK_BIN}/timeout" <<'MOCK'
#!/usr/bin/env bash
shift 3 # -k 2 <seconds>
"$@"
MOCK
  chmod +x "${MOCK_BIN}/adb" "${MOCK_BIN}/timeout"
  diagnostics_dir="$(mktemp -d)"

  run env AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR="$diagnostics_dir" bash -c 'cd /tmp && "$1"' _ "$(pwd)/$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"returned no deviceId"* ]]
  [ -f "${diagnostics_dir}/failure-reason.txt" ]
  rm -rf "$diagnostics_dir"
}

@test "bounds every adb diagnostics command" {
  cat > "${MOCK_BIN}/timeout" <<'MOCK'
#!/usr/bin/env bash
shift 3 # -k 2 <seconds>
printf '%s\n' "$*" >> "${TIMEOUT_COMMANDS_FILE}"
"$@"
MOCK
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then
  printf '%s\n' 'List of devices attached' 'emulator-5554 device'
fi
MOCK
  chmod +x "${MOCK_BIN}/timeout" "${MOCK_BIN}/adb"
  diagnostics_dir="$(mktemp -d)"
  timeout_commands_file="$(mktemp)"

  run env TIMEOUT_COMMANDS_FILE="$timeout_commands_file" bash "$(pwd)/scripts/android/collect-emulator-diagnostics.sh" "$diagnostics_dir" "test failure"

  [ "$status" -eq 0 ]
  [ "$(grep -c '^adb ' "$timeout_commands_file" | tr -d '[:space:]')" -eq 8 ]
  grep -Fqx 'adb devices -l' "$timeout_commands_file"
  grep -Fqx 'adb -s emulator-5554 shell getprop' "$timeout_commands_file"
  grep -Fqx 'adb -s emulator-5554 shell ps -A' "$timeout_commands_file"
  grep -Fqx 'adb -s emulator-5554 shell dumpsys activity services' "$timeout_commands_file"
  grep -Fqx 'adb -s emulator-5554 shell dumpsys accessibility' "$timeout_commands_file"
  grep -Fqx 'adb -s emulator-5554 forward --list' "$timeout_commands_file"
  grep -Fqx 'adb -s emulator-5554 shell dumpsys package dev.jasonpearson.automobile.ctrlproxy' "$timeout_commands_file"
  grep -Fqx 'adb -s emulator-5554 logcat -d -v threadtime' "$timeout_commands_file"
  rm -rf "$diagnostics_dir"
  rm -f "$timeout_commands_file"
}

# Writes an adb mock whose `dumpsys window windows` shows the given ANR dialog process for the first
# $DIALOG_SHOWN_CHECKS checks (real dumpsys shape: the window line plus a surface line that repeats
# the title), whose SystemUI pid becomes 222 once a CLOSE_SYSTEM_DIALOGS broadcast was sent, and
# whose keyguard shows again after that SystemUI restart.
write_error_dialog_adb_mock() {
  export DIALOG_PROCESS="$1" DIALOG_SHOWN_CHECKS="$2" STATE_DIR="${MOCK_BIN}/state"
  mkdir -p "$STATE_DIR"
  cat > "${MOCK_BIN}/adb" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ADB_LOG_FILE"
bump() { local n=0; [[ -f "$STATE_DIR/$1" ]] && n="$(<"$STATE_DIR/$1")"; n=$((n + 1)); printf '%s' "$n" > "$STATE_DIR/$1"; printf '%s' "$n"; }
case "$*" in
  *"dumpsys window windows")
    if (( $(bump dialog-checks) <= DIALOG_SHOWN_CHECKS )); then
      printf '  Window #6 Window{854b6c9 u0 Application Not Responding: %s}:\n' "$DIALOG_PROCESS"
      printf '    mSurfaceControl=Surface(name=Application Not Responding: %s)/@0x712fbef\n' "$DIALOG_PROCESS"
    fi
    printf '  Window #7 Window{1 u0 com.google.android.apps.nexuslauncher}:\n'
    ;;
  *"am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS") touch "$STATE_DIR/broadcast" ;;
  *"pidof com.android.systemui")
    if [[ -f "$STATE_DIR/broadcast" ]]; then printf '222\n'; else printf '111\n'; fi
    ;;
  *"dumpsys window policy")
    if [[ -f "$STATE_DIR/broadcast" ]] && (( $(bump policy-after-restart) == 1 )); then
      printf 'mShowingLockscreen=true\n'
    else
      printf 'mShowingLockscreen=false\n'
    fi
    ;;
esac
MOCK
  chmod +x "${MOCK_BIN}/adb"
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{"deviceId":"emulator-5554"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
}

run_boot_with_fast_retries() {
  run env AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR="${MOCK_BIN}/diagnostics" \
    AUTOMOBILE_KEYGUARD_RETRY_SLEEP_SECONDS=0 AUTOMOBILE_ERROR_DIALOG_RETRY_SLEEP_SECONDS=0 \
    AUTOMOBILE_SYSTEMUI_RESTART_SLEEP_SECONDS=0 bash "$SCRIPT"
}

@test "boot without a system error dialog sends no CLOSE_SYSTEM_DIALOGS broadcast" {
  write_error_dialog_adb_mock com.google.android.apps.nexuslauncher 0

  run_boot_with_fast_retries

  [ "$status" -eq 0 ]
  [ "$output" = "emulator-5554" ]
  if grep -Fq 'CLOSE_SYSTEM_DIALOGS' "$ADB_LOG_FILE"; then
    echo "a clean boot broadcast CLOSE_SYSTEM_DIALOGS" >&2
    return 1
  fi
  [ ! -e "${MOCK_BIN}/diagnostics/system-error-dialogs.txt" ]
}

@test "dismisses a boot-time launcher ANR dialog without waiting for SystemUI" {
  write_error_dialog_adb_mock com.google.android.apps.nexuslauncher 1

  run_boot_with_fast_retries

  [ "$status" -eq 0 ]
  [ "$output" = "emulator-5554" ]
  [ "$(grep -c 'CLOSE_SYSTEM_DIALOGS' "$ADB_LOG_FILE")" -eq 1 ]
  if grep -Fq 'pidof com.android.systemui' "$ADB_LOG_FILE"; then
    echo "a launcher dialog waited for a SystemUI restart" >&2
    return 1
  fi
  [ "$(<"${MOCK_BIN}/diagnostics/system-error-dialogs.txt")" = "Application Not Responding: com.google.android.apps.nexuslauncher" ]
}

@test "a dismissed SystemUI ANR dialog waits for the restart and re-dismisses the keyguard" {
  write_error_dialog_adb_mock com.android.systemui 1

  run_boot_with_fast_retries

  [ "$status" -eq 0 ]
  [ "$output" = "emulator-5554" ]
  [ "$(grep -c 'CLOSE_SYSTEM_DIALOGS' "$ADB_LOG_FILE")" -eq 1 ]
  [ "$(grep -c 'pidof com.android.systemui' "$ADB_LOG_FILE")" -ge 2 ]
  # The keyguard the SystemUI restart re-showed is dismissed after the broadcast.
  [ "$(sed -n '/CLOSE_SYSTEM_DIALOGS/,$p' "$ADB_LOG_FILE" | grep -c 'wm dismiss-keyguard')" -eq 1 ]
}

@test "a system error dialog that never clears warns after bounded retries and continues" {
  write_error_dialog_adb_mock com.google.android.apps.nexuslauncher 99

  run env AUTOMOBILE_ERROR_DIALOG_RETRIES=2 AUTOMOBILE_EMULATOR_DIAGNOSTICS_DIR="${MOCK_BIN}/diagnostics" \
    AUTOMOBILE_KEYGUARD_RETRY_SLEEP_SECONDS=0 AUTOMOBILE_ERROR_DIALOG_RETRY_SLEEP_SECONDS=0 bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"warning: system error dialogs are still showing after boot: Application Not Responding: com.google.android.apps.nexuslauncher"* ]]
  [[ "$output" == *"emulator-5554" ]]
  [ "$(grep -c 'CLOSE_SYSTEM_DIALOGS' "$ADB_LOG_FILE")" -eq 2 ]
}
