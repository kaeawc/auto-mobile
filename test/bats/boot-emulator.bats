#!/usr/bin/env bats

SCRIPT="scripts/android/boot-emulator.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  export PATH="${MOCK_BIN}:${PATH}"
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
