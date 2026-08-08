#!/usr/bin/env bats
#
# Pins the fail-fast contract of scripts/validate-loop.sh (issue #5149): tests run
# only when the gate passes, and never when it fails. The gate and test commands
# are injected via env seams so the contract is exercised without running real
# turbo/tests.

SCRIPT="scripts/validate-loop.sh"

@test "runs tests when the gate passes" {
  run env VALIDATE_LOOP_GATE_CMD=true VALIDATE_LOOP_TEST_CMD="echo TESTS_RAN" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"TESTS_RAN"* ]]
}

@test "skips tests and exits non-zero when the gate fails" {
  run env VALIDATE_LOOP_GATE_CMD=false VALIDATE_LOOP_TEST_CMD="echo TESTS_RAN" bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" != *"TESTS_RAN"* ]]
  [[ "$output" == *"gate failed"* ]]
}

@test "forwards the gate's failure without running tests" {
  run env VALIDATE_LOOP_GATE_CMD="sh -c 'echo GATE_OUTPUT; exit 1'" VALIDATE_LOOP_TEST_CMD="echo TESTS_RAN" bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"GATE_OUTPUT"* ]]
  [[ "$output" != *"TESTS_RAN"* ]]
}
