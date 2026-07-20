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
  [[ "$output" == *"no simulator runtime found"* ]]
}

@test "falls back to major version when exact match unavailable" {
  # Xcode SDK 26.3 but only 26.1, 26.2, 26.4 runtimes available
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.3"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  if [ "$4" = "iOS" ] && [ "$5" = "--json" ]; then
    echo '{"runtimes":[
      {"version":"26.1.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-1"},
      {"version":"26.2.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-2"},
      {"version":"26.4.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4"}
    ]}'
  else
    echo "== Runtimes =="
    echo "iOS 26.1 (26.1 - 23A1) - com.apple.CoreSimulator.SimRuntime.iOS-26-1"
    echo "iOS 26.2 (26.2 - 23B1) - com.apple.CoreSimulator.SimRuntime.iOS-26-2"
    echo "iOS 26.4 (26.4 - 23D1) - com.apple.CoreSimulator.SimRuntime.iOS-26-4"
  fi
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{"name":"iPhone 16","udid":"FAKE-UDID","state":"Shutdown"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  [ "$4" = "-b" ] || exit 2
  exit 0
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --ios-version 26.3
  [ "$status" -eq 0 ]
  # Script succeeds and returns the UDID — proves the fallback to 26.4 worked
  # (if no fallback, the script would exit 1 with "no simulator runtime found")
  [[ "$output" == *"FAKE-UDID"* ]]
}

@test "looks up runtime dynamically instead of constructing ID" {
  # Verify the script does NOT contain hardcoded runtime ID construction
  ! grep -q 'SimRuntime.iOS-' "$SCRIPT"
}

@test "uses jq to find runtime identifier from simctl output" {
  grep -q 'simctl list runtimes iOS --json' "$SCRIPT"
  grep -q '.identifier' "$SCRIPT"
}

@test "fails when bootstatus reports a wedged boot (Status=4294967295) but exits 0" {
  # Regression for #4078: a stalled boot can print a terminal error status and
  # still exit 0. The script must not report "Booted:" and press on.
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.2"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.2.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-2"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":[{"name":"iPhone 17 Pro","udid":"WEDGED-UDID","state":"Shutdown"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  # Wedged boot: prints a terminal failure status yet exits 0.
  echo "[2026-07-20 15:00:16 +0000] Status=4294967295, isTerminal=YES, Elapsed=32:06."
  echo "	Finished"
  exit 0
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --ios-version 26.2
  [ "$status" -eq 1 ]
  [[ "$output" == *"failed to boot"* ]]
  [[ "$output" != *"Booted: "* ]]
}

@test "fails when bootstatus exits non-zero" {
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.2"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.2.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-2"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":[{"name":"iPhone 17 Pro","udid":"FAIL-UDID","state":"Shutdown"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  echo "bootstatus: device failed to boot" >&2
  exit 164
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --ios-version 26.2
  [ "$status" -eq 1 ]
  [[ "$output" == *"failed to boot"* ]]
}

@test "uses bootstatus -b so already-booted simulators are accepted" {
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.2"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.2.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-2"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":[{"name":"iPhone 17 Pro","udid":"BOOTED-UDID","state":"Booted"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "boot" ]; then
  echo "boot should not be called" >&2
  exit 149
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  [ "$3" = "BOOTED-UDID" ] || exit 2
  [ "$4" = "-b" ] || exit 2
  exit 0
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --ios-version 26.2
  [ "$status" -eq 0 ]
  [[ "$output" == *"BOOTED-UDID"* ]]
  [[ "$output" != *"boot should not be called"* ]]
}
