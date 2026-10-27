#!/usr/bin/env bats

TIMING_SCRIPT="scripts/validate-bun-test-timings.sh"

setup_file() {
  bats_require_minimum_version 1.5.0
}

write_report() {
  cat > "$1" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="suite">
  <testcase classname="suite" name="$2" time="$3" file="$OFFENDER_FILE" line="1" />
</testsuite></testsuites>
EOF
}

setup() {
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export REAL_BUN="$(command -v bun)"
  export LANE_MARKER="$BATS_TEST_TMPDIR/lane-called"
  export BUN_ARGS_FILE="$BATS_TEST_TMPDIR/bun-args"
  export STUB_LANE_XML="$BATS_TEST_TMPDIR/lane.xml"
  export STUB_RECHECK_XML="$BATS_TEST_TMPDIR/recheck.xml"
  OFFENDER_FILE="test/scripts/unitTimingBudgetWorkflow.test.ts"
  REPORT="$BATS_TEST_TMPDIR/focused report.xml"
  # Caller CI settings must not select a different mode or waive the budget.
  unset BUN_TEST_TIMING_BASE_REF BUN_TEST_TIMING_REPORT_DIR BUN_TEST_TIMING_RUN_LANE \
    BUN_TEST_TIMING_SLOWDOWN BUN_TEST_TIMING_PROBE_COMMAND GITHUB_STEP_SUMMARY
  export BUN_TEST_MAX_MS=100 BUN_TEST_TIMING_RECHECK_RUNS=3
  export BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=600
  export AUTOMOBILE_UNIT_TEST_WORKERS=2 AUTOMOBILE_UNIT_SHARD_RETRIES=0 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=600
  write_report "$REPORT" focused 0.010
  write_report "$STUB_LANE_XML" lane 0.010
  write_report "$STUB_RECHECK_XML" slow 0.150

  # Intercept only the lane entry point. The validator and watchdog still run
  # in stock Bash, and no test can accidentally start the real unit lane.
  cat > "$STUB_BIN/bash" <<'EOF'
#!/bin/bash
if [[ "$1" == scripts/test-ts.sh ]]; then
  printf '%s\n' "$*" >> "$LANE_MARKER"
  [[ "${ALLOW_LANE:-0}" == 1 ]] || exit 97
  mkdir -p "$AUTOMOBILE_UNIT_JUNIT_DIR"
  cp "$STUB_LANE_XML" "$AUTOMOBILE_UNIT_JUNIT_DIR/shard-0.xml"
  exit 0
fi
exec /bin/bash "$@"
EOF
  cat > "$STUB_BIN/bun" <<'EOF'
#!/bin/bash
if [[ "$1" == run && "$2" == scripts/lib/junit-testcase-timings.ts ]]; then
  exec "$REAL_BUN" "$@"
fi
if [[ "$1" == */scripts/lib/runner-calibration.ts ]]; then
  if [[ "$2" == measure ]]; then
    printf '1.00\n'
    exit 0
  fi
  exec "$REAL_BUN" "$@"
fi
[[ "$1" == test ]] || exit 98
printf '%s\n' "$*" >> "$BUN_ARGS_FILE"
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --reporter-outfile ]]; then
    cp "$STUB_RECHECK_XML" "$2"
    exit 0
  fi
  shift
done
exit 99
EOF
  chmod +x "$STUB_BIN/bash" "$STUB_BIN/bun"
}

run_validator() {
  run env PATH="$STUB_BIN:$PATH" /bin/bash "$TIMING_SCRIPT" "$@"
}

@test "timing input measures an existing XML and never spawns test-ts.sh" {
  mkdir -p "${REPORT%.xml}.d"
  : > "${REPORT%.xml}.d/.bun-test-timings-scratch"
  write_report "${REPORT%.xml}.d/stale.xml" stale 0.500
  run_validator "$REPORT"
  [ ! -e "$LANE_MARKER" ]
  [ "$status" -eq 0 ]
  [ ! -e "$BUN_ARGS_FILE" ]
  [ ! -e "${REPORT%.xml}.d/stale.xml" ]
  cmp "$REPORT" "${REPORT%.xml}.d/report.xml"
}

@test "timing input never deletes a sibling directory it did not create (#14500)" {
  sibling="${REPORT%.xml}.d"
  mkdir -p "$sibling"
  printf 'precious\n' > "$sibling/data.txt"
  run_validator "$REPORT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"Refusing to delete"* ]]
  [ "$(cat "$sibling/data.txt")" = precious ]
}

@test "timing input never deletes a sibling recheck directory it did not create (#14500)" {
  sibling="${REPORT%.xml}.recheck.d"
  mkdir -p "$sibling"
  printf 'precious\n' > "$sibling/data.txt"
  run_validator "$REPORT"
  [ "$status" -eq 2 ]
  [ "$(cat "$sibling/data.txt")" = precious ]
}

@test "timing input reuses an empty pre-existing scratch directory and marks it (#14500)" {
  mkdir -p "${REPORT%.xml}.d"
  run_validator "$REPORT"
  [ "$status" -eq 0 ]
  [ -e "${REPORT%.xml}.d/.bun-test-timings-scratch" ]
  # A second run recognises its own marked scratch and replaces it.
  run_validator "$REPORT"
  [ "$status" -eq 0 ]
}

@test "timing input refuses a symlinked scratch directory (#14500)" {
  mkdir -p "$BATS_TEST_TMPDIR/elsewhere"
  printf 'precious\n' > "$BATS_TEST_TMPDIR/elsewhere/data.txt"
  ln -s "$BATS_TEST_TMPDIR/elsewhere" "${REPORT%.xml}.d"
  run_validator "$REPORT"
  [ "$status" -eq 2 ]
  [ "$(cat "$BATS_TEST_TMPDIR/elsewhere/data.txt")" = precious ]
}

@test "timing input stages a dot-prefixed XML into the visible report glob" {
  REPORT="$BATS_TEST_TMPDIR/.focused.xml"
  write_report "$REPORT" hidden 0.010
  run_validator "$REPORT"
  [ "$status" -eq 0 ]
  [ ! -e "$LANE_MARKER" ]
  cmp "$REPORT" "${REPORT%.xml}.d/report.xml"
  grep -Fq hidden "${REPORT%.xml}.recheck.d/measured.tsv"
}

@test "timing input fails an existing XML offender using only isolated median rechecks" {
  write_report "$REPORT" slow 0.200
  run_validator "$REPORT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (median 150.00ms of 3 isolated runs)"* ]]
  [ ! -e "$LANE_MARKER" ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 3 ]
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 3 ]
  ! grep -q -- --test-name-pattern "$BUN_ARGS_FILE"
}

@test "timing input clears an existing XML outlier with an under-budget isolated median" {
  write_report "$REPORT" slow 0.200
  write_report "$STUB_RECHECK_XML" slow 0.010
  run_validator "$REPORT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Recheck cleared suite.slow"* ]]
  [ ! -e "$LANE_MARKER" ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 2 ]
}

@test "timing input measures every XML in an existing directory without a lane" {
  report_dir="$BATS_TEST_TMPDIR/reports"
  mkdir -p "$report_dir"
  write_report "$report_dir/first.xml" first 0.010
  write_report "$report_dir/second.xml" second 0.020
  run_validator "$report_dir/"
  [ "$status" -eq 0 ]
  [ ! -e "$LANE_MARKER" ]
  [ ! -e "$BUN_ARGS_FILE" ]
  [ "$(wc -l < "$report_dir.recheck.d/measured.tsv")" -eq 2 ]
  grep -Fq first "$report_dir.recheck.d/measured.tsv"
  grep -Fq second "$report_dir.recheck.d/measured.tsv"
  [ -f "$report_dir/first.xml" ]
  [ -f "$report_dir/second.xml" ]
}

@test "timing input directory rechecks only the offending file" {
  report_dir="$BATS_TEST_TMPDIR/reports"
  mkdir -p "$report_dir"
  write_report "$report_dir/slow.xml" slow 0.200
  # Distinguish the passing file from the offender in the isolated invocations.
  passing_file="test/scripts/testLaneClassification.test.ts"
  OFFENDER_FILE="$passing_file" write_report "$report_dir/fast.xml" fast 0.010
  run_validator "$report_dir"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow"* ]]
  [ ! -e "$LANE_MARKER" ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 3 ]
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 3 ]
  ! grep -Fq -- "$passing_file" "$BUN_ARGS_FILE"
}

@test "timing input directory preserves calibration for the first-sample budget" {
  report_dir="$BATS_TEST_TMPDIR/reports"
  mkdir -p "$report_dir"
  write_report "$report_dir/shard-0.xml" slow 0.200
  printf 'unit shard 0 attempt 1 start\t75\t25\n' > "$report_dir/calibration-unit-shard-0.tsv"
  run_validator "$report_dir"
  [ "$status" -eq 0 ]
  [[ "$output" == *"slowdown 3.00x; first-sample budget 300.00ms"* ]]
  [ ! -e "$LANE_MARKER" ]
  [ ! -e "$BUN_ARGS_FILE" ]
  [ -s "$report_dir/calibration-unit-shard-0.tsv" ]
}

@test "timing input rejects no argument without invoking a lane" {
  run --separate-stderr env PATH="$STUB_BIN:$PATH" /bin/bash "$TIMING_SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"Usage:"*"existing .xml"*"--run-unit-lane"* ]]
  [ -z "$output" ]
  [ ! -e "$LANE_MARKER" ]
}

@test "timing input rejects a nonexistent path without invoking a lane" {
  run_validator "$BATS_TEST_TMPDIR/missing.xml"
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"*"existing .xml"*"--run-unit-lane"* ]]
  [ ! -e "$LANE_MARKER" ]
}

@test "timing input rejects an empty directory or a non-XML file without a lane" {
  mkdir -p "$BATS_TEST_TMPDIR/empty"
  cp "$REPORT" "$BATS_TEST_TMPDIR/report.txt"
  for input in "$BATS_TEST_TMPDIR/empty" "$BATS_TEST_TMPDIR/report.txt"; do
    run_validator "$input"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Usage:"* ]]
    [ ! -e "$LANE_MARKER" ]
  done
}

@test "timing input run-unit-lane flag works before or after the output path" {
  export ALLOW_LANE=1
  run_validator --run-unit-lane "$REPORT"
  [ "$status" -eq 0 ]
  grep -Fx 'scripts/test-ts.sh unit' "$LANE_MARKER"
  [ -f "${REPORT%.xml}.d/shard-0.xml" ]
  rm "$LANE_MARKER"
  run_validator "$REPORT" --run-unit-lane
  [ "$status" -eq 0 ]
  grep -Fx 'scripts/test-ts.sh unit' "$LANE_MARKER"
}

@test "timing input RUN_LANE env explicitly invokes a unit lane" {
  export ALLOW_LANE=1 BUN_TEST_TIMING_RUN_LANE=1
  run_validator "$BATS_TEST_TMPDIR/output.xml"
  [ "$status" -eq 0 ]
  grep -Fx 'scripts/test-ts.sh unit' "$LANE_MARKER"
  [ -f "$BATS_TEST_TMPDIR/output.d/shard-0.xml" ]
}

@test "timing input lane output paths retain their legacy trailing-slash layout" {
  export ALLOW_LANE=1
  output_dir="$BATS_TEST_TMPDIR/lane-output"
  run_validator --run-unit-lane "$output_dir/"
  [ "$status" -eq 0 ]
  grep -Fx 'scripts/test-ts.sh unit' "$LANE_MARKER"
  [ -f "$output_dir/.d/shard-0.xml" ]
}

@test "timing input BASE_REF keeps precedence over lane opt-ins and existing XML" {
  cat > "$STUB_BIN/git" <<'EOF'
#!/bin/bash
# No changed files: BASE_REF mode exits without measuring or running a lane.
exit 0
EOF
  chmod +x "$STUB_BIN/git"
  export BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_RUN_LANE=1
  write_report "$REPORT" slow 0.200
  run_validator "$REPORT" --run-unit-lane
  [ "$status" -eq 0 ]
  [[ "$output" == *"No changed unit tests to validate"* ]]
  [ ! -e "$LANE_MARKER" ]
  [ ! -e "$BUN_ARGS_FILE" ]
  # BASE_REF also keeps the old positional-output layout for trailing slashes.
  output_dir="$BATS_TEST_TMPDIR/base-output"
  run_validator "$output_dir/"
  [ "$status" -eq 0 ]
  [ -d "$output_dir/.d" ]
  [ ! -e "$LANE_MARKER" ]
}
