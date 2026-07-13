#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/reminders-launch-plan-tests.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

cd "$REPO_ROOT/ios/XCTestRunner"

set +e
swift test --filter XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan 2>&1 | tee "$LOG_FILE"
swift_status="${PIPESTATUS[0]}"
set -e

if ! grep -Eq "Test Case '-\\[XCTestRunnerTests\\.RemindersLaunchPlanTests testLaunchRemindersPlan\\]' (passed|failed)" "$LOG_FILE"; then
  echo "::error::RemindersLaunchPlanTests filter completed without executing testLaunchRemindersPlan"
  exit 1
fi

exit "$swift_status"
