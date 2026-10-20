#!/usr/bin/env bats
# bats file_tags=parallel-within-file
load test-ts-process-helpers
setup() { setup_test_ts_stubs; }
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
