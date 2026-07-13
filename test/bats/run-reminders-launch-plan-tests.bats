#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci/run-reminders-launch-plan-tests.sh"
  TEST_DIR="$(mktemp -d)"
  STUB_BIN="$TEST_DIR/bin"
  mkdir -p "$STUB_BIN"
  cat > "$STUB_BIN/swift" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${SWIFT_STUB_ARGS_FILE:?}"
case "${SWIFT_STUB_MODE:-pass}" in
  pass)
    echo "Test Case '-[XCTestRunnerTests.RemindersLaunchPlanTests testLaunchRemindersPlan]' passed (1.0 seconds)."
    exit 0
    ;;
  zero)
    echo "Test Suite 'Selected tests' passed"
    echo "Executed 0 tests, with 0 failures"
    exit 0
    ;;
  fail)
    echo "Test Case '-[XCTestRunnerTests.RemindersLaunchPlanTests testLaunchRemindersPlan]' failed (1.0 seconds)."
    exit 1
    ;;
esac
STUB
  chmod +x "$STUB_BIN/swift"
  export PATH="$STUB_BIN:$PATH"
  export SWIFT_STUB_ARGS_FILE="$TEST_DIR/swift-args.txt"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "runs the RemindersLaunchPlanTests filter" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan" ]
}

@test "fails when SwiftPM reports zero filtered XCTest cases" {
  run env SWIFT_STUB_MODE=zero bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"without executing testLaunchRemindersPlan"* ]]
}

@test "preserves a real Reminders test failure status" {
  run env SWIFT_STUB_MODE=fail bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"testLaunchRemindersPlan]' failed"* ]]
  [[ "$output" != *"without executing testLaunchRemindersPlan"* ]]
}
