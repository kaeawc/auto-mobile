#!/usr/bin/env bats
#
# Tests for scripts/ci/stress-db-lifecycle-tests.sh (issue #2992).
#
# The script prepends "${HOME}/.bun/bin" to PATH, so setup points HOME at an
# empty temp dir (no real bun on that path) and puts a fake `bun` earlier on
# PATH — letting these tests drive the iteration/validation logic without
# actually running the suites.

SCRIPT="scripts/ci/stress-db-lifecycle-tests.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  BIN_DIR="${TEST_ROOT}/bin"
  mkdir -p "$BIN_DIR"
  # No ${HOME}/.bun/bin, so the script's PATH prepend is inert and our fake wins.
  export HOME="$TEST_ROOT"
  export PATH="${BIN_DIR}:${PATH}"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

write_fake_bun() {
  cat > "${BIN_DIR}/bun"
  chmod +x "${BIN_DIR}/bun"
}

@test "rejects a non-integer iteration count" {
  write_fake_bun <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT

  run bash "$SCRIPT" abc

  [ "$status" -eq 2 ]
  [[ "$output" == *"must be a positive integer"* ]]
}

@test "rejects a zero iteration count" {
  write_fake_bun <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT

  run bash "$SCRIPT" 0

  [ "$status" -eq 2 ]
}

@test "passes when every iteration succeeds" {
  write_fake_bun <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT

  run bash "$SCRIPT" 3

  [ "$status" -eq 0 ]
  [[ "$output" == *"iteration 3/3"* ]]
  [[ "$output" == *"3 iterations passed"* ]]
}

@test "fails fast on the first failing iteration" {
  # Fail on the second invocation so we prove it stops there, not at the end.
  write_fake_bun <<'SCRIPT'
#!/usr/bin/env bash
state_file="${FAKE_BUN_STATE}"
attempt="$(cat "$state_file" 2>/dev/null || echo 0)"
attempt=$((attempt + 1))
echo "$attempt" > "$state_file"
[ "$attempt" -ge 2 ] && exit 1
exit 0
SCRIPT

  run env FAKE_BUN_STATE="${TEST_ROOT}/attempts" bash "$SCRIPT" 5

  [ "$status" -eq 1 ]
  [[ "$output" == *"failed on iteration 2/5"* ]]
  [[ "$output" != *"iteration 3/5"* ]]
}
