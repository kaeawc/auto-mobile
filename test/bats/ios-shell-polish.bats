#!/usr/bin/env bats
#
# Tests for the iOS shell-script polish fixes in #3652:
#  A) setup-ios-simulator.sh: "iPhone 16" preference must not match "iPhone 16e"
#  B) ctrl-proxy-run.sh: SIMULATOR_NAME must be the device name, not the UDID
#  C) ensure-simulator-runtime.sh: unknown-arg message must name the bad arg
#  D) local/validate-ios.sh: simctl check must not use `command -v xcrun simctl`

setup() {
  WORK_DIR="$(mktemp -d)"
  STUB_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$WORK_DIR" "$STUB_DIR"
}

# --- A ---------------------------------------------------------------------
@test "find_simulator_device prefers 'iPhone 16', not 'iPhone 16e'" {
  local script="scripts/ios/setup-ios-simulator.sh"
  local abs
  abs="$(cd "$(dirname "$script")" && pwd)/$(basename "$script")"

  # Stub xcrun to list both an iPhone 16e and an iPhone 16.
  cat > "$STUB_DIR/xcrun" <<'EOF'
#!/usr/bin/env bash
cat <<'DEVS'
    iPhone 16e (AAAA-0001) (Shutdown)
    iPhone 16 (BBBB-0002) (Shutdown)
DEVS
EOF
  chmod +x "$STUB_DIR/xcrun"

  local fn="$WORK_DIR/find_simulator_device.sh"
  awk '/^find_simulator_device\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$abs" > "$fn"

  run env PATH="$STUB_DIR:$PATH" bash -c '
    source "$1"
    log_debug() { :; }
    find_simulator_device "17.0"
  ' _ "$fn"

  [ "$status" -eq 0 ]
  [ "$output" = "iPhone 16" ]
}

# --- B ---------------------------------------------------------------------
@test "ctrl-proxy-run extracts the device name, not the UDID" {
  # Pull the sed program the SIMULATOR_NAME line actually uses and run it on a
  # booted-device line; the old greedy sed captured the UDID.
  local sed_cmd
  sed_cmd="$(grep 'SIMULATOR_NAME=' scripts/ios/ctrl-proxy-run.sh | grep -oE "sed '[^']*'")"
  [ -n "$sed_cmd" ]
  run bash -c "printf '    iPhone 16 (1234-ABCD) (Booted)\n' | $sed_cmd"
  [ "$output" = "iPhone 16" ]
}

# --- C ---------------------------------------------------------------------
@test "ensure-simulator-runtime names the offending unknown argument" {
  local script="scripts/ios/ensure-simulator-runtime.sh"
  run bash "$script" --check-only --bogus-flag
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown argument: --bogus-flag"* ]]
}

# --- D ---------------------------------------------------------------------
@test "validate-ios does not probe simctl via 'command -v xcrun simctl'" {
  # Ignore comment lines (the fix documents the old broken form in a comment).
  local hits
  hits="$(grep -vE '^\s*#' scripts/local/validate-ios.sh | grep -n 'command -v xcrun simctl' || true)"
  [ -z "$hits" ]
}
