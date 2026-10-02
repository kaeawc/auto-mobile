#!/usr/bin/env bats
# Fixtures captured verbatim on 2026-10-02 with Bun 1.3.14 (0d9b296a):
# AUTOMOBILE_LOG_DIR="$PWD/scratch/lane-logs" AUTOMOBILE_DATA_DIR="$PWD/scratch/lane-data"
#   bun test ./scratch/bun-failure-{assertion,timeout}.repro.ts > fixture.log 2>&1
# Each path was run separately, with the above environment exported. Repros removed.

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ci/summarize-bun-failures.sh"
FIXTURES="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/fixtures"

@test "timeout includes failure and its reason" {
  run bash "$SCRIPT" "$FIXTURES/bun-failure-timeout.log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"(fail) captured timeout failure"* ]]
  [[ "$output" == *"this test timed out after 100ms."* ]]
  [[ "$output" == *"Ran 1 test across 1 file."* ]]
}

@test "assertion includes error, values, and a file:line stack frame" {
  run bash "$SCRIPT" "$FIXTURES/bun-failure-assertion.log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"error: expect(received).toBe(expected)"* ]]
  [[ "$output" == *"Expected: 2"* ]]
  [[ "$output" == *"Received: 1"* ]]
  [[ "$output" == *"at <anonymous> ("*"bun-failure-assertion.repro.ts:4:13)"* ]]
  [[ "$output" == *"(fail) captured assertion failure"* ]]
}

@test "mixed captured output has at most twelve lines per failure" {
  # Mixed fixture is concatenation of the two verbatim captured runs.
  cat "$FIXTURES/bun-failure-assertion.log" "$FIXTURES/bun-failure-timeout.log" > "$BATS_TEST_TMPDIR/mixed.log"
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/mixed.log"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -le 25 ]
  [[ "$output" == *"Expected: 2"*"(fail) captured assertion failure"*"(fail) captured timeout failure"*"this test timed out after 100ms."* ]]
}

@test "long captured diagnostic context is bounded and retains first frame" {
  # Repeat captured Expected/Received lines, preserving Bun formatting.
  awk '/^Expected:/ { for (i = 0; i < 40; i++) print } { print }' \
    "$FIXTURES/bun-failure-assertion.log" > "$BATS_TEST_TMPDIR/long.log"
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/long.log"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -le 13 ]
  [[ "$output" == *"at <anonymous> ("*"bun-failure-assertion.repro.ts:4:13)"* ]]
  [[ "$output" == *"(fail) captured assertion failure"* ]]
}

@test "mass failures cap content at 200 lines with an exact truncation count" {
  # Repeat captured runs; no Bun diagnostic text is hand-written.
  for ((i = 0; i < 100; i++)); do
    cat "$FIXTURES/bun-failure-assertion.log"
  done > "$BATS_TEST_TMPDIR/mass.log"
  run bash "$SCRIPT" "$FIXTURES/bun-failure-assertion.log"
  per_run=$(printf '%s\n' "$output" | wc -l)
  expected_truncated=$((100 * per_run - 200))
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/mass.log"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 201 ]
  [[ "$output" == *"... $expected_truncated more lines truncated"* ]]
  [[ "$(printf '%s\n' "$output" | tail -n 1)" == "Ran 1 test across 1 file."* ]]
}

@test "passing-only stdin keeps only the Ran summary" {
  printf '(pass) example [0.01ms]\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]\n' > "$BATS_TEST_TMPDIR/pass.log"
  run bash -c 'bash "$1" < "$2"' _ "$SCRIPT" "$BATS_TEST_TMPDIR/pass.log"
  [ "$status" -eq 0 ]
  [ "$output" = 'Ran 1 test across 1 file. [1.00ms]' ]
}

@test "empty stdin succeeds without output" {
  run bash -c 'bash "$1" < /dev/null' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
