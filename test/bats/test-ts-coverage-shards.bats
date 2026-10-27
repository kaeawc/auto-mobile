#!/usr/bin/env bats
# bats file_tags=serial
# Both coverage tests own the shared repo-relative `coverage/` directory, so
# they must not run in parallel with each other.
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
  export AUTOMOBILE_RUNNER_CALIBRATION=0
  # Stub lanes assert the full discovered file set on every OS (see test-ts.bats for the skip tests).
  export AUTOMOBILE_MACOS_ONLY_TESTS=include
  # The supervisor declines a retry on a loaded host; pin the load so retry
  # policy tests do not depend on the machine running them.
  export AUTOMOBILE_TEST_LOADAVG_FILE="$BATS_TEST_TMPDIR/loadavg"
  echo 0 > "$AUTOMOBILE_TEST_LOADAVG_FILE"
  unset AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS AUTOMOBILE_UNIT_SHARD_RETRIES AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS
  # A per-test host slot pool, so another lane on this machine cannot shrink the
  # coverage concurrency these tests observe, and the slot tests can stub it.
  export AUTOMOBILE_COORDINATION_DIR="$BATS_TEST_TMPDIR/coordination"
  unset AUTOMOBILE_HOST_TEST_SLOTS
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
# Infra-exit simulation (make_infra_timeout): coverage, like unit shards, runs
# every attempt through the portable watchdog; simulate infra exits in Bun.
# A chunk that exits 124/137 is what a killed attempt looks like to it.
if [[ "${STUB_INFRA_EXIT_ONCE:-0}" == 1 ]]; then
  count_file="$BATS_TEST_TMPDIR/attempt-shard-$number"
  count=0
  [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
  printf '%s\n' "$((count + 1))" > "$count_file"
  if [[ "$count" -eq 0 || "${ALWAYS_INFRA_EXIT:-0}" == 1 ]]; then
    # A killed attempt may leave invalid partial JUnit. It must be archived,
    # never globbed into the final coverage timing gate or merged report.
    printf 'incomplete attempt\n' > "$shards_dir/shard-${number}-chunk-99.xml"
    exit "${INFRA_EXIT:-124}"
  fi
fi
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
if [[ "${STUB_FAIL_CHUNK:-}" == "$number-$chunk" || "${STUB_WRITE_FAILED_CHUNK:-}" == "$number-$chunk" || "${STUB_REAL_FAIL_CHUNK:-}" == "$number-$chunk" ]]; then exit "${STUB_EXIT_CODE:-7}"; fi
EOF
  chmod +x "$STUB_BIN/bun"
}

teardown() {
  rm -rf "$STUB_BIN" coverage
}

run_coverage() {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 "$@" bash "$SCRIPT" coverage
  printf '%s\n' "$output"
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

# Stubs another lane in the shared slot pool: slots [0, $1) owned by this live process.
hold_pool_slots() {
  local index
  for ((index = 0; index < $1; index += 1)); do
    mkdir -p "$AUTOMOBILE_COORDINATION_DIR/test-slots/$index"
    echo "$$" > "$AUTOMOBILE_COORDINATION_DIR/test-slots/$index/owner.pid"
  done
}

# Prints the most chunks that were running at once, from the start/end events.
peak_running_chunks() {
  local event number running=0 peak=0
  while read -r event number; do
    if [[ "$event" == start ]]; then running=$((running + 1)); else running=$((running - 1)); fi
    if [[ "$running" -gt "$peak" ]]; then peak="$running"; fi
  done < coverage/shards/events
  echo "$peak"
}

# Asserts shard S of N ran exactly the round-robin files S-1, S-1+N, ... of $3 files.
assert_round_robin_shard() {
  local number="$1" shards="$2" total="$3" index
  for ((index = number - 1; index < total; index += shards)); do printf 'test/fixture%03d.test.ts\n' "$index"; done > "$BATS_TEST_TMPDIR/expected-$number"
  cat "coverage/shards/files-${number}-"* > "$BATS_TEST_TMPDIR/seen-$number"
  cmp "$BATS_TEST_TMPDIR/seen-$number" "$BATS_TEST_TMPDIR/expected-$number"
}

@test "coverage runs its fixed shards no wider than the host slots it acquired (#14448)" {
  stub_find 9
  hold_pool_slots 2
  run_coverage AUTOMOBILE_HOST_TEST_SLOTS=3 AUTOMOBILE_COVERAGE_SHARDS=3
  [ "$status" -eq 0 ]
  [[ "$output" == *'host slots demand=3 acquired=1 workers=1'* ]]
  [[ "$output" == *'coverage shards=3 running at most 1 at once'* ]]
  [ "$(peak_running_chunks)" -eq 1 ]
  # The partition is still the configured three shards, not the one slot.
  for number in 1 2 3; do assert_round_robin_shard "$number" 3 9; done
  [ "$(grep -c '^SF:src/fixture' coverage/lcov.info)" -eq 9 ]
  # The other lane's slots are left booked to it.
  [ "$(cat "$AUTOMOBILE_COORDINATION_DIR/test-slots/0/owner.pid")" = "$$" ]
  [ "$(cat "$AUTOMOBILE_COORDINATION_DIR/test-slots/1/owner.pid")" = "$$" ]
  [ ! -d "$AUTOMOBILE_COORDINATION_DIR/test-slots/2" ]
}

@test "coverage with zero acquired slots runs one shard at a time like the unit lane (#14448)" {
  stub_find 8
  hold_pool_slots 2
  run_coverage AUTOMOBILE_HOST_TEST_SLOTS=2
  [ "$status" -eq 0 ]
  [[ "$output" == *'host slots demand=2 acquired=0 workers=1'* ]]
  [[ "$output" == *'coverage shards=2 running at most 1 at once'* ]]
  [ "$(peak_running_chunks)" -eq 1 ]
  for number in 1 2; do assert_round_robin_shard "$number" 2 8; done
  [ -f coverage/lcov.info ]
}

@test "a bounded coverage retry reuses its shard's seat before the next shard starts (#14448)" {
  stub_find 8
  hold_pool_slots 2
  run_coverage AUTOMOBILE_HOST_TEST_SLOTS=2 STUB_INFRA_EXIT_ONCE=1 INFRA_EXIT=137
  [ "$status" -eq 0 ]
  [[ "$output" == *'host slots demand=2 acquired=0 workers=1'* ]]
  [ "$(grep -c 'passed on its retry' <<< "$output")" -eq 2 ]
  # A killed attempt logs a start with no end. Shard 1's retry ran in its seat
  # and finished before shard 2's first attempt began, so nothing overlapped.
  [ "$(cat coverage/shards/events)" = "$(printf 'start 1\nstart 1\nend 1\nstart 2\nstart 2\nend 2')" ]
  for number in 1 2; do assert_round_robin_shard "$number" 2 8; done
}

@test "coverage launches every shard at once when the pool covers them" {
  stub_find 8
  run_coverage AUTOMOBILE_HOST_TEST_SLOTS=2
  [ "$status" -eq 0 ]
  [[ "$output" == *'host slots demand=2 acquired=2 workers=2'* ]]
  [[ "$output" != *'running at most'* ]]
  for number in 1 2; do assert_round_robin_shard "$number" 2 8; done
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
  printf '%s\n' "$output"
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
  cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  scripts/lib/write-coverage-bunfig.ts | */test-file-timings.ts) exec "$REAL_BUN" "$@" ;;
esac
printf '%s\n' "$AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS" >> "$BATS_TEST_TMPDIR/budgets"
exit 124
EOF
  chmod +x "$STUB_BIN/bun"
  run env PATH="$STUB_BIN:$PATH" bash "$SCRIPT" coverage
  printf '%s\n' "$output"
  [ "$status" -eq 124 ]
  [ "$(sort -u "$BATS_TEST_TMPDIR/budgets")" = 720 ]
  [[ "$output" == *"Coverage test run exceeded its 720s wall-clock budget (shard 1/2)"* ]]
  [[ "$output" == *"Coverage test run exceeded its 720s wall-clock budget (shard 2/2)"* ]]
  [ ! -f coverage/lcov.info ]
}

@test "the shard budget interrupts a running chunk, names it and prints its log tail" {
  stub_find 12
  cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "scripts/lib/write-coverage-bunfig.ts" || "$1" == */test-file-timings.ts || "$1" == */runner-calibration.ts ]]; then exec "$REAL_BUN" "$@"; fi
echo "chunk started and is stuck"
exec sleep 30
EOF
  chmod +x "$STUB_BIN/bun"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_COVERAGE_SHARDS=1 AUTOMOBILE_COVERAGE_CHUNK_FILES=5 \
    AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=1 bash "$SCRIPT" coverage
  printf '%s\n' "$output"
  [ "$status" -eq 124 ]
  [[ "$output" == *"INTERRUPTED: coverage shard 1 chunk 1/3 was running"* ]]
  [[ "$output" == *"chunk started and is stuck"* ]]
}

@test "WriteFailed after zero failures recovers and merges every chunk's coverage" {
  stub_find 30
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_CHUNK=2-2 AUTOMOBILE_COVERAGE_CHUNK_FILES=5 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash scripts/ci/run-ts-coverage.sh "$BATS_TEST_TMPDIR/out.log"
  printf '%s\n' "$output"
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
  printf '%s\n' "$output"
  [ "$status" -ne 0 ]
  [ ! -f coverage/lcov.info ]
}

@test "WriteFailed recovery refuses a run that is missing a planned chunk's log" {
  stub_find 30
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_CHUNK=2-1 STUB_REMOVE_LOG_CHUNK=1-3 \
    AUTOMOBILE_COVERAGE_CHUNK_FILES=5 AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 \
    bash scripts/ci/run-ts-coverage.sh "$BATS_TEST_TMPDIR/out.log"
  printf '%s\n' "$output"
  [ "$status" -ne 0 ]
  [ ! -f coverage/lcov.info ]
}

# Fast infra simulation: the first attempt of each shard exits as an infra kill
# (see the stub bun), then the retry runs normally. No real sleeps or 720s
# watchdog is needed for retry policy.
make_infra_timeout() {
  export STUB_INFRA_EXIT_ONCE=1
}

@test "coverage retries infra exits once with fresh chunks and retains retry diagnostics" {
  stub_find 12
  make_infra_timeout
  for code in 124 137; do
    rm -f "$BATS_TEST_TMPDIR/attempt-"*
    run_coverage INFRA_EXIT="$code" AUTOMOBILE_COVERAGE_CHUNK_FILES=5
    [ "$status" -eq 0 ]
    [[ "$output" == *"retrying once with the same budget"* ]]
    [[ "$output" == *"passed on its retry"* ]]
    [ -f coverage/shards/shard-1.attempt-1.log ]
    [ -f coverage/shards/attempt-1/shard-1-chunk-99.xml ]
    [ ! -f coverage/shards/shard-1-chunk-99.xml ]
    [ -f coverage/lcov.info ]
  done
}

@test "coverage never retries assertions or infra attempts beyond the lane cap" {
  stub_find 12
  run_coverage STUB_FAIL_CHUNK=1-1
  [ "$status" -ne 0 ]
  [[ "$output" != *"RETRY:"* ]]
  make_infra_timeout
  run_coverage AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS=1
  [ "$status" -eq 124 ]
  [[ "$output" == *"would pass the 1s lane cap"* ]]
  [[ "$output" != *"RETRY:"* ]]
}

@test "coverage calibrated contention writes the dispatch summary and skips same-runner retry" {
  stub_find 12
  make_infra_timeout
  # Wrap the existing fake Bun: calibration writes deterministic probe samples,
  # lookup uses the real typed parser, while chunk tests keep their canned data.
  mv "$STUB_BIN/bun" "$STUB_BIN/bun-tests"
  cat > "$STUB_BIN/bun" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == */runner-calibration.ts ]]; then
  if [[ "$2" == probe ]]; then
    printf '%s\t400\t100\n' "$4" >> "$3"
    exit 0
  fi
  exec "$REAL_BUN" "$@"
fi
exec "$(dirname "$0")/bun-tests" "$@"
SH
  chmod +x "$STUB_BIN/bun"
  run_coverage AUTOMOBILE_RUNNER_CALIBRATION=1 GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/summary"
  [ "$status" -eq 124 ]
  [[ "$output" == *"RUNNER-CONTENDED: unit shard"* ]]
  [[ "$output" != *"RETRY:"* ]]
  grep -q 'RUNNER-CONTENDED: unit shard' "$BATS_TEST_TMPDIR/summary"
  grep -q 'Unit shard 1 hit its 10s wall-clock budget' "$BATS_TEST_TMPDIR/summary"
}

@test "WriteFailed cannot waive a signal failure after its infra retry even with clean chunk summaries" {
  stub_find 12
  run env PATH="$STUB_BIN:$PATH" STUB_WRITE_FAILED_CHUNK=1-1 STUB_EXIT_CODE=137 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=10 bash scripts/ci/run-ts-coverage.sh "$BATS_TEST_TMPDIR/out.log"
  [ "$status" -eq 137 ]
  [[ "$output" == *"after a retry"* ]]
  [[ "$output" != *"continuing to verify coverage output"* ]]
  [ ! -f coverage/lcov.info ]
}
