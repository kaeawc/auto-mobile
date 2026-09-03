#!/usr/bin/env bats

SCRIPT="scripts/test-ts.sh"
TIMING_SCRIPT="scripts/validate-bun-test-timings.sh"

setup() {
  STUB_BIN="$(mktemp -d)"
  BUN_ARGS_FILE="$(mktemp)"
  export BUN_ARGS_FILE
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
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--reporter-outfile" ]]; then
    report="$2"
    shift 2
    continue
  fi
  shift
done
if [[ -n "$report" ]]; then
  printf '<testsuites><testcase name="fast" classname="fixture" time="0.001" /></testsuites>\n' > "$report"
fi
EOF
  chmod +x "$STUB_BIN/git" "$STUB_BIN/bun"
}

teardown() {
  rm -rf "$STUB_BIN"
  rm -f "$BUN_ARGS_FILE"
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
  for option in --config --env-file --cwd; do
    run_lane unit "$option" bunfig.toml test/scripts/testLaneClassification.test.ts
    [ "$status" -eq 0 ]
    [[ "$output" == *"$option bunfig.toml"* ]]
    [[ "$output" == *"test/scripts/testLaneClassification.test.ts"* ]]
  done
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

@test "timing gate retains isolated reports after rechecking a unit-lane outlier" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  printf '<testsuite file="test/example.test.ts"><testcase name="slow" time="0.200" /></testsuite>\n' \
    > "$report_dir/shard-0.xml"

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [ ! -e "$report_dir/shard-0.xml" ]
  [ -s "$report_dir/isolation-0.xml" ]
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
