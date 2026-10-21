#!/usr/bin/env bats
# bats file_tags=parallel-within-file
load test-ts-process-helpers
setup() {
  REAL_BUN="$(command -v bun)"
  setup_test_ts_stubs
}
teardown() { teardown_test_ts_stubs; }

@test "changed selection runs once and every file runs once in bounded processes" {
  export STUB_SELECTED_COUNT=75 AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE=7
  # Shared files also obey the process bound.
  for ((i=0; i<19; i+=1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done > "$AUTOMOBILE_UNIT_SHARED_ALLOWLIST"
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$STUB_CALLS.selection")" -eq 1 ]
  [ "$(cat "$STUB_CALLS.selection")" = origin/main ]
  ! grep -q -- '--changed=\|--shard=' "$STUB_CALLS"
  awk '{ n=0; for(i=1;i<=NF;i++) if($i ~ /\.test\.ts$/) {n++; print $i > files} print n; if(n<1 || n>7) exit 1 }' \
    files="$BATS_TEST_TMPDIR/actual" "$STUB_CALLS" > "$BATS_TEST_TMPDIR/counts"
  for ((i=0; i<75; i+=1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done > "$BATS_TEST_TMPDIR/expected"
  sort "$BATS_TEST_TMPDIR/actual" > "$BATS_TEST_TMPDIR/sorted"
  cmp "$BATS_TEST_TMPDIR/expected" "$BATS_TEST_TMPDIR/sorted"
  printf 'Observed changed process file counts: %s\n' "$(tr '\n' ' ' < "$BATS_TEST_TMPDIR/counts")" >&3
}

@test "empty changed selection succeeds without bun test or slots" {
  export STUB_SELECTED_COUNT=0
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 0 ]
  [[ "$output" == *'No changed unit tests'* ]]
  [ ! -f "$STUB_CALLS" ]
  [ ! -d "$AUTOMOBILE_COORDINATION_DIR/test-slots" ]
}

@test "changed selection failures fail closed before starting tests" {
  export STUB_SELECTION_STATUS=5
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 5 ]
  [ ! -f "$STUB_CALLS" ]
}

@test "default changed chunk size stays 30 even with the nightly unit chunk knob" {
  export STUB_SELECTED_COUNT=125 AUTOMOBILE_UNIT_TEST_CHUNK_FILES=1000
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 0 ]
  awk '{n=0; for(i=1;i<=NF;i++) if($i ~ /\.test\.ts$/) n++; print n; if(n<1 || n>30) exit 1}' \
    "$STUB_CALLS" > "$BATS_TEST_TMPDIR/counts"
  [ "$(awk '{n+=$1} END {print n}' "$BATS_TEST_TMPDIR/counts")" -eq 125 ]
  [ "$(wc -l < "$STUB_CALLS")" -eq 6 ]
  printf 'Observed default changed process file counts: %s\n' "$(tr '\n' ' ' < "$BATS_TEST_TMPDIR/counts")" >&3
}

@test "zero changed chunk size uses 30 for isolated and shared groups" {
  export STUB_SELECTED_COUNT=125 AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE=0
  local shared_count i
  for shared_count in 0 125; do
    : > "$AUTOMOBILE_UNIT_SHARED_ALLOWLIST"
    for ((i=0; i<shared_count; i+=1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done > "$AUTOMOBILE_UNIT_SHARED_ALLOWLIST"
    rm -f "$STUB_CALLS"
    run bash scripts/test-ts.sh changed
    [ "$status" -eq 0 ]
    awk '{n=0; for(i=1;i<=NF;i++) if($i ~ /\.test\.ts$/) n++; print n; if(n<1 || n>30) exit 1}' \
      "$STUB_CALLS" > "$BATS_TEST_TMPDIR/counts"
    [ "$(awk '{n+=$1} END {print n}' "$BATS_TEST_TMPDIR/counts")" -eq 125 ]
    [ "$(wc -l < "$STUB_CALLS")" -eq 6 ]
    printf 'Observed zero changed chunk size (%s shared) process file counts: %s\n' \
      "$shared_count" "$(tr '\n' ' ' < "$BATS_TEST_TMPDIR/counts")" >&3
  done
}

@test "changed calibration CLI slowdowns match zero-based chunk report keys" {
  export AUTOMOBILE_RUNNER_CALIBRATION=1 STUB_SELECTED_COUNT=125
  export AUTOMOBILE_UNIT_JUNIT_DIR="$BATS_TEST_TMPDIR/reports"
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 0 ]
  grep -q 'shard-0-iso-1.xml' "$STUB_CALLS"
  grep -q 'shard-1-iso-1.xml' "$STUB_CALLS"
  run "$REAL_BUN" scripts/lib/runner-calibration.ts shard-slowdowns "$AUTOMOBILE_UNIT_JUNIT_DIR"
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'shard-0\t3.00\nshard-1\t3.00')" ]
  printf 'Observed changed shard slowdowns:\n%s\n' "$output" >&3
}

@test "changed selection has a separate configurable timeout" {
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_CALLS.selection-timeout")" -eq 120 ]
  export AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS=7
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_CALLS.selection-timeout")" -eq 7 ]
  [ "$(sort -u "$STUB_CALLS.test-timeout")" = 600 ]
}

@test "changed selection timeout fails closed before tests or slots" {
  export AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS=1 STUB_SELECTION_HOLD=1
  run bash scripts/test-ts.sh changed
  [ "$status" -eq 124 ]
  [ ! -f "$STUB_CALLS" ]
  [ ! -d "$AUTOMOBILE_COORDINATION_DIR/test-slots" ]
}

@test "changed selection rejects invalid timeouts before invoking the selector" {
  local value
  for value in 0 -1 01 1.5 invalid; do
    run env AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS="$value" bash scripts/test-ts.sh changed
    [ "$status" -eq 2 ]
    [[ "$output" == *'AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS must be a positive integer'* ]]
    [ ! -f "$STUB_CALLS.selection" ]
  done
}
