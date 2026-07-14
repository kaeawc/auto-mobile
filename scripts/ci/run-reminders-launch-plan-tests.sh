#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/reminders-launch-plan-tests.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

cd "$REPO_ROOT/ios/XCTestRunner"

TEST_CASE_PATTERN="Test Case '-\\[XCTestRunnerTests\\.RemindersLaunchPlanTests testLaunchRemindersPlan\\]' (passed|failed)"

run_swift_filter() {
  local test_filter="$1"
  : > "$LOG_FILE"
  swift test --filter "$test_filter" 2>&1 | tee "$LOG_FILE"
  local swift_status="${PIPESTATUS[0]}"
  return "$swift_status"
}

run_swift_unfiltered_launch_only() {
  : > "$LOG_FILE"
  AUTOMOBILE_REMINDERS_LAUNCH_ONLY=1 swift test 2>&1 | tee "$LOG_FILE"
  local swift_status="${PIPESTATUS[0]}"
  return "$swift_status"
}

set +e
run_swift_filter "XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan"
swift_status="$?"
set -e

if [[ "$swift_status" -eq 0 ]] && ! grep -Eq "$TEST_CASE_PATTERN" "$LOG_FILE"; then
  echo "RemindersLaunchPlanTests method filter executed zero XCTest cases; retrying with class filter."
  set +e
  run_swift_filter "XCTestRunnerTests.RemindersLaunchPlanTests"
  swift_status="$?"
  set -e
fi

if [[ "$swift_status" -eq 0 ]] && ! grep -Eq "$TEST_CASE_PATTERN" "$LOG_FILE"; then
  echo "RemindersLaunchPlanTests class filter executed zero XCTest cases; retrying with broad method filter."
  set +e
  run_swift_filter "testLaunchRemindersPlan"
  swift_status="$?"
  set -e
fi

if [[ "$swift_status" -eq 0 ]] && ! grep -Eq "$TEST_CASE_PATTERN" "$LOG_FILE"; then
  echo "RemindersLaunchPlanTests broad method filter executed zero XCTest cases; retrying unfiltered launch-only run."
  set +e
  run_swift_unfiltered_launch_only
  swift_status="$?"
  set -e
fi

if ! grep -Eq "$TEST_CASE_PATTERN" "$LOG_FILE"; then
  echo "::error::RemindersLaunchPlanTests filter completed without executing testLaunchRemindersPlan"
  exit 1
fi

exit "$swift_status"
