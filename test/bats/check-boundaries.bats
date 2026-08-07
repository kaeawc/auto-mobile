#!/usr/bin/env bats
#
# Pins the aggregation of scripts/check-boundaries.sh (issue #5121): it runs the
# checks concurrently, exits 0 iff all pass, and on failure reports EVERY failing
# check (not just the first). The real scanners are replaced via
# CHECK_BOUNDARIES_CMD_OVERRIDE so the test is fast and deterministic.

SCRIPT="scripts/check-boundaries.sh"

@test "exits 0 and reports the count when every check passes" {
  run env CHECK_BOUNDARIES_CMD_OVERRIDE=$'true\ntrue\ntrue' bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"all 3 passed"* ]]
}

@test "exits non-zero and names a failing check" {
  run env CHECK_BOUNDARIES_CMD_OVERRIDE=$'true\nfalse\ntrue' bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL: false"* ]]
}

@test "reports every failing check, not just the first" {
  run env CHECK_BOUNDARIES_CMD_OVERRIDE=$'sh -c "echo boomA; exit 1"\ntrue\nsh -c "echo boomB; exit 1"' bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"boomA"* ]]
  [[ "$output" == *"boomB"* ]]
}
