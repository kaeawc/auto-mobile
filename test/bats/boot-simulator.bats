#!/usr/bin/env bats
#
# Tests for scripts/ios/boot-simulator.sh
# These tests mock xcrun to avoid requiring actual Xcode/simulators.

SCRIPT="scripts/ios/boot-simulator.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  # Exercise the retry path without real sleeps (#4095).
  export BOOT_SIMULATOR_RETRY_DELAY_SECONDS=0
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
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{"name":"iPhone 16","udid":"FAKE-UDID","state":"Booted"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  [ "$4" = "-b" ] || exit 2
  # Real simctl on macOS 26 prints this terminal line on a HEALTHY boot.
  echo "[2026-07-20 13:11:14 +0000] Status=4294967295, isTerminal=YES, Elapsed=01:04."
  echo "	Finished"
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

@test "REGRESSION: a healthy boot that prints Status=4294967295 is NOT rejected" {
  # The first #4078 attempt keyed on the literal string "Status=4294967295" as a
  # wedge sentinel. On macOS 26 / Xcode 26 that terminal status is printed by
  # EVERY boot, including healthy ones (observed in 106/106 CI boots, 102 of
  # which booted fine), so the gate failed 100% of iOS PRs and killed boots as
  # fast as 17s. A healthy boot must pass even though it prints that line.
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.5"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.5.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"name":"iPhone 17 Pro","udid":"HEALTHY-UDID","state":"Booted"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  echo "[2026-07-20 13:11:14 +0000] Status=4294967295, isTerminal=YES, Elapsed=01:04."
  echo "	Finished"
  exit 0
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --ios-version 26.5
  [ "$status" -eq 0 ]
  [[ "$output" == *"HEALTHY-UDID"* ]]
  [[ "$output" != *"failed to boot"* ]]
}

@test "a STALLED boot attempt is bounded so the retry still runs (#4095)" {
  # The retry added in #4095 only ever covered "bootstatus returned, but the
  # device is not Booted". The wedge that motivated #4078 is a HANG -- bootstatus
  # sitting in "Waiting on System App" -- and without a per-attempt bound the
  # first attempt consumed the whole step budget and the retry never ran.
  cat > "${MOCK_BIN}/state" <<'STATE'
Shutdown
STATE
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
STATE_FILE="$(dirname "$0")/state"
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.5"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.5.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo "{\"devices\":{\"com.apple.CoreSimulator.SimRuntime.iOS-26-5\":[{\"name\":\"iPhone 17 Pro\",\"udid\":\"STALL-UDID\",\"state\":\"$(cat "$STATE_FILE")\"}]}}"
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  # First attempt hangs; exec so the timeout actually kills it.
  if [ "$(cat "$STATE_FILE")" = "Shutdown" ]; then
    exec sleep 300
  fi
  exit 0
elif [ "$1" = "simctl" ] && [ "$2" = "erase" ]; then
  echo "Booted" > "$STATE_FILE"
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  local started ended elapsed
  started=$(date +%s)
  BOOT_ATTEMPT_TIMEOUT_SECONDS=2 run bash "$SCRIPT" --ios-version 26.5
  ended=$(date +%s)
  elapsed=$((ended - started))

  # The stalled attempt is abandoned, the retry boots, and the run succeeds.
  [ "$status" -eq 0 ]
  [[ "$output" == *"STALL-UDID"* ]]
  [[ "$output" == *"boot attempt 1/2 failed"* ]]
  # Far below the 300s stall: proof the bound fired rather than the sleep ending.
  [ "$elapsed" -lt 60 ]
}

@test "retries a wedged boot and succeeds on the second attempt (#4095)" {
  # A wedge is usually transient runner state: the first bootstatus leaves the
  # device Shutdown, the retry brings it up. The build must not go red for that.
  cat > "${MOCK_BIN}/state" <<'STATE'
Shutdown
STATE
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
STATE_FILE="$(dirname "$0")/state"
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.5"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.5.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo "{\"devices\":{\"com.apple.CoreSimulator.SimRuntime.iOS-26-5\":[{\"name\":\"iPhone 17 Pro\",\"udid\":\"RETRY-UDID\",\"state\":\"$(cat "$STATE_FILE")\"}]}}"
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  # First attempt leaves it Shutdown; after the shutdown/erase cycle it comes up.
  if [ "$(cat "$STATE_FILE")" = "Shutdown" ]; then
    echo "[..] Status=4294967295, isTerminal=YES, Elapsed=32:06."
    echo "	Finished"
  fi
  exit 0
elif [ "$1" = "simctl" ] && [ "$2" = "erase" ]; then
  echo "Booted" > "$STATE_FILE"
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  run bash "$SCRIPT" --ios-version 26.5

  [ "$status" -eq 0 ]
  [[ "$output" == *"RETRY-UDID"* ]]
  [[ "$output" == *"boot attempt 1/2 failed"* ]]
  [[ "$output" == *"Booted: "* ]]
}

@test "gives up after the bounded attempt budget and reports the last state" {
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.5"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.5.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"name":"iPhone 17 Pro","udid":"DEAD-UDID","state":"Shutdown"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  exit 0
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"

  BOOT_SIMULATOR_MAX_ATTEMPTS=3 run bash "$SCRIPT" --ios-version 26.5

  [ "$status" -eq 1 ]
  [[ "$output" == *"after 3 attempt(s)"* ]]
  [[ "$output" == *"last state=Shutdown"* ]]
  [[ "$output" == *"boot attempt 3/3 failed"* ]]
}

@test "fails when bootstatus exits 0 but the device never reaches Booted (wedge)" {
  # Regression for #4078: a stalled boot exits 0 and prints the same terminal
  # status line a healthy boot does. Only the device STATE distinguishes them,
  # so the script must verify the post-condition, not the status code.
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/bin/sh
if [ "$1" = "--sdk" ] && [ "$2" = "iphonesimulator" ] && [ "$3" = "--show-sdk-version" ]; then
  echo "26.2"
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then
  echo '{"runtimes":[{"version":"26.2.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-2"}]}'
elif [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":[{"name":"iPhone 17 Pro","udid":"WEDGED-UDID","state":"Shutdown"}]}}'
elif [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
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
  [[ "$output" == *"state=Shutdown"* ]]
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
  echo "[2026-07-20 13:11:14 +0000] Status=4294967295, isTerminal=YES, Elapsed=01:04."
  echo "	Finished"
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
