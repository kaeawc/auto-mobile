#!/usr/bin/env bats
#
# Pins the fail-fast contract of scripts/validate-loop.sh (issue #5149): tests run
# only when the gate passes, and never when it fails. The gate and test commands
# are injected via env seams so the contract is exercised without running real
# turbo/tests.

SCRIPT="scripts/validate-loop.sh"

# A test-command fixture whose marker (TEST_CHILD_MARKER) is absent from its
# invocation, so an assertion on the marker proves the child actually ran rather
# than matching the command line the script echoes.
_test_fixture() {
  local dir
  dir="$(mktemp -d)"
  printf '#!/usr/bin/env bash\necho TEST_CHILD_MARKER\n' > "$dir/t.sh"
  chmod +x "$dir/t.sh"
  echo "$dir"
}

@test "runs the test command when the gate passes" {
  local dir
  dir="$(_test_fixture)"
  run env VALIDATE_LOOP_GATE_CMD=true VALIDATE_LOOP_TEST_CMD="bash $dir/t.sh" bash "$SCRIPT"
  rm -rf "$dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *"TEST_CHILD_MARKER"* ]]
}

@test "skips the test command and exits non-zero when the gate fails" {
  local dir
  dir="$(_test_fixture)"
  run env VALIDATE_LOOP_GATE_CMD=false VALIDATE_LOOP_TEST_CMD="bash $dir/t.sh" bash "$SCRIPT"
  rm -rf "$dir"
  [ "$status" -ne 0 ]
  [[ "$output" != *"TEST_CHILD_MARKER"* ]]
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
