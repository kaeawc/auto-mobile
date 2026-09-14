#!/usr/bin/env bats

SCRIPT="scripts/test-ts.sh"
TIMING_SCRIPT="scripts/validate-bun-test-timings.sh"

# Mirrors the real shape of `bun test --reporter=junit` output from the repo's
# Bun (1.3.14): an XML declaration, a <testsuites> root, nested <testsuite>
# elements, and `file=` on the <testcase> as well as on the suite. Bun 1.2.x
# omits `file=` on the suite entirely, which is why the gate must read the
# testcase attribute; fixtures that invented `<testsuite file>` as the only
# source of the path hid that (review thread PRRT_kwDOP-GF5M6h5GB8 on PR #6922).
#
# Usage: write_junit_report <outfile> <suite-file> [<classname> <name> <seconds>]...
write_junit_report() {
  local outfile="$1" suite_file="$2" count
  shift 2
  count="$(($# / 3))"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" tests="%d" assertions="%d" failures="0" skipped="0" time="0.200236">\n' \
      "$count" "$count"
    printf '  <testsuite name="%s" file="%s" tests="%d" assertions="%d" failures="0" skipped="0" time="0" hostname="mac.lan">\n' \
      "$suite_file" "$suite_file" "$count" "$count"
    while [[ "$#" -gt 0 ]]; do
      printf '    <testcase name="%s" classname="%s" time="%s" file="%s" line="1" assertions="1" />\n' \
        "$2" "$1" "$3" "$suite_file"
      shift 3
    done
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "$outfile"
}

write_junit_report_with_lines() {
  local outfile="$1" suite_file="$2" count
  shift 2
  count="$(($# / 4))"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" tests="%d" assertions="%d" failures="0" skipped="0" time="0.200236">\n' \
      "$count" "$count"
    printf '  <testsuite name="%s" file="%s" tests="%d" assertions="%d" failures="0" skipped="0" time="0" hostname="mac.lan">\n' \
      "$suite_file" "$suite_file" "$count" "$count"
    while [[ "$#" -gt 0 ]]; do
      printf '    <testcase name="%s" classname="%s" time="%s" file="%s" line="%s" assertions="1" />\n' \
        "$2" "$1" "$3" "$suite_file" "$4"
      shift 4
    done
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "$outfile"
}

setup() {
  STUB_BIN="$(mktemp -d)"
  REAL_BUN="$(command -v bun)"
  export REAL_BUN
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
if [[ "$1" == "run" && "$2" == "scripts/lib/junit-testcase-timings.ts" ]]; then
  exec "$REAL_BUN" "$@"
fi
printf '%s\n' "$*" >> "$BUN_ARGS_FILE"
# Same shape the real `bun test --reporter=junit` writes: `file=` lands on the
# <testcase>, not only on the enclosing <testsuite>.
stub_junit_report() {
  local outfile="$1" suite_file="$2" count line="${STUB_RECHECK_LINE:-1}"
  shift 2
  count="$(($# / 3))"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" tests="%d" assertions="%d" failures="0" skipped="0" time="0.200236">\n' \
      "$count" "$count"
    printf '  <testsuite name="%s" file="%s" tests="%d" assertions="%d" failures="0" skipped="0" time="0" hostname="mac.lan">\n' \
      "$suite_file" "$suite_file" "$count" "$count"
    while [[ "$#" -gt 0 ]]; do
      printf '    <testcase name="%s" classname="%s" time="%s" file="%s" line="%s" assertions="1" />\n' \
        "$2" "$1" "$3" "$suite_file" "$line"
      shift 3
    done
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "$outfile"
}
stub_junit_report_with_lines() {
  local outfile="$1" suite_file="$2" count
  shift 2
  count="$(($# / 4))"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" tests="%d" assertions="%d" failures="0" skipped="0" time="0.200236">\n' \
      "$count" "$count"
    printf '  <testsuite name="%s" file="%s" tests="%d" assertions="%d" failures="0" skipped="0" time="0" hostname="mac.lan">\n' \
      "$suite_file" "$suite_file" "$count" "$count"
    while [[ "$#" -gt 0 ]]; do
      printf '    <testcase name="%s" classname="%s" time="%s" file="%s" line="%s" assertions="1" />\n' \
        "$2" "$1" "$3" "$suite_file" "$4"
      shift 4
    done
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "$outfile"
}
report=""
target=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--reporter-outfile" ]]; then
    report="$2"
    shift 2
    continue
  fi
  case "$1" in
    *.test.ts) target="$1" ;;
  esac
  shift
done
if [[ -z "$report" ]]; then
  exit 0
fi
if [[ -n "${STUB_RECHECK_DUP_LINES:-}" ]]; then
  read -r -a dup_times <<< "${STUB_RECHECK_DUP_TIMES:-0.001 0.001}"
  read -r -a dup_lines <<< "$STUB_RECHECK_DUP_LINES"
  dup_cases=()
  for ((index = 0; index < ${#dup_lines[@]}; index += 1)); do
    dup_cases+=(suite dup "${dup_times[$index]:-0.001}" "${dup_lines[$index]}")
  done
  stub_junit_report_with_lines "$report" "${target:-test/example.test.ts}" "${dup_cases[@]}"
  exit 0
fi
if [[ -n "${STUB_RECHECK_DUP_TIMES:-}" ]]; then
  # Two testcases sharing one file+classname+name, so a test can pin how the
  # gate keeps duplicate names apart across recheck runs.
  read -r -a dup_times <<< "$STUB_RECHECK_DUP_TIMES"
  dup_cases=()
  for dup_seconds in "${dup_times[@]}"; do
    dup_cases+=(suite dup "$dup_seconds")
  done
  stub_junit_report "$report" "${target:-test/example.test.ts}" "${dup_cases[@]}"
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
  stub_classname="suite"
  stub_name="slow"
  if [[ -n "${STUB_RECHECK_CLASSNAME_FROM_FILE:-}" ]]; then
    # Many-offender fixtures need each re-run file to report its own suite.
    stub_classname="$(basename "${target:-test/example.test.ts}" .test.ts)"
    stub_name="case"
  fi
  stub_junit_report "$report" "${target:-test/example.test.ts}" \
    "$stub_classname" "$stub_name" "$seconds"
  exit 0
fi
stub_junit_report "$report" "${target:-test/example.test.ts}" fixture fast 0.001
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

@test "timing gate selects Bun-affected unit tests for testcase timing parser changes" {
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES='scripts/lib/junit-testcase-timings.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"measuring Bun-affected unit tests"* ]]
  grep -q -- "--changed=origin/main" "$BUN_ARGS_FILE"
  grep -q -- "--parallel=3" "$BUN_ARGS_FILE"
}

@test "timing gate reuses complete unit-lane reports for source changes" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report "$report_dir/shard-0.xml" "test/example.test.ts" fixture fast 0.001

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
  write_junit_report "$report_dir/shard-0.xml" "$OFFENDER_FILE" suite slow 0.200
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
  # Deliberately file-less on BOTH the suite and the testcase: there is nothing
  # to re-run, so the one sample stands.
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" tests="1" failures="0" skipped="0" time="0.2">\n'
    printf '  <testsuite name="suite" tests="1" failures="0" skipped="0" time="0" hostname="mac.lan">\n'
    printf '    <testcase name="slow" classname="suite" time="0.200" line="1" assertions="1" />\n'
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "$report_dir/shard-0.xml"

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (200.00ms)"* ]]
}

# A shared CI runner under co-tenant load charges its stall to whichever tests
# happen to be running, so a report where dozens of unrelated suites are a few
# milliseconds over is exactly the noise the recheck exists to absorb (#6837).
# Seed that shape: `count` unrelated files, each with one over-budget testcase,
# worst first so "the worst N" is unambiguous.
seed_loaded_runner_report() {
  local count="$1" index path seconds
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" failures="0" skipped="0" time="7.2">\n'
  } > "$report_dir/shard-0.xml"
  for ((index = 0; index < count; index += 1)); do
    path="$BATS_TEST_TMPDIR/suite${index}.test.ts"
    printf 'export {};\n' > "$path"
    seconds="$(printf '0.%03d' "$((300 - index))")"
    {
      printf '  <testsuite name="%s" file="%s" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="mac.lan">\n' \
        "$path" "$path"
      printf '    <testcase name="case" classname="suite%s" time="%s" file="%s" line="1" assertions="1" />\n' \
        "$index" "$seconds" "$path"
      printf '  </testsuite>\n'
    } >> "$report_dir/shard-0.xml"
  done
  printf '</testsuites>\n' >> "$report_dir/shard-0.xml"
}

repeat_stub_times() {
  local value="$1" count="$2" index times=""
  for ((index = 0; index < count; index += 1)); do
    times+="$value "
  done
  printf '%s' "$times"
}

@test "timing gate rechecks every loaded-runner offender when the budget allows it" {
  seed_loaded_runner_report 24

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_CLASSNAME_FROM_FILE=1 \
    STUB_RECHECK_TIMES="$(repeat_stub_times 0.010 24)" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Rechecking 24 file(s)"* ]]
  [[ "$output" != *"Test exceeded"* ]]
  # Worst first, but no offender is deferred: all 24 files get three samples.
  [ "$(grep -c "suite0\.test\.ts" "$BUN_ARGS_FILE")" -eq 3 ]
  [ "$(grep -c "suite7\.test\.ts" "$BUN_ARGS_FILE")" -eq 3 ]
  [ "$(grep -c "suite8\.test\.ts" "$BUN_ARGS_FILE")" -eq 3 ]
  [ "$(grep -c "suite23\.test\.ts" "$BUN_ARGS_FILE")" -eq 3 ]
}

@test "timing gate still fails offenders the recheck reproduces in isolation" {
  seed_loaded_runner_report 24

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_CLASSNAME_FROM_FILE=1 \
    STUB_RECHECK_TIMES="$(repeat_stub_times 0.150 24)" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite0.case (median 150.00ms of 3 isolated runs)"* ]]
}

@test "timing gate rejects a non-positive recheck budget" {
  seed_outlier_report

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=0 \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 2 ]
  [[ "$output" == *"BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS must be a positive integer"* ]]
}

@test "timing gate fails an offender whose recheck reported no sample at all" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "skip skip skip"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (200.00ms; recheck produced 0 of 3 isolated samples)"* ]]
}

# A literal tab inside a parameterized test title must not shift the duration out
# of the row it is measured from (review thread PRRT_kwDOP-GF5M6h43dW on PR #6922).
@test "timing gate measures a testcase whose name contains a tab" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report "$report_dir/shard-0.xml" "$OFFENDER_FILE" suite "$(printf 'slow\tcase')" 0.200

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms"* ]]
  [[ "$output" == *"200.00ms"* ]]
}

# Two tests in one file and describe block can share a name; counting rows per
# name then mixes their samples and a fast duplicate hides a slow one (review
# thread PRRT_kwDOP-GF5M6h43dZ on PR #6922).
@test "timing gate keeps duplicate test names apart across recheck runs" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report_with_lines "$report_dir/shard-0.xml" "$OFFENDER_FILE" \
    suite dup 0.010 10 \
    suite dup 0.150 42

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_DUP_TIMES="0.010 0.150" \
    STUB_RECHECK_DUP_LINES="10 42" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"median 150.00ms of 3 isolated runs"* ]]
  [[ "$output" != *"Recheck cleared suite.dup #2"* ]]
}

@test "timing gate attributes reordered line-identified duplicates across rechecks" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report_with_lines "$report_dir/shard-0.xml" "$OFFENDER_FILE" \
    suite dup 0.010 10 \
    suite dup 0.150 42

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_DUP_TIMES="0.150 0.010" \
    STUB_RECHECK_DUP_LINES="42 10" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.dup #2 (median 150.00ms of 3 isolated runs)"* ]]
  [[ "$output" != *"Recheck cleared suite.dup #2"* ]]
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

# Bun 1.2.x writes the source path ONLY on <testcase>; reading just the
# <testsuite> attribute left the path empty for a real report, so no recheck
# ran and a noisy first sample failed directly (review thread
# PRRT_kwDOP-GF5M6h5GB8 on PR #6922).
@test "timing gate reads the source path from the testcase attribute" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.200236">\n'
    printf '  <testsuite name="suite" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="mac.lan">\n'
    printf '    <testcase name="slow" classname="suite" time="0.200" file="%s" line="16" assertions="1" />\n' \
      "$OFFENDER_FILE"
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "$report_dir/shard-0.xml"

  STUB_RECHECK_LINE=16 run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Rechecking 1 file(s)"* ]]
  [[ "$output" == *"Recheck cleared suite.slow"* ]]
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 3 ]
}

# An offender in a test file THIS change touched can be the regression the gate
# exists to catch. It must be rechecked before unchanged offenders even when its
# first sample is ranked last.
seed_changed_offender_report() {
  local index path seconds
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" failures="0" skipped="0" time="1.2">\n'
  } > "$report_dir/shard-0.xml"
  for ((index = 0; index < 3; index += 1)); do
    path="$BATS_TEST_TMPDIR/suite${index}.test.ts"
    printf 'export {};\n' > "$path"
    seconds="$(printf '0.%03d' "$((300 - index))")"
    {
      printf '  <testsuite name="%s" file="%s" tests="1" failures="0" skipped="0" time="0">\n' "$path" "$path"
      printf '    <testcase name="case" classname="suite%s" time="%s" file="%s" line="1" assertions="1" />\n' \
        "$index" "$seconds" "$path"
      printf '  </testsuite>\n'
    } >> "$report_dir/shard-0.xml"
  done
  # Ranked LAST by first sample, so ordering has to come from the changed-file pass.
  {
    printf '  <testsuite name="%s" file="%s" tests="1" failures="0" skipped="0" time="0">\n' \
      "$OFFENDER_FILE" "$OFFENDER_FILE"
    printf '    <testcase name="case" classname="testLaneClassification" time="0.150" file="%s" line="1" assertions="1" />\n' \
      "$OFFENDER_FILE"
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } >> "$report_dir/shard-0.xml"
}

@test "timing gate rechecks a changed-file offender first even when ranked last" {
  seed_changed_offender_report

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES="src/example.ts\n$OFFENDER_FILE\n" \
    STUB_RECHECK_CLASSNAME_FROM_FILE=1 \
    STUB_RECHECK_TIMES="0.150 0.150 0.150 0.010 0.010 0.010" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  # Rechecked first, then failed on its isolated median.
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 3 ]
  [[ "$output" == *"Test exceeded 100ms: testLaneClassification.case (median 150.00ms of 3 isolated runs)"* ]]
  # Unchanged offenders are still rechecked after it.
  [ "$(grep -c "suite0\.test\.ts" "$BUN_ARGS_FILE")" -eq 3 ]
  [ "$(grep -c "suite1\.test\.ts" "$BUN_ARGS_FILE")" -eq 3 ]
  [ "$(grep -c "suite2\.test\.ts" "$BUN_ARGS_FILE")" -eq 3 ]
}

@test "timing gate fails closed when recheck time expires before all offenders are verified" {
  seed_changed_offender_report

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=1 \
    BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=1 \
    TIMING_CHANGED_FILES="src/example.ts\n$OFFENDER_FILE\n" \
    STUB_RECHECK_CLASSNAME_FROM_FILE=1 \
    STUB_RECHECK_TIMES="0.010 0.010 0.010" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not verify within the 1s recheck budget: suite0.case"* ]]
  [[ "$output" == *"suite1.case"* ]]
  [[ "$output" == *"BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS"* ]]
}

# `08` and `010` are digit-only but invalid/8 in Bash arithmetic, which skipped
# the recheck entirely and exited 0 (review thread PRRT_kwDOP-GF5M6h5GCD on
# PR #6922).
@test "timing gate rejects a recheck budget with a leading zero" {
  seed_outlier_report

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=08 \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 2 ]
  [[ "$output" == *"BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS must be a positive integer"* ]]
}

@test "timing gate catches a testcase whose title spans physical XML lines" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites><testsuite file="%s">\n' "$OFFENDER_FILE"
    printf '  <testcase name="slow\ncase" classname="suite" time="0.200" file="%s"/>\n' "$OFFENDER_FILE"
    printf '</testsuite></testsuites>\n'
  } > "$report_dir/shard-0.xml"

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"suite.slow"* ]]
  [[ "$output" == *"case"* ]]
}

@test "timing gate rejects a recheck run count with a leading zero" {
  seed_outlier_report

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_TIMING_RECHECK_RUNS=03 \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 2 ]
  [[ "$output" == *"BUN_TEST_TIMING_RECHECK_RUNS must be a positive integer"* ]]
}

@test "timing gate rejects a budget with a leading zero" {
  seed_outlier_report

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_MAX_MS=0100 \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 2 ]
  [[ "$output" == *"BUN_TEST_MAX_MS must be a positive integer"* ]]
}
