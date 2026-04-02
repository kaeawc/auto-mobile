#!/usr/bin/env bats
#
# Tests for scripts/ios/boot-simulator.sh
# These tests mock xcrun to avoid requiring actual Xcode/simulators.

SCRIPT="scripts/ios/boot-simulator.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "fails with unknown argument" {
  run bash "$SCRIPT" --bad-flag
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown argument"* ]]
}

@test "fails when no runtime matches the requested version" {
  # Mock xcrun to return no matching runtime
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.3"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  if [ "$4" = "iOS" ] && [ "$5" = "--json" ]; then
    echo '{"runtimes":[]}'
  else
    echo "== Runtimes =="
  fi
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --ios-version 99.0
  [ "$status" -eq 1 ]
  [[ "$output" == *"no simulator runtime found for iOS 99.0"* ]]
}

@test "looks up runtime dynamically instead of constructing ID" {
  # Verify the script does NOT contain hardcoded runtime ID construction
  ! grep -q 'SimRuntime.iOS-' "$SCRIPT"
}

@test "uses jq to find runtime identifier from simctl output" {
  grep -q 'simctl list runtimes iOS --json' "$SCRIPT"
  grep -q '.identifier' "$SCRIPT"
}
