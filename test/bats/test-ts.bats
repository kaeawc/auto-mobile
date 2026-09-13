#!/usr/bin/env bats

SCRIPT="scripts/test-ts.sh"
TIMING_SCRIPT="scripts/validate-bun-test-timings.sh"

setup() {
  STUB_BIN="$(mktemp -d)"
  BUN_ARGS_FILE="$(mktemp)"
  export BUN_ARGS_FILE
  STUB_RECHECK_INDEX="$(mktemp)"
  export STUB_RECHECK_INDEX
  cat > "$STUB_BIN/nproc" <<'EOF'
#!/usr/bin/env bash
printf '8\n'
EOF
  cat > "$STUB_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${UNAME_S:-Linux}"
EOF
  chmod +x "$STUB_BIN/nproc" "$STUB_BIN/uname"
  cat > "$STUB_BIN/git" <<'EOF'
#!/usr/bin/env bash
printf '%b' "${TIMING_CHANGED_FILES:-}"
EOF
  cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BUN_ARGS_FILE"
report=""
target=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--reporter-outfile" ]]; then
    report="$2"
    shift 2
    continue
  fi
  case "$1" in
    test/*) target="$1" ;;
  esac
  shift
done
if [[ -z "$report" ]]; then
  exit 0
fi
if [[ -n "${STUB_RECHECK_TIMES:-}" ]]; then
  # Each re-run of an offending file reports the next time in the sequence, so
  # a test can pin how the gate combines repeated samples.
  index=0
  if [[ -f "$STUB_RECHECK_INDEX" ]]; then
    index="$(cat "$STUB_RECHECK_INDEX")"
  fi
  read -r -a stub_times <<< "$STUB_RECHECK_TIMES"
  seconds="${stub_times[$index]:-0.001}"
  printf '%s\n' "$((index + 1))" > "$STUB_RECHECK_INDEX"
  if [[ "$seconds" == "skip" ]]; then
    # A recheck run that dies before the reporter writes the offending testcase.
    printf 'stub bun crashed before writing a report\n' >&2
    exit 1
  fi
  printf '<testsuite file="%s"><testcase name="slow" classname="suite" time="%s" /></testsuite>\n' \
    "${target:-test/example.test.ts}" "$seconds" > "$report"
  exit 0
fi
printf '<testsuites><testcase name="fast" classname="fixture" time="0.001" /></testsuites>\n' > "$report"
EOF
  chmod +x "$STUB_BIN/git" "$STUB_BIN/bun"
}

teardown() {
  rm -rf "$STUB_BIN"
  rm -f "$BUN_ARGS_FILE" "$STUB_RECHECK_INDEX"
}

run_lane() {
  run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 bash "$SCRIPT" "$@"
}

@test "unit lane is parallel and excludes integration and stress" {
  run_lane unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"--shards=6"* ]]
  [[ "$output" == *"--isolate"* ]]
  [[ "$output" == *"--no-orphans"* ]]
  [[ "$output" == *"\\*\\*/\\*.integration.test.ts"* ]]
  [[ "$output" == *"test/stress/\\*\\*"* ]]
}

@test "Windows unit lane avoids isolate-only process options" {
  run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 RUNNER_OS=Windows bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" != *"--parallel="* ]]
  [[ "$output" != *"--no-orphans"* ]]
}

@test "local macOS detection retains per-test timeout headroom" {
  run env -u RUNNER_OS \
    PATH="$STUB_BIN:$PATH" \
    TEST_TS_PRINT_CMD=1 \
    UNAME_S=Darwin \
    bash "$SCRIPT" unit test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"--timeout 20000"* ]]
}

@test "changed lane delegates affected selection to Bun" {
  run_lane changed
  [ "$status" -eq 0 ]
  [[ "$output" == *"--changed=origin/main"* ]]
}

@test "changed lane accepts a base ref without package-script expansion" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    TEST_TS_PRINT_CMD=1 \
    AUTOMOBILE_UNIT_TEST_BASE_REF=refs/remotes/origin/release \
    bash "$SCRIPT" changed
  [ "$status" -eq 0 ]
  [[ "$output" == *"--changed=refs/remotes/origin/release"* ]]
}

@test "integration lane selects the canonical suffix conservatively" {
  run_lane integration
  [ "$status" -eq 0 ]
  [[ "$output" == *"--parallel=1"* ]]
  [[ "$output" == *".integration.test.ts"* ]]
}

@test "integration lane targets only requested integration paths" {
  run_lane integration test/contracts/runAll.integration.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"test/contracts/runAll.integration.test.ts"* ]]
  [[ "$output" != *" .integration.test.ts "* ]]
}

@test "integration lane rejects a requested unit-test path" {
  run_lane integration test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *"No integration test paths were selected."* ]]
}

@test "unit lanes reject cross-lane test targets" {
  for lane in unit changed coverage; do
    run_lane "$lane" test/contracts/runAll.integration.test.ts
    [ "$status" -eq 2 ]
    [[ "$output" == *"No unit test paths were selected."* ]]
  done
}

@test "all partitions a targeted test path and skips empty lanes" {
  run_lane all test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
  [[ "$output" != *"No integration test paths were selected."* ]]
  [ "$(grep -c '^bun test' <<< "$output")" -eq 1 ]
}

@test "all partitions targeted directories into their matching lane" {
  run_lane all test/scripts
  [ "$status" -eq 0 ]
  [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
  [[ "$output" == *"test/scripts/xcodegenDriftCheck.integration.test.ts"* ]]
  [ "$(grep -c '^bun test' <<< "$output")" -eq 2 ]
}

@test "test-option values are not classified as positional test targets" {
  run_lane all --test-name-pattern test/scripts
  [ "$status" -eq 0 ]
  [[ "$output" == *"--test-name-pattern test/scripts"* ]]
  [ "$(grep -c '^bun test' <<< "$output")" -eq 3 ]
}

@test "equals-form options are not classified as positional test targets" {
  run_lane unit --test-name-pattern=integration.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"--test-name-pattern=integration.test.ts"* ]]
}

@test "preload option values are not classified as positional test targets" {
  for option in --preload --require -r; do
    run_lane unit "$option" test/fakes/FakeTimer.ts
    [ "$status" -eq 0 ]
    [[ "$output" == *"$option test/fakes/FakeTimer.ts"* ]]
  done
}

@test "split-form bail counts are not classified as positional test targets" {
  run_lane unit --bail 2 test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"--bail 2"* ]]
  [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
}

@test "bare bail does not consume a positional test target" {
  run_lane unit --bail test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"--bail"* ]]
  [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
}

@test "bare bail reprocesses a following value-bearing option" {
  run_lane unit --bail --test-name-pattern "lane classification" test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"--test-name-pattern lane\\ classification"* ]]
  [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
}

@test "Bun runtime option values are not classified as positional test targets" {
  for option in --config --env-file; do
    run_lane unit "$option" bunfig.toml test/scripts/testLaneClassification.test.ts
    [ "$status" -eq 0 ]
    [[ "$output" == *"$option bunfig.toml"* ]]
    [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
  done
}

@test "optional Bun flags do not consume following test targets" {
  for option in --parallel --changed --inspect; do
    run_lane unit "$option" test/contracts/runAll.integration.test.ts
    [ "$status" -eq 2 ]
    [[ "$output" == *"No unit test paths were selected."* ]]
  done
}

@test "optional Bun flags classify normalized test target spellings" {
  run_lane unit --changed ./test/contracts/runAll.integration.test.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *"No unit test paths were selected."* ]]

  run_lane unit --changed test
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unit test targets cannot include other lanes."* ]]

  link="$BATS_TEST_TMPDIR/auto-mobile-link"
  ln -s "$PWD" "$link"
  run env \
    PATH="$STUB_BIN:$PATH" \
    TEST_TS_PRINT_CMD=1 \
    bash "$link/$SCRIPT" unit --changed "$link/test/contracts/runAll.integration.test.ts"
  [ "$status" -eq 2 ]
  [[ "$output" == *"No unit test paths were selected."* ]]
}

@test "optional Bun flags preserve unambiguous split values" {
  run_lane unit --parallel 2 test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"--parallel 2"* ]]
}

@test "rejects a cwd override that would invalidate lane classification" {
  run_lane unit --cwd test scripts/testLaneClassification.test.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *"--cwd is not supported"* ]]
}

@test "rejects an unclassified positional Bun pattern" {
  run_lane unit oxlintConfigScoping
  [ "$status" -eq 2 ]
  [[ "$output" == *"No test files found for target"* ]]
}

@test "canonicalizes absolute test paths before assigning their lane" {
  run_lane all "$BATS_TEST_DIRNAME/../stress/memory-leak.stress.test.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"test/stress/memory-leak.stress.test.ts"* ]]
  [ "$(grep -c '^bun test' <<< "$output")" -eq 1 ]
}

@test "accepts explicit targets when invoked through a symlinked checkout path" {
  link="$BATS_TEST_TMPDIR/auto-mobile-link"
  ln -s "$PWD" "$link"
  run env \
    PATH="$STUB_BIN:$PATH" \
    TEST_TS_PRINT_CMD=1 \
    bash "$link/$SCRIPT" unit "$link/test/scripts/testLaneClassification.test.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
}

@test "classifies a symlinked test file by its resolved target" {
  link="test/.lane-classification-${BATS_TEST_NUMBER}.test.ts"
  ln -s "stress/memory-leak.stress.test.ts" "$link"
  run_lane unit "$link"
  rm -f "$link"
  [ "$status" -eq 2 ]
  [[ "$output" == *"No unit test paths were selected."* ]]
}

@test "single-lane modes reject a mixed-lane target list" {
  run_lane unit test/scripts/testLaneClassification.test.ts test/contracts/runAll.integration.test.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unit test targets cannot include other lanes."* ]]

  run_lane integration test/contracts/runAll.integration.test.ts test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *"Integration test targets cannot include other lanes."* ]]

  run_lane stress test/stress/memory-leak.stress.test.ts test/scripts/testLaneClassification.test.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *"Stress test targets cannot include other lanes."* ]]
}

@test "targeting a stale test path fails before invoking Bun" {
  run_lane unit test/scripts/removed-test.test.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *"No test files found for target"* ]]
  [ ! -s "$BUN_ARGS_FILE" ]
}

@test "stress lane is explicit" {
  run_lane stress
  [ "$status" -eq 0 ]
  [[ "$output" == *"test/stress"* ]]
}

@test "coverage uses the unit selection" {
  run_lane coverage
  [ "$status" -eq 0 ]
  [[ "$output" == *"--parallel=1"* ]]
  [[ "$output" == *"--isolate"* ]]
  [[ "$output" == *"--coverage"* ]]
  [[ "$output" == *"--coverage-reporter=lcov"* ]]
  [[ "$output" == *"\\*\\*/\\*.integration.test.ts"* ]]
}

@test "rejects an invalid wall timeout before executing Bun" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    TEST_TS_PRINT_CMD=1 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=never \
    bash "$SCRIPT" unit
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS must be a positive integer"* ]]
}

@test "rejects unknown modes" {
  run_lane nope
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "timing gate handles an empty changed-unit selection" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES=$'test/example.integration.test.ts\ntest/stress/load.test.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No changed unit tests"* ]]
  [ ! -s "$BUN_ARGS_FILE" ]
}

@test "timing gate measures changed unit files individually" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES='test/scripts/testLaneClassification.test.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  grep -q "test/scripts/testLaneClassification.test.ts" "$BUN_ARGS_FILE"
}

@test "timing gate selects Bun-affected unit tests for source changes" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"measuring Bun-affected unit tests"* ]]
  grep -q -- "--changed=origin/main" "$BUN_ARGS_FILE"
  grep -q -- "--parallel=3" "$BUN_ARGS_FILE"
}

@test "timing gate reuses complete unit-lane reports for source changes" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  printf '<testsuites><testcase name="fast" classname="fixture" time="0.001" /></testsuites>\n' \
    > "$report_dir/shard-0.xml"

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"measuring complete unit-lane reports"* ]]
  [ ! -s "$BUN_ARGS_FILE" ]
}

OFFENDER_FILE="test/scripts/testLaneClassification.test.ts"

# Seed a unit-lane report whose only testcase is over the budget, so the gate
# reaches its recheck path.
seed_outlier_report() {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  printf '<testsuite file="%s"><testcase name="slow" classname="suite" time="0.200" /></testsuite>\n' \
    "$OFFENDER_FILE" > "$report_dir/shard-0.xml"
}

run_timing_gate_with_recheck_times() {
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_TIMES="$1" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
}

@test "timing gate clears an outlier whose median recheck is within budget" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Rechecking 1 file(s)"* ]]
  [[ "$output" == *"Recheck cleared suite.slow"* ]]
  [[ "$output" == *"median 11.00ms over 3 isolated runs"* ]]
}

@test "timing gate enforces the median rather than the worst recheck sample" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.150 0.010 0.011"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Recheck cleared suite.slow"* ]]
}

@test "timing gate fails when the median recheck still breaches the budget" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.150 0.160"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (median 150.00ms of 3 isolated runs)"* ]]
}

# A recheck run that dies before the reporter writes the offending testcase
# leaves fewer samples than configured. Accepting that partial set lets ONE fast
# sample clear a real budget breach, which is the opposite of what the gate is
# for (review thread PRRT_kwDOP-GF5M6h4wit on PR #6922).
@test "timing gate fails an outlier whose recheck produced fewer samples than configured" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "skip skip 0.010"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (200.00ms; recheck produced 1 of 3 isolated samples)"* ]]
  [[ "$output" != *"Recheck cleared"* ]]
}

@test "timing gate still fails a breaching median when a recheck sample is missing" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.150 skip 0.160"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow"* ]]
}

@test "timing gate rechecks the whole offending file, not a single test name" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.010 0.010"
  [ "$status" -eq 0 ]
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 3 ]
  ! grep -q -- "--test-name-pattern" "$BUN_ARGS_FILE"
}

@test "timing gate honours a configured recheck run count" {
  seed_outlier_report
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_TIMING_RECHECK_RUNS=5 \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_TIMES="0.150 0.150 0.010 0.010 0.010" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 5 ]
  [[ "$output" == *"median 10.00ms over 5 isolated runs"* ]]
}

@test "timing gate leaves the measured unit-lane reports untouched" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.010 0.010"
  [ "$status" -eq 0 ]
  [ -s "$report_dir/shard-0.xml" ]
  [ -s "$BATS_TEST_TMPDIR/timings.recheck.d/recheck-0.xml" ]
}

@test "timing gate fails an unrecheckable outlier on its first sample" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  # No file attribute: there is nothing to re-run, so the one sample stands.
  printf '<testsuites><testcase name="slow" classname="suite" time="0.200" /></testsuites>\n' \
    > "$report_dir/shard-0.xml"

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (200.00ms)"* ]]
}

@test "timing gate skips the recheck when too many files breach the budget" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  printf '<testsuite file="%s"><testcase name="slow" classname="suite" time="0.200" /></testsuite>\n' \
    "$OFFENDER_FILE" > "$report_dir/shard-0.xml"

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_TIMING_RECHECK_MAX_FILES=0 \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_TIMES="0.010" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Skipping the median recheck"* ]]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (200.00ms)"* ]]
  [ ! -s "$BUN_ARGS_FILE" ]
}

@test "timing gate selects Bun-affected unit tests for shared test support changes" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES='test/fakes/FakeTimer.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"measuring Bun-affected unit tests"* ]]
  grep -q -- "--changed=origin/main" "$BUN_ARGS_FILE"
}

@test "timing gate selects Bun-affected unit tests for runtime changes" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES='package.json\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"measuring Bun-affected unit tests"* ]]
  grep -q -- "--changed=origin/main" "$BUN_ARGS_FILE"
}
