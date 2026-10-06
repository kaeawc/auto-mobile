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
