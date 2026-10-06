#!/usr/bin/env bats
#
# Chunked coverage lane (#10213): a few shard processes, each running its files
# in sequential `bun test --coverage` processes of at most N files so no process
# grows large or old. The first attempt (four whole-shard processes) exhausted a
# 16.8 GB runner and ran every shard past its budget.

SCRIPT="scripts/test-ts.sh"

# Prints 'test/fixtureNNN.test.ts' for NNN in [0, $1) in the order find|sort gives.
stub_find() {
  cat > "$STUB_BIN/find" <<EOF
#!/usr/bin/env bash
for ((i = 0; i < ${1}; i += 1)); do printf 'test/fixture%03d.test.ts\n' "\$i"; done
EOF
  chmod +x "$STUB_BIN/find"
}

setup() {
  STUB_BIN="$(mktemp -d)"
  REAL_BUN="$(command -v bun)"
  export REAL_BUN
  # Fake `bun test`: one call is one chunk. It checks the chunk's own bunfig,
  # records its file list and start/end events, and writes per-chunk lcov/JUnit
  # (one shared source plus one source per test file it was given).
  cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "scripts/lib/merge-lcov.ts" || "$1" == "scripts/lib/merge-junit-reports.ts" || "$1" == "scripts/lib/write-coverage-bunfig.ts" || "$1" == */test-file-timings.ts ]]; then
  exec "$REAL_BUN" "$@"
fi
coverage_config=""
report=""
files=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --config=*) coverage_config="${1#*=}" ;;
    --reporter-outfile) report="$2"; shift ;;
    test/*.test.ts) files+=("$1") ;;
  esac
  shift
done
[[ -n "$coverage_config" && -n "$report" ]] || exit 70
id="${coverage_config##*/}"
id="${id%.toml}"            # shard-S-chunk-C
coverage_dir="${coverage_config%.toml}"
grep -q "coverageDir = \"${coverage_dir}\"" "$coverage_config" || exit 71
key="${id#shard-}"          # S-chunk-C
number="${key%%-*}"
chunk="${key##*-}"
shards_dir="${coverage_dir%/*}"
printf 'start %s\n' "$number" >> "$shards_dir/events"
printf '%s\n' "${files[@]}" > "$shards_dir/files-${number}-${chunk}"
printf '%s\n' "${AUTOMOBILE_TEST_TIMING_LOG:-}" > "$shards_dir/timing-env-${number}"
sleep 0.05
echo "log from shard $number chunk $chunk"
if [[ "${STUB_WRITE_FAILED_CHUNK:-}" == "$number-$chunk" ]]; then
  echo 'error: An internal error occurred (WriteFailed)'
  echo '0 fail'
elif [[ "${STUB_REAL_FAIL_CHUNK:-}" == "$number-$chunk" || "${STUB_FAIL_CHUNK:-}" == "$number-$chunk" ]]; then
  echo "1 fail in shard $number chunk $chunk"
else
  echo '0 fail'
fi
mkdir -p "$coverage_dir"
{
  cat <<LCOV
TN:
SF:src/shared.ts
FN:1,shared
FNDA:1,shared
FNF:2
FNH:1
BRDA:1,0,0,1
BRF:1
BRH:1
DA:1,1
LF:1
LH:1
end_of_record
TN:
SF:src/only-${number}-${chunk}.ts
DA:1,1
LF:1
LH:1
end_of_record
LCOV
  for file in "${files[@]}"; do
    printf 'TN:\nSF:src/%s.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n' "$(basename "$file" .test.ts)"
  done
} > "$coverage_dir/lcov.info"
cat > "$report" <<JUNIT
<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="1" failures="0" time="0.001"><testsuite name="${id}" tests="1" failures="0" time="0.001"><testcase name="case" classname="${id}" file="test/${id}.test.ts" time="0.001" /></testsuite></testsuites>
JUNIT
if [[ "${STUB_REMOVE_LOG_CHUNK:-}" == "$number-$chunk" ]]; then rm -f "${coverage_dir}.log"; fi
printf 'end %s\n' "$number" >> "$shards_dir/events"
if [[ "${STUB_FAIL_CHUNK:-}" == "$number-$chunk" || "${STUB_WRITE_FAILED_CHUNK:-}" == "$number-$chunk" || "${STUB_REAL_FAIL_CHUNK:-}" == "$number-$chunk" ]]; then exit 7; fi
EOF
  chmod +x "$STUB_BIN/bun"
}

teardown() {
  rm -rf "$STUB_BIN" coverage
}

run_coverage() {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 "$@" bash "$SCRIPT" coverage
}

@test "coverage defaults to two shards of 50-file chunks and merges overlapping LCOV and JUnit" {
  stub_find 230
  run_coverage
  [ "$status" -eq 0 ]
  # 115 files per shard -> chunks of 50, 50, 15.
  for number in 1 2; do
    [ "$(cat "coverage/shards/shard-${number}.chunks")" -eq 3 ]
    [ "$(wc -l < "coverage/shards/files-${number}-1" | tr -d ' ')" -eq 50 ]
    [ "$(wc -l < "coverage/shards/files-${number}-2" | tr -d ' ')" -eq 50 ]
    [ "$(wc -l < "coverage/shards/files-${number}-3" | tr -d ' ')" -eq 15 ]
    [ -f "coverage/shards/shard-${number}.log" ]
  done
  [ ! -f coverage/shards/shard-3.chunks ]
  [[ "$output" == *"coverage shard 1 chunk 1/3: 50 files"*"coverage shard 1 chunk 3/3: 15 files"* ]]
  # Shared source merged once, with counts summed over all six chunk reports.
  [ "$(grep -c '^SF:src/shared.ts$' coverage/lcov.info)" -eq 1 ]
  grep -q '^FNDA:6,shared$' coverage/lcov.info
  grep -q '^FNF:2$' coverage/lcov.info
  grep -q '^BRDA:1,0,0,6$' coverage/lcov.info
  grep -q '^DA:1,6$' coverage/lcov.info
  grep -q 'tests="6"' coverage/junit.xml
  for chunk in 1 2 3; do
    grep -q "shard-1-chunk-${chunk}" coverage/junit.xml
    grep -q "shard-2-chunk-${chunk}" coverage/junit.xml
  done
}

@test "chunks of every shard partition the file list completely and disjointly" {
  stub_find 25
  run_coverage AUTOMOBILE_COVERAGE_SHARDS=3 AUTOMOBILE_COVERAGE_CHUNK_FILES=4
  [ "$status" -eq 0 ]
  cat coverage/shards/files-* | sort > "$BATS_TEST_TMPDIR/seen"
  for ((i = 0; i < 25; i += 1)); do printf 'test/fixture%03d.test.ts\n' "$i"; done | sort > "$BATS_TEST_TMPDIR/expected"
  # Complete (nothing dropped), disjoint (nothing run twice) and never over the chunk size.
  cmp "$BATS_TEST_TMPDIR/seen" "$BATS_TEST_TMPDIR/expected"
  for list in coverage/shards/files-*; do
    [ "$(wc -l < "$list" | tr -d ' ')" -le 4 ]
  done
  # 9, 8 and 8 files -> 3, 2 and 2 chunks.
  [ "$(cat coverage/shards/shard-1.chunks)" -eq 3 ]
  [ "$(cat coverage/shards/shard-2.chunks)" -eq 2 ]
  [ "$(cat coverage/shards/shard-3.chunks)" -eq 2 ]
  # Every source of every file reaches the merged LCOV exactly once.
  [ "$(grep -c '^SF:src/fixture' coverage/lcov.info)" -eq 25 ]
  [ "$(grep -c '^SF:src/only-' coverage/lcov.info)" -eq 7 ]
}

@test "chunks run sequentially within a shard and never more than the shard count at once" {
  stub_find 60
  run_coverage AUTOMOBILE_COVERAGE_SHARDS=2 AUTOMOBILE_COVERAGE_CHUNK_FILES=10
  [ "$status" -eq 0 ]
  # events holds one line per start/end in true time order (short appends are
  # atomic). Each shard has 30 files -> 3 chunks, so 6 starts and 6 ends.
  [ "$(grep -c '^start' coverage/shards/events)" -eq 6 ]
  [ "$(grep -c '^end' coverage/shards/events)" -eq 6 ]
  open1=0 open2=0 running=0 peak=0
  while read -r event number; do
    if [[ "$event" == start ]]; then
      # A shard may only start a chunk once its previous chunk ended.
      if [[ "$number" == 1 ]]; then open1=$((open1 + 1)); [ "$open1" -le 1 ]; fi
      if [[ "$number" == 2 ]]; then open2=$((open2 + 1)); [ "$open2" -le 1 ]; fi
      running=$((running + 1))
      if [[ "$running" -gt "$peak" ]]; then peak="$running"; fi
    else
      if [[ "$number" == 1 ]]; then open1=$((open1 - 1)); fi
      if [[ "$number" == 2 ]]; then open2=$((open2 - 1)); fi
      running=$((running - 1))
    fi
  done < coverage/shards/events
  [ "$peak" -le 2 ]
}

@test "every chunk of a shard appends to that shard's one timing log" {
  stub_find 20
  run_coverage AUTOMOBILE_COVERAGE_SHARDS=2 AUTOMOBILE_COVERAGE_CHUNK_FILES=5
  [ "$status" -eq 0 ]
  for number in 1 2; do
    [ "$(cat "coverage/shards/timing-env-${number}")" = "coverage/shards/timing-shard-${number}.ndjson" ]
  done
}

@test "coverage chunks request the probe and flags for each chunk's own report" {
  stub_find 4
  cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "scripts/lib/write-coverage-bunfig.ts" ]]; then exec "$REAL_BUN" "$@"; fi
printf '%s\n' "$@" > "coverage/shards/args-${AUTOMOBILE_TEST_TIMING_LOG##*-}"
echo '0 fail'
for arg in "$@"; do
  if [[ "$arg" == *.xml ]]; then
    dir="${arg%.xml}"; mkdir -p "$dir"; printf 'TN:\nSF:src/a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n' > "$dir/lcov.info"
    printf '<testsuites tests="1"><testsuite name="s" tests="1"><testcase name="c" classname="s" file="f" time="0"/></testsuite></testsuites>\n' > "$arg"
  fi
done
EOF
  chmod +x "$STUB_BIN/bun"
  run_coverage AUTOMOBILE_COVERAGE_SHARDS=2
  [ "$status" -eq 0 ]
  args=coverage/shards/args-2.ndjson
  grep -qx -- '--coverage' "$args"
  grep -qx -- '--coverage-reporter=lcov' "$args"
  grep -qx -- '--config=coverage/shards/shard-2-chunk-1.toml' "$args"
  grep -qx -- 'coverage/shards/shard-2-chunk-1.xml' "$args"
  grep -qx -- 'test/fixture001.test.ts' "$args"
  grep -qx -- 'test/fixture003.test.ts' "$args"
  grep -q -- 'test/setup/fileTimingProbe.ts' "$args"
}

@test "coverage shard count is configurable and invalid values fail before Bun" {
  stub_find 12
  run_coverage AUTOMOBILE_COVERAGE_SHARDS=3 AUTOMOBILE_COVERAGE_CHUNK_FILES=100
  [ "$status" -eq 0 ]
  [ -f coverage/shards/shard-3.chunks ]
  [ ! -f coverage/shards/shard-4.chunks ]
  [ "$(grep -c '^SF:src/only-' coverage/lcov.info)" -eq 3 ]

  run_coverage AUTOMOBILE_COVERAGE_SHARDS=1 AUTOMOBILE_COVERAGE_CHUNK_FILES=100
  [ "$status" -eq 0 ]
  cmp coverage/shards/shard-1-chunk-1/lcov.info coverage/lcov.info
  cmp coverage/shards/shard-1-chunk-1.xml coverage/junit.xml

  # More shards than files: no empty shard processes.
  run_coverage AUTOMOBILE_COVERAGE_SHARDS=50
  [ "$status" -eq 0 ]
  [ -f coverage/shards/shard-12.chunks ]
  [ ! -f coverage/shards/shard-13.chunks ]

  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_COVERAGE_SHARDS=0 bash "$SCRIPT" coverage
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_COVERAGE_SHARDS must be a positive integer"* ]]
}

@test "a failing chunk fails its shard and the step, names itself, and keeps merged artifacts out" {
  stub_find 30
  run_coverage AUTOMOBILE_COVERAGE_SHARDS=2 AUTOMOBILE_COVERAGE_CHUNK_FILES=5 STUB_FAIL_CHUNK=1-2
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL: coverage shard 1 chunk 2/3 exited with status 7"* ]]
  [[ "$output" == *"coverage shard 1/2 exited with status 7"* ]]
  [[ "$output" != *"coverage shard 2/2 exited"* ]]
  # The failing chunk's own output is in the log, and later chunks still ran.
  [[ "$output" == *"1 fail in shard 1 chunk 2"* ]]
  [ -f coverage/shards/files-1-3 ]
  [ ! -f coverage/lcov.info ]
  [ ! -f coverage/junit.xml ]
}

@test "a timed-out shard retains the 720 second guard and names its index" {
  stub_find 12
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
exit 124
EOF
  chmod +x "$STUB_BIN/timeout"
  run env PATH="$STUB_BIN:$PATH" bash "$SCRIPT" coverage
  [ "$status" -eq 124 ]
  [[ "$output" == *"Coverage test run exceeded its 720s wall-clock budget (shard 1/2)"* ]]
  [[ "$output" == *"Coverage test run exceeded its 720s wall-clock budget (shard 2/2)"* ]]
  [ ! -f coverage/lcov.info ]
}

@test "the shard budget interrupts a running chunk, names it and prints its log tail" {
  stub_find 12
  cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "scripts/lib/write-coverage-bunfig.ts" || "$1" == */test-file-timings.ts ]]; then exec "$REAL_BUN" "$@"; fi
echo "chunk started and is stuck"
exec sleep 30
EOF
  chmod +x "$STUB_BIN/bun"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_COVERAGE_SHARDS=1 AUTOMOBILE_COVERAGE_CHUNK_FILES=5 \
    AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=1 bash "$SCRIPT" coverage
  [ "$status" -eq 124 ]
  [[ "$output" == *"INTERRUPTED: coverage shard 1 chunk 1/3 was running"* ]]
  [[ "$output" == *"chunk started and is stuck"* ]]
}

@test "WriteFailed after zero failures recovers and merges every chunk's coverage" {
  stub_find 30
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_CHUNK=2-2 AUTOMOBILE_COVERAGE_CHUNK_FILES=5 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash scripts/ci/run-ts-coverage.sh "$BATS_TEST_TMPDIR/out.log"
  [ "$status" -eq 0 ]
  [ -f coverage/lcov.info ]
  [ -f coverage/junit.xml ]
  [ "$(grep -c '^SF:src/shared.ts$' coverage/lcov.info)" -eq 1 ]
  grep -q '^FNDA:6,shared$' coverage/lcov.info
  [ "$(grep -c '^SF:src/fixture' coverage/lcov.info)" -eq 30 ]
  grep -q 'tests="6"' coverage/junit.xml
}

@test "WriteFailed on one chunk does not tolerate another chunk's real failure" {
  stub_find 30
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_CHUNK=2-2 STUB_REAL_FAIL_CHUNK=1-1 \
    AUTOMOBILE_COVERAGE_CHUNK_FILES=5 AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 \
    bash scripts/ci/run-ts-coverage.sh "$BATS_TEST_TMPDIR/out.log"
  [ "$status" -ne 0 ]
  [ ! -f coverage/lcov.info ]
}

@test "WriteFailed recovery refuses a run that is missing a planned chunk's log" {
  stub_find 30
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_CHUNK=2-1 STUB_REMOVE_LOG_CHUNK=1-3 \
    AUTOMOBILE_COVERAGE_CHUNK_FILES=5 AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 \
    bash scripts/ci/run-ts-coverage.sh "$BATS_TEST_TMPDIR/out.log"
  [ "$status" -ne 0 ]
  [ ! -f coverage/lcov.info ]
}
