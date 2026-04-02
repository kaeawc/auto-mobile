#!/usr/bin/env bats
#
# Tests for scripts/ios/ensure-simulator-runtime.sh
# These tests mock xcrun/xcodebuild to avoid requiring actual Xcode.

SCRIPT="scripts/ios/ensure-simulator-runtime.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

mock_xcrun_with_runtimes() {
  local sdk_version="$1"
  local runtime_json="$2"
  cat > "${MOCK_BIN}/xcrun" <<SCRIPT
#!/bin/sh
if [ "\$1" = "--sdk" ] && [ "\$2" = "iphonesimulator" ] && [ "\$3" = "--show-sdk-version" ]; then
  echo "${sdk_version}"
elif [ "\$1" = "simctl" ] && [ "\$2" = "list" ] && [ "\$3" = "runtimes" ]; then
  echo '${runtime_json}'
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "exits 0 when matching runtime is present" {
  mock_xcrun_with_runtimes "26.3.1" '{"runtimes":[{"version":"26.3.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-3"}]}'
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --check-only
  [ "$status" -eq 0 ]
  [[ "$output" == *"major_minor=26.3"* ]]
  [[ "$output" == *"needs_download=false"* ]]
}

@test "exits 1 with --check-only when runtime is missing" {
  mock_xcrun_with_runtimes "26.3.1" '{"runtimes":[]}'
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --check-only
  [ "$status" -eq 1 ]
  [[ "$output" == *"needs_download=true"* ]]
}

@test "does not match different major.minor" {
  # SDK 26.0 should not match 26.3 runtimes
  mock_xcrun_with_runtimes "26.0.1" '{"runtimes":[{"version":"26.3.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-3"}]}'
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --check-only
  [ "$status" -eq 1 ]
  [[ "$output" == *"major_minor=26.0"* ]]
  [[ "$output" == *"needs_download=true"* ]]
}

@test "matches runtime with correct major.minor" {
  mock_xcrun_with_runtimes "26.3.0" '{"runtimes":[{"version":"26.3.0","identifier":"a"},{"version":"26.0.0","identifier":"b"}]}'
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --check-only
  [ "$status" -eq 0 ]
  [[ "$output" == *"runtime_count=1"* ]]
}
