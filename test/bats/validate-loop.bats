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

@test "forwards the gate's child output and skips tests on failure" {
  local dir
  dir="$(mktemp -d)"
  # A failing gate fixture whose output marker (CHILD_MARKER) is absent from its
  # invocation, so the assertion passes only if the child actually ran and its
  # output was forwarded — not because the script echoed the command line.
  printf '#!/usr/bin/env bash\necho CHILD_MARKER\nexit 1\n' > "$dir/gate.sh"
  chmod +x "$dir/gate.sh"
  run env VALIDATE_LOOP_GATE_CMD="bash $dir/gate.sh" VALIDATE_LOOP_TEST_CMD="echo TESTS_RAN" bash "$SCRIPT"
  rm -rf "$dir"
  [ "$status" -ne 0 ]
  [[ "$output" == *"CHILD_MARKER"* ]]
  [[ "$output" != *"TESTS_RAN"* ]]
}
