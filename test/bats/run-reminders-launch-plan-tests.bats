#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci/run-reminders-launch-plan-tests.sh"
  TEST_DIR="$(mktemp -d)"
  STUB_BIN="$TEST_DIR/bin"
  mkdir -p "$STUB_BIN"
  cat > "$STUB_BIN/swift" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SWIFT_STUB_ARGS_FILE:?}"
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
  zero_then_pass)
    calls_file="${SWIFT_STUB_CALLS_FILE:?}"
    calls=0
    if [[ -f "$calls_file" ]]; then
      calls="$(cat "$calls_file")"
    fi
    calls=$((calls + 1))
    printf '%s\n' "$calls" > "$calls_file"
    if [[ "$calls" -eq 1 ]]; then
      echo "Test Suite 'Selected tests' passed"
      echo "Executed 0 tests, with 0 failures"
      exit 0
    fi
    echo "Test Case '-[XCTestRunnerTests.RemindersLaunchPlanTests testLaunchRemindersPlan]' passed (1.0 seconds)."
    exit 0
    ;;
  zero_twice_then_pass)
    calls_file="${SWIFT_STUB_CALLS_FILE:?}"
    calls=0
    if [[ -f "$calls_file" ]]; then
      calls="$(cat "$calls_file")"
    fi
    calls=$((calls + 1))
    printf '%s\n' "$calls" > "$calls_file"
    if [[ "$calls" -lt 3 ]]; then
      echo "Test Suite 'Selected tests' passed"
      echo "Executed 0 tests, with 0 failures"
      exit 0
    fi
    echo "Test Case '-[XCTestRunnerTests.RemindersLaunchPlanTests testLaunchRemindersPlan]' passed (1.0 seconds)."
    exit 0
    ;;
  zero_three_times_then_pass)
    calls_file="${SWIFT_STUB_CALLS_FILE:?}"
    calls=0
    if [[ -f "$calls_file" ]]; then
      calls="$(cat "$calls_file")"
    fi
    calls=$((calls + 1))
    printf '%s\n' "$calls" > "$calls_file"
    if [[ "$calls" -lt 4 ]]; then
      echo "Test Suite 'Selected tests' passed"
      echo "Executed 0 tests, with 0 failures"
      exit 0
    fi
    echo "Test Case '-[XCTestRunnerTests.RemindersLaunchPlanTests testLaunchRemindersPlan]' passed (1.0 seconds)."
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
  export SWIFT_STUB_CALLS_FILE="$TEST_DIR/swift-calls.txt"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "runs the RemindersLaunchPlanTests filter" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan" ]
}

@test "falls back to the class filter when SwiftPM reports zero filtered XCTest cases" {
  run env SWIFT_STUB_MODE=zero_then_pass bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan" ]
  [ "$(sed -n '2p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests" ]
  [[ "$output" == *"retrying with class filter"* ]]
}

@test "falls back to the broad method filter when qualified filters report zero XCTest cases" {
  run env SWIFT_STUB_MODE=zero_twice_then_pass bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan" ]
  [ "$(sed -n '2p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests" ]
  [ "$(sed -n '3p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter testLaunchRemindersPlan" ]
  [[ "$output" == *"retrying with broad method filter"* ]]
}

@test "falls back to an unfiltered launch-only run when all filters report zero XCTest cases" {
  run env SWIFT_STUB_MODE=zero_three_times_then_pass bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan" ]
  [ "$(sed -n '2p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests" ]
  [ "$(sed -n '3p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter testLaunchRemindersPlan" ]
  [ "$(sed -n '4p' "$SWIFT_STUB_ARGS_FILE")" = "test" ]
  [[ "$output" == *"retrying unfiltered launch-only run"* ]]
}

@test "fails when SwiftPM filters and unfiltered fallback report zero XCTest cases" {
  run env SWIFT_STUB_MODE=zero bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"without executing testLaunchRemindersPlan"* ]]
  [ "$(sed -n '1p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan" ]
  [ "$(sed -n '2p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter XCTestRunnerTests.RemindersLaunchPlanTests" ]
  [ "$(sed -n '3p' "$SWIFT_STUB_ARGS_FILE")" = "test --filter testLaunchRemindersPlan" ]
  [ "$(sed -n '4p' "$SWIFT_STUB_ARGS_FILE")" = "test" ]
}

@test "preserves a real Reminders test failure status" {
  run env SWIFT_STUB_MODE=fail bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"testLaunchRemindersPlan]' failed"* ]]
  [[ "$output" != *"without executing testLaunchRemindersPlan"* ]]
  [ "$(wc -l < "$SWIFT_STUB_ARGS_FILE" | tr -d ' ')" = "1" ]
}
