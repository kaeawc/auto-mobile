#!/usr/bin/env bats
#
# Tests for scripts/ci/merge-ts-coverage-parts.sh: On Merge runs the coverage
# lane as separate part jobs (#16377) and joins their artifacts for the badge
# and the 100ms timing gate.

SCRIPT="scripts/ci/merge-ts-coverage-parts.sh"

# Writes one downloaded part artifact: lcov.info, junit.xml and the chunk
# reports and calibration probes of shards $2.. under shards/.
make_part() {
  local part="$1" shard
  shift
  mkdir -p "$PARTS/$part/shards"
  printf 'TN:\nSF:src/shared.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\nTN:\nSF:src/%s.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n' "$part" > "$PARTS/$part/lcov.info"
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="0" time="0.001"><testsuite name="%s" tests="1" failures="0" time="0.001"><testcase name="case" classname="%s" time="0.001" /></testsuite></testsuites>\n' "$part" "$part" > "$PARTS/$part/junit.xml"
  for shard in "$@"; do
    printf '<testsuites />\n' > "$PARTS/$part/shards/shard-${shard}-chunk-1.xml"
    printf 'unit shard %s attempt 1\t10\t25\n' "$shard" > "$PARTS/$part/shards/calibration-unit-shard-${shard}.tsv"
  done
}

setup() {
  PARTS="$BATS_TEST_TMPDIR/parts"
  OUT="$BATS_TEST_TMPDIR/coverage"
}

@test "joins every part's LCOV, JUnit, chunk reports and calibration probes" {
  make_part ts-coverage-part-1 1 2
  make_part ts-coverage-part-2 3 4
  run bash "$SCRIPT" 2 "$PARTS" "$OUT"
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
  [ "$(grep -c '^SF:src/shared.ts$' "$OUT/lcov.info")" -eq 1 ]
  grep -q '^DA:1,2$' "$OUT/lcov.info"
  grep -q '^SF:src/ts-coverage-part-1.ts$' "$OUT/lcov.info"
  grep -q '^SF:src/ts-coverage-part-2.ts$' "$OUT/lcov.info"
  grep -q 'tests="2"' "$OUT/junit.xml"
  for shard in 1 2 3 4; do
    [ -f "$OUT/shards/shard-${shard}-chunk-1.xml" ]
    [ -f "$OUT/shards/calibration-unit-shard-${shard}.tsv" ]
  done
}

@test "a missing part fails instead of publishing a partial badge" {
  make_part ts-coverage-part-1 1 2
  run bash "$SCRIPT" 2 "$PARTS" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Expected 2 coverage parts"*"found 1"* ]]
  [ ! -f "$OUT/lcov.info" ]
}

@test "a part without LCOV or chunk reports fails" {
  make_part ts-coverage-part-1 1 2
  make_part ts-coverage-part-2 3 4
  rm "$PARTS/ts-coverage-part-2/lcov.info"
  run bash "$SCRIPT" 2 "$PARTS" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Coverage part ts-coverage-part-2 has no lcov.info"* ]]

  make_part ts-coverage-part-2 3 4
  rm "$PARTS"/ts-coverage-part-2/shards/*.xml
  rm -rf "$OUT"
  run bash "$SCRIPT" 2 "$PARTS" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Coverage part ts-coverage-part-2 has no chunk JUnit reports"* ]]
}

@test "parts that reuse shard numbers fail rather than overwrite each other's reports" {
  make_part ts-coverage-part-1 1 2
  make_part ts-coverage-part-2 1 2
  run bash "$SCRIPT" 2 "$PARTS" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Coverage part ts-coverage-part-2 repeats"* ]]
  [ ! -f "$OUT/lcov.info" ]
}

@test "usage errors exit 2" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" 0 "$PARTS"
  [ "$status" -eq 2 ]
}
