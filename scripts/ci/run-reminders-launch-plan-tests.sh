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
  set +e
  swift test --filter "$test_filter" 2>&1 | tee "$LOG_FILE"
  local swift_status="${PIPESTATUS[0]}"
  set -e
  return "$swift_status"
}

if run_swift_filter "XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan"; then
  swift_status=0
else
  swift_status="$?"
fi

if [[ "$swift_status" -eq 0 ]] && ! grep -Eq "$TEST_CASE_PATTERN" "$LOG_FILE"; then
  echo "RemindersLaunchPlanTests method filter executed zero XCTest cases; retrying with class filter."
  if run_swift_filter "RemindersLaunchPlanTests"; then
    swift_status=0
  else
    swift_status="$?"
  fi
fi

if ! grep -Eq "$TEST_CASE_PATTERN" "$LOG_FILE"; then
  echo "::error::RemindersLaunchPlanTests filter completed without executing testLaunchRemindersPlan"
  exit 1
fi

exit "$swift_status"
