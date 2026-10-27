#!/usr/bin/env bats
# Coverage JUnit is a screen; only plain isolated medians enforce 100ms.

setup() {
  export REAL_BUN="$(command -v bun)"
  export TIMING_TEST_FILE="test/scripts/nodeTestWorkflow.test.ts"
  export RECHECK_CALLS="$BATS_TEST_TMPDIR/rechecks"
  export BUN_TEST_TIMING_REPORT_DIR="$BATS_TEST_TMPDIR/reports"
  export BUN_TEST_TIMING_REPORTS_INSTRUMENTED=true
  export BUN_TEST_TIMING_BASE_REF=HEAD^
  export BUN_TEST_TIMING_PROBE_COMMAND="$BATS_TEST_TMPDIR/bin/probe"
  mkdir -p "$BUN_TEST_TIMING_REPORT_DIR" "$BATS_TEST_TMPDIR/bin"
  cat > "$BUN_TEST_TIMING_REPORT_DIR/shard-1-chunk-1.xml" <<XML
<testsuites><testsuite name="s"><testcase name="coverage offender" classname="s" file="$TIMING_TEST_FILE" time="0.25" /></testsuite></testsuites>
XML
  cat > "$BATS_TEST_TMPDIR/bin/git" <<'SH'
#!/usr/bin/env bash
# No changed tests or runtime files: coverage still screens the complete suite.
exit 0
SH
  cat > "$BATS_TEST_TMPDIR/bin/probe" <<'SH'
#!/usr/bin/env bash
echo 1
SH
  cat > "$BATS_TEST_TMPDIR/bin/bun" <<'SH'
#!/usr/bin/env bash
if [[ "$1" != test ]]; then exec "$REAL_BUN" "$@"; fi
printf '%s\n' "$*" >> "$RECHECK_CALLS"
report=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --reporter-outfile ]]; then report="$2"; shift; fi
  shift
done
[[ "${OMIT_RECHECK_REPORT:-false}" != true ]] || exit 1
cat > "$report" <<XML
<testsuites><testsuite name="s"><testcase name="coverage offender" classname="s" file="$TIMING_TEST_FILE" time="${PLAIN_TEST_SECONDS:-0.001}" /></testsuite></testsuites>
XML
SH
  chmod +x "$BATS_TEST_TMPDIR/bin/"*
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "instrumented overages pass only after uninstrumented isolated rechecks, even with no source diff" {
  run bash scripts/validate-bun-test-timings.sh "$BATS_TEST_TMPDIR/report.xml"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$RECHECK_CALLS" | tr -d ' ')" -ge 2 ]
  grep -q -- '--isolate' "$RECHECK_CALLS"
  ! grep -q -- '--coverage' "$RECHECK_CALLS"
}

@test "a true plain 100ms median breach fails despite inflated coverage calibration" {
  run env PLAIN_TEST_SECONDS=0.2 BUN_TEST_TIMING_SLOWDOWN=8 \
    bash scripts/validate-bun-test-timings.sh "$BATS_TEST_TMPDIR/report.xml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"median"*"isolated runs"* ]]
  [ "$(wc -l < "$RECHECK_CALLS" | tr -d ' ')" -eq 3 ]
}

@test "instrumented reports fail closed when plain rechecks produce no timing evidence" {
  run env OMIT_RECHECK_REPORT=true bash scripts/validate-bun-test-timings.sh "$BATS_TEST_TMPDIR/report.xml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"recheck produced 0 of 3 isolated samples"* ]]
  run env BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=600 \
    bash scripts/validate-bun-test-timings.sh "$BATS_TEST_TMPDIR/report.xml"
  [ "$status" -ne 0 ]
}

@test "missing coverage JUnit cannot skip the timing budget on an unchanged merge" {
  rm "$BUN_TEST_TIMING_REPORT_DIR/"*.xml
  run bash scripts/validate-bun-test-timings.sh "$BATS_TEST_TMPDIR/report.xml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"No unit-lane JUnit reports found"* ]]
}
