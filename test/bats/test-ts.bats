#!/usr/bin/env bats
# bats file_tags=serial

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
  # Every unit file runs isolated unless a test writes this shared-process
  # allow-list (#10583); the committed list must not leak into stubbed lanes.
  AUTOMOBILE_UNIT_SHARED_ALLOWLIST="$STUB_BIN/shared-process-allowlist.txt"
  export AUTOMOBILE_UNIT_SHARED_ALLOWLIST
  : > "$AUTOMOBILE_UNIT_SHARED_ALLOWLIST"
  cat > "$STUB_BIN/nproc" <<'EOF'
#!/usr/bin/env bash
if [[ "${STUB_NPROC_FAIL:-}" == "1" ]]; then
  exit 1
fi
printf '%s\n' "${STUB_NPROC_CORES:-8}"
EOF
  cat > "$STUB_BIN/sysctl" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == "-n" ]] || exit 1
if [[ "$2" == "hw.physicalcpu" ]]; then
  printf '%s\n' "${STUB_SYSCTL_PHYSICAL_CORES:-4}"
  exit 0
fi
[[ "$2" == "hw.ncpu" ]] || exit 1
printf '%s\n' "${STUB_SYSCTL_CORES:-8}"
EOF
  cat > "$STUB_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${UNAME_S:-Linux}"
EOF
  chmod +x "$STUB_BIN/nproc" "$STUB_BIN/sysctl" "$STUB_BIN/uname"
  cat > "$STUB_BIN/git" <<'EOF'
#!/usr/bin/env bash
printf '%b' "${TIMING_CHANGED_FILES:-}"
EOF
cat > "$STUB_BIN/bun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "run" && "$2" == "scripts/lib/junit-testcase-timings.ts" ]]; then
  exec "$REAL_BUN" "$@"
fi
if [[ "$1" == "scripts/lib/merge-junit-reports.ts" ]]; then
  exec "$REAL_BUN" "$@"
fi
# Runner calibration (#10583): fake the probe so shard tests stay fast and
# deterministic; the validator's `slowdown` summary runs the real module.
if [[ "$1" == */scripts/lib/runner-calibration.ts ]]; then
  if [[ "$2" == probe ]]; then
    if [[ -n "${STUB_PROBE_RECORD:-}" ]]; then
      printf '%s|%s\n' "$4" "$3" >> "$STUB_PROBE_RECORD"
    fi
    if [[ -n "${STUB_PROBE_EXIT:-}" ]]; then exit "$STUB_PROBE_EXIT"; fi
    printf '%s\t%s\t25\n' "$4" "${STUB_PROBE_MS:-10}" >> "$3"
    exit 0
  fi
  exec "$REAL_BUN" "$@"
fi
printf '%s\n' "$*" >> "$BUN_ARGS_FILE"
# Per-shard behaviour for parallel shard tests (#10644): the hook reads
# AUTOMOBILE_WATCHDOG_LABEL and may exit; otherwise the stub continues.
if [[ "$1" == test && -n "${STUB_SHARD_HOOK:-}" ]]; then
  # shellcheck source=/dev/null
  source "$STUB_SHARD_HOOK"
fi
# Per-invocation exit codes for `bun test` (shard retry tests run one worker,
# so invocations are sequential): "124 0" times out once, then passes.
if [[ "$1" == test && -n "${STUB_BUN_EXITS:-}" ]]; then
  attempt="$(grep -c '^test ' "$BUN_ARGS_FILE")"
  read -r -a stub_exits <<< "$STUB_BUN_EXITS"
  code="${stub_exits[$((attempt - 1))]:-0}"
  if [[ "$code" == sigkill ]]; then
    kill -KILL "$$"
  fi
  if [[ "$code" != 0 ]]; then
    echo "(fail) stub suite > slow test [5001.00ms]"
    if [[ -n "${STUB_STALE_REPORT_DIR:-}" ]]; then
      : > "$STUB_STALE_REPORT_DIR/shard-0-iso-1.xml"
      : > "$STUB_STALE_REPORT_DIR/shard-10.xml"
    fi
    exit "$code"
  fi
fi
if [[ "$1" == test && -n "${STUB_CHUNK_RECORD:-}" ]]; then
  printf '%s|%s|%s\n' "${AUTOMOBILE_TEST_MODE:-unset}" "${AUTOMOBILE_TEST_TIMING_LOG:-}" "${AUTOMOBILE_WATCHDOG_TIMING_LOG:-}" >> "$STUB_CHUNK_RECORD"
  for arg in "$@"; do
    if [[ "$arg" == *.test.ts ]]; then
      printf '{"event":"end","file":"%s","t":100,"elapsedMs":1,"rss":123}\n' "$arg" >> "$AUTOMOBILE_TEST_TIMING_LOG"
    fi
  done
  count="$(wc -l < "$STUB_CHUNK_RECORD" | tr -d ' ')"
  if [[ "$count" == "${STUB_CHUNK_FAIL:-}" ]]; then exit 7; fi
fi
if [[ "$1" == test && -n "${STUB_GROUP_LABEL_RECORD:-}" ]]; then
  printf '%s\n' "${AUTOMOBILE_TEST_TIMING_GROUP_LABEL:-none}" >> "$STUB_GROUP_LABEL_RECORD"
fi
if [[ "$1" == test && -n "${STUB_SHARED_FAIL:-}" && " $* " != *" --isolate "* ]]; then
  exit "$STUB_SHARED_FAIL"
fi
if [[ "$1" == test && -n "${STUB_BUN_TEST_MODE_FILE:-}" ]]; then
  printf '%s\n' "${AUTOMOBILE_TEST_MODE:-unset}" >> "$STUB_BUN_TEST_MODE_FILE"
fi
if [[ -n "${STUB_BUN_EXIT:-}" ]]; then exit "$STUB_BUN_EXIT"; fi
if [[ -n "${STUB_BUN_WALL_FILE:-}" ]]; then
  printf '%s\n' "${AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS:-unset}" >> "$STUB_BUN_WALL_FILE"
fi
if [[ -n "${STUB_BUN_SLEEP_SECONDS:-}" ]]; then
  sleep "$STUB_BUN_SLEEP_SECONDS"
fi
if [[ "$1" == test && -n "${STUB_SLOW_SHARD_LABEL:-}" && "${AUTOMOBILE_WATCHDOG_LABEL:-}" == "$STUB_SLOW_SHARD_LABEL" ]]; then
  if [[ -n "${STUB_FAKE_CLOCK_DIR:-}" ]]; then
    # Advance only this shard's fake clock; no real waiting.
    printf '%s\n' "$STUB_SLOW_SHARD_SECONDS" > "$STUB_FAKE_CLOCK_DIR/${AUTOMOBILE_WATCHDOG_LABEL// /_}"
  else
    sleep "$STUB_SLOW_SHARD_SECONDS"
  fi
fi
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
shard=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--reporter-outfile" ]]; then
    report="$2"
    shift 2
    continue
  fi
  case "$1" in
    --shard=*) shard="${1#--shard=}" ;;
    *.test.ts) target="$1" ;;
  esac
  shift
done
if [[ -n "$shard" && "$shard" == "${STUB_CHANGED_FAIL_SHARD:-}" ]]; then
  echo "simulated shard failure" >&2
  exit 7
fi
if [[ -n "$shard" && ( "$shard" == "${STUB_CHANGED_EMPTY_SHARD:-}" || "${STUB_CHANGED_EMPTY_SHARD:-}" == all ) ]]; then
  echo "Ran 0 tests across 0 files."
  exit 0
fi
if [[ -n "${STUB_PER_FILE_FAIL:-}" && "$target" == *.integration.test.ts ]]; then
  printf '%s exit=1\n' "$target" >> "$STUB_BUN_EXIT_FILE"
  exit 1
fi
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
if [[ "$target" == "test/server/proxyServerTransportFailure.integration.test.ts" && -n "${STUB_INTEGRATION_TRANSPORT_EXIT:-}" ]]; then
  exit "$STUB_INTEGRATION_TRANSPORT_EXIT"
fi
if [[ "$target" == ".integration.test.ts" && -n "${STUB_INTEGRATION_MAIN_EXIT:-}" ]]; then
  exit "$STUB_INTEGRATION_MAIN_EXIT"
fi
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

@test "Unix integration lane uses Bun isolation without a parallel worker" {
  run_lane integration
  [ "$status" -eq 0 ]
  [[ "$output" == *"--isolate"* ]]
  [[ "$output" != *"--parallel="* ]]
  [[ "$output" != *"test-ts: unit lane cores="* ]]
}

@test "integration lane isolates test files to prevent shared suite state" {
  run_lane integration --bail
  [ "$status" -eq 0 ]
  [[ "$output" == *"--isolate"* ]]
  [[ "$output" == *"test/server/proxyServerTransportFailure.integration.test.ts"* ]]
  [[ "$output" == *"--path-ignore-patterns"*"proxyServerTransportFailure.integration.test.ts"* ]]
  [[ "$output" == *".integration.test.ts"* ]]
  [ "$(grep -c -- '--bail' <<< "$output")" -eq 2 ]
}

@test "integration split combines reports from both processes" {
  local report
  report="$(mktemp)"
  run env PATH="$STUB_BIN:$PATH" bash "$SCRIPT" integration \
    --reporter junit --reporter-outfile "$report"
  [ "$status" -eq 0 ]
  [ "$(grep -c '<testsuite ' "$report")" -eq 2 ]
  [[ "$(cat "$report")" == *"proxyServerTransportFailure.integration.test.ts"* ]]
  [[ "$(cat "$report")" == *'tests="2"'* ]]
  rm -f "$report"
}

@test "integration split preserves both reports when the main process fails" {
  local report
  report="$(mktemp)"
  run env PATH="$STUB_BIN:$PATH" STUB_INTEGRATION_MAIN_EXIT=7 bash "$SCRIPT" integration \
    --reporter junit --reporter-outfile "$report"
  [ "$status" -eq 7 ]
  [ "$(grep -c '<testsuite ' "$report")" -eq 2 ]
  [[ "$(cat "$report")" == *"proxyServerTransportFailure.integration.test.ts"* ]]
  rm -f "$report"
}

@test "integration split continues after transport failure unless bail is requested" {
  local report
  report="$(mktemp)"
  run env PATH="$STUB_BIN:$PATH" STUB_INTEGRATION_TRANSPORT_EXIT=7 \
    bash "$SCRIPT" integration --reporter junit --reporter-outfile "$report"
  [ "$status" -eq 7 ]
  [ "$(grep -c '<testsuite ' "$report")" -eq 2 ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 2 ]
  rm -f "$report"

  report="$(mktemp)"
  : > "$BUN_ARGS_FILE"
  run env PATH="$STUB_BIN:$PATH" STUB_INTEGRATION_TRANSPORT_EXIT=7 \
    bash "$SCRIPT" integration --bail --reporter junit --reporter-outfile "$report"
  [ "$status" -eq 7 ]
  [ "$(grep -c '<testsuite ' "$report")" -eq 1 ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 1 ]
  rm -f "$report"
}

@test "integration split continues after one transport failure with a numeric bail budget" {
  local bail_args report
  for bail_args in "--bail=2" "--bail 2"; do
    report="$(mktemp)"
    : > "$BUN_ARGS_FILE"
    # Shell splitting intentionally exercises both supported argument forms.
    # shellcheck disable=SC2086
    run env PATH="$STUB_BIN:$PATH" STUB_INTEGRATION_TRANSPORT_EXIT=7 \
      bash "$SCRIPT" integration $bail_args --reporter junit --reporter-outfile "$report"
    [ "$status" -eq 7 ]
    [ "$(grep -c '<testsuite ' "$report")" -eq 2 ]
    [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 2 ]
    rm -f "$report"
  done
}

@test "per-file integration mode rejects a numeric bail budget shared across files" {
  local bail_args
  export STUB_BUN_EXIT_FILE="$STUB_BIN/bun-exits.log"
  for bail_args in "--bail=2" "--bail 2"; do
    : > "$BUN_ARGS_FILE"
    : > "$STUB_BUN_EXIT_FILE"
    # Shell splitting intentionally exercises both supported argument forms.
    # shellcheck disable=SC2086
    run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_MODE=true STUB_PER_FILE_FAIL=1 \
      bash "$SCRIPT" integration $bail_args \
      test/server/deviceLabelSessionReleaseOrdering.integration.test.ts \
      test/server/proxyServerTransportFailure.integration.test.ts \
      test/server/toolRegistration.integration.test.ts
    [ "$status" -eq 2 ]
    [[ "$output" == *"--bail=2 cannot be used with AUTOMOBILE_TEST_MODE=true"* ]]
    [ ! -s "$BUN_ARGS_FILE" ]
    [ ! -s "$STUB_BUN_EXIT_FILE" ]
  done
}

@test "per-file integration mode rejects leading zero and oversized numeric bail budgets" {
  local bail_count
  for bail_count in 08 0002 99999999999999999999999; do
    : > "$BUN_ARGS_FILE"
    run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_MODE=true \
      bash "$SCRIPT" integration "--bail=$bail_count"
    printf 'bail=%s status=%s output=%s\n' "$bail_count" "$status" "$output"
    [ "$status" -eq 2 ]
    [[ "$output" == *"--bail=$bail_count cannot be used with AUTOMOBILE_TEST_MODE=true"* ]]
    [ ! -s "$BUN_ARGS_FILE" ]
  done
}

@test "per-file integration mode allows zero and one bail budgets" {
  local bail_count
  for bail_count in 0 1 01 00; do
    : > "$BUN_ARGS_FILE"
    run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_MODE=true \
      bash "$SCRIPT" integration "--bail=$bail_count" \
      test/server/deviceLabelSessionReleaseOrdering.integration.test.ts \
      test/server/proxyServerTransportFailure.integration.test.ts \
      test/server/toolRegistration.integration.test.ts
    printf 'bail=%s status=%s output=%s\n' "$bail_count" "$status" "$output"
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 3 ]
    [[ "$(cat "$BUN_ARGS_FILE")" == *"--bail=$bail_count"* ]]
  done
}

@test "integration coverage retains one process and its complete LCOV output" {
  run_lane integration --coverage --coverage-reporter lcov --coverage-dir scratch/integration-coverage
  [ "$status" -eq 0 ]
  [ "$(grep -c 'bun test' <<< "$output")" -eq 1 ]
  [[ "$output" == *"--coverage --coverage-reporter lcov --coverage-dir scratch/integration-coverage"* ]]
}

@test "long-lived integration modes keep every file in one process" {
  local mode
  for mode in --watch --hot --inspect-wait --inspect-brk --inspect-wait=127.0.0.1:6499 --inspect-brk=127.0.0.1:6499; do
    run_lane integration "$mode"
    [ "$status" -eq 0 ]
    [ "$(grep -c 'bun test' <<< "$output")" -eq 1 ]
    [[ "$output" == *".integration.test.ts"* ]]
  done
}

@test "targeted transport suite stays isolated and capped when selected with other files" {
  local timeout_args
  timeout_args="$(mktemp)"
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TIMEOUT_ARGS_FILE"
shift 3
exec "$@"
EOF
  chmod +x "$STUB_BIN/timeout"
  run env PATH="$STUB_BIN:$PATH" TIMEOUT_ARGS_FILE="$timeout_args" \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=900 bash "$SCRIPT" integration \
    test/server/proxyServerTransportFailure.integration.test.ts \
    test/server/deviceLabelSessionReleaseOrdering.integration.test.ts
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 2 ]
  [[ "$(head -n 1 "$timeout_args")" == "-k 2 60 "* ]]
  [[ "$(tail -n 1 "$BUN_ARGS_FILE")" == *"deviceLabelSessionReleaseOrdering.integration.test.ts"* ]]
  [[ "$(tail -n 1 "$BUN_ARGS_FILE")" != *"proxyServerTransportFailure.integration.test.ts"* ]]
  : > "$BUN_ARGS_FILE"
  : > "$timeout_args"
  run env PATH="$STUB_BIN:$PATH" TIMEOUT_ARGS_FILE="$timeout_args" \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=900 bash "$SCRIPT" integration \
    test/server/proxyServerTransportFailure.integration.test.ts
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 1 ]
  [[ "$(head -n 1 "$timeout_args")" == "-k 2 60 "* ]]
  rm -f "$timeout_args"
}

@test "integration split reports a main watchdog timeout ahead of a transport failure" {
  local report
  report="$(mktemp)"
  run env PATH="$STUB_BIN:$PATH" STUB_INTEGRATION_TRANSPORT_EXIT=7 \
    STUB_INTEGRATION_MAIN_EXIT=124 bash "$SCRIPT" integration \
    --reporter junit --reporter-outfile "$report"
  [ "$status" -eq 124 ]
  [ "$(grep -c '<testsuite ' "$report")" -eq 2 ]
  rm -f "$report"
}

@test "integration split respects a shorter caller wall timeout" {
  local timeout_args
  timeout_args="$(mktemp)"
  cat > "$STUB_BIN/date" <<'EOF'
#!/usr/bin/env bash
printf '100\n'
EOF
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TIMEOUT_ARGS_FILE"
shift 3
exec "$@"
EOF
  chmod +x "$STUB_BIN/date" "$STUB_BIN/timeout"
  run env PATH="$STUB_BIN:$PATH" TIMEOUT_ARGS_FILE="$timeout_args" \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=1 bash "$SCRIPT" integration
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$timeout_args")" -eq 2 ]
  [[ "$(head -n 1 "$timeout_args")" == "-k 2 1 "* ]]
  rm -f "$timeout_args"
}

@test "integration split passes only the remaining wall time to the main process" {
  local timeout_args clock_calls
  timeout_args="$(mktemp)"
  clock_calls="$(mktemp)"
  printf '0' > "$clock_calls"
  cat > "$STUB_BIN/date" <<'EOF'
#!/usr/bin/env bash
calls="$(cat "$CLOCK_CALLS_FILE")"
printf '%s' "$((calls + 1))" > "$CLOCK_CALLS_FILE"
if ((calls < 2)); then printf '100\n'; else printf '105\n'; fi
EOF
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TIMEOUT_ARGS_FILE"
shift 3
exec "$@"
EOF
  chmod +x "$STUB_BIN/date" "$STUB_BIN/timeout"
  run env PATH="$STUB_BIN:$PATH" CLOCK_CALLS_FILE="$clock_calls" \
    TIMEOUT_ARGS_FILE="$timeout_args" AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=60 \
    bash "$SCRIPT" integration
  [ "$status" -eq 0 ]
  [[ "$(head -n 1 "$timeout_args")" == "-k 2 60 "* ]]
  [[ "$(tail -n 1 "$timeout_args")" == "-k 2 55 "* ]]
  rm -f "$timeout_args" "$clock_calls"
}

@test "Windows integration lane retains one process without a POSIX watchdog" {
  run env RUNNER_OS=Windows PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 bash "$SCRIPT" integration
  [ "$status" -eq 0 ]
  [ "$(grep -c '^bun test' <<< "$output")" -eq 1 ]
  [[ "$output" != *"--path-ignore-patterns"* ]]
}

@test "macOS defaults to two unit shards on three cores" {
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 \
    UNAME_S=Darwin STUB_NPROC_CORES=3 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"--shards=2"* ]]
}

@test "macOS CI runner defaults to three unit workers regardless of core count" {
  for core_count in 3 4 12; do
    run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 RUNNER_OS=macOS \
      UNAME_S=Darwin STUB_NPROC_CORES="$core_count" bash "$SCRIPT" unit
    [ "$status" -eq 0 ]
    [[ "$output" == *"test-ts: unit lane cores=$core_count workers=3"* ]]
    [[ "$output" == *"--shards=3"* ]]
  done
}

@test "explicit worker count overrides the macOS CI runner default" {
  run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 RUNNER_OS=macOS \
    UNAME_S=Darwin STUB_NPROC_CORES=12 AUTOMOBILE_UNIT_TEST_WORKERS=5 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"workers=5"* ]]
}

@test "Linux CI runner keeps the core-based unit worker default" {
  run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 RUNNER_OS=Linux \
    UNAME_S=Linux STUB_NPROC_CORES=12 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"workers=10"* ]]
}

@test "Linux uses two unit shards on three cores" {
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 \
    UNAME_S=Linux STUB_NPROC_CORES=3 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"test-ts: unit lane cores=3 workers=2"* ]]
  [[ "$output" == *"--shards=2"* ]]
}

@test "unit lane worker selection covers small and larger hosts through nproc and sysctl" {
  local core_count worker_count probe
  for probe in nproc sysctl; do
    for core_count in 2 3 4 8 12; do
      case "$core_count" in
        2 | 3) worker_count=2 ;;
        4) worker_count=3 ;;
        8) worker_count=6 ;;
        12) worker_count=10 ;;
      esac
      if [[ "$probe" == sysctl ]]; then
        run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 \
          STUB_NPROC_FAIL=1 STUB_SYSCTL_CORES="$core_count" UNAME_S=Darwin bash "$SCRIPT" unit
      else
        run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 \
          STUB_NPROC_CORES="$core_count" UNAME_S=Linux bash "$SCRIPT" unit
      fi
      [ "$status" -eq 0 ]
      [[ "$output" == *"test-ts: unit lane cores=$core_count workers=$worker_count"* ]]
      [[ "$output" == *"test-ts: unit lane logical_cores=$core_count physical_cores=4 workers=$worker_count shards=$worker_count"* ]]
      [[ "$output" == *"--shards=$worker_count"* ]]
      [ "$(grep -c 'test-ts: unit lane cores=' <<< "$output")" -eq 1 ]
    done
  done
}

@test "unit shards report wall time and status on success and timeout" {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"test-ts: unit lane cores="*" workers=2"* ]]
  [[ "$output" == *"test-ts: unit shard 1/2 wall="*"s status=0"* ]]
  [[ "$output" == *"test-ts: unit shard 2/2 wall="*"s status=0"* ]]
  [[ "$output" == *"test-ts: unit shards total wall="*"s status=0"* ]]

  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 STUB_BUN_EXIT=124 \
    bash "$SCRIPT" unit
  [ "$status" -eq 124 ]
  [[ "$output" == *"TIMEOUT: unit shard"* ]]
  [[ "$output" == *"test-ts: unit shard 1/2 wall="*"s status=124"* ]]
  [[ "$output" == *"test-ts: unit shard 2/2 wall="*"s status=124"* ]]
  [[ "$output" == *"test-ts: unit shards total wall="*"s status=124"* ]]

  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 STUB_BUN_EXIT=7 \
    bash "$SCRIPT" unit
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: unit shard"* ]]
  [[ "$output" == *"test-ts: unit shard 1/2 wall="*"s status=7"* ]]
  [[ "$output" == *"test-ts: unit shard 2/2 wall="*"s status=7"* ]]
  [[ "$output" == *"test-ts: unit shards total wall="*"s status=1"* ]]
}

# Shard retry on infra exits (#10583). One worker keeps invocations sequential.
run_retry_lane() {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 "$@" bash "$SCRIPT" unit
}

bun_test_invocations() {
  grep -c '^test ' "$BUN_ARGS_FILE" || true
}

@test "a shard that hits its wall budget is retried once and can pass" {
  report_dir="$BATS_TEST_TMPDIR/unit-reports"
  run_retry_lane STUB_BUN_EXITS="124 0" AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir"
  [ "$status" -eq 0 ]
  [ "$(bun_test_invocations)" -eq 2 ]
  [[ "$output" == *"RETRY: unit shard 0 hit its 180s wall-clock budget (exit 124) after "*"retrying once with the same budget (attempt 1 logged 1 failing test line(s)"* ]]
  [[ "$output" == *"test-ts: unit shard 0 passed on its retry"* ]]
  [[ "$output" == *"test-ts: unit shard 1/1 wall="*"s status=0 attempts=2"* ]]
  [[ "$output" == *"test-ts: unit shards total wall="*"s status=0 retried=1"* ]]
  [[ "$output" == *"==> TypeScript unit shard 1/1 (attempt 1 of 2, retried)"* ]]
  [ -f scratch/test-ts-unit-shards/shard-0.attempt-1.log ]
  [ -s "$report_dir/shard-0.xml" ]
}

@test "a shard retry deletes that shard's stale reports but not another shard's" {
  report_dir="$BATS_TEST_TMPDIR/unit-reports"
  run_retry_lane STUB_BUN_EXITS="124 0" STUB_STALE_REPORT_DIR="$report_dir" \
    AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir"
  [ "$status" -eq 0 ]
  [ ! -e "$report_dir/shard-0-iso-1.xml" ]
  [ -e "$report_dir/shard-10.xml" ]
  [ -s "$report_dir/shard-0.xml" ]
}

@test "a shard that times out twice fails the lane with 124 after exactly one retry" {
  run_retry_lane STUB_BUN_EXITS="124 124 0"
  [ "$status" -eq 124 ]
  [ "$(bun_test_invocations)" -eq 2 ]
  [[ "$output" == *"TIMEOUT: unit shard 0 exceeded its wall-clock budget after a retry"* ]]
  [[ "$output" == *"status=124 attempts=2"* ]]
}

@test "a shard killed by a signal is retried once" {
  run_retry_lane STUB_BUN_EXITS="sigkill 0"
  [ "$status" -eq 0 ]
  [ "$(bun_test_invocations)" -eq 2 ]
  [[ "$output" == *"RETRY: unit shard 0 was killed by signal 9 (exit 137) after "* ]]

  : > "$BUN_ARGS_FILE"
  run_retry_lane STUB_BUN_EXITS="143 143"
  [ "$status" -eq 1 ]
  [ "$(bun_test_invocations)" -eq 2 ]
  [[ "$output" == *"FAIL: unit shard 0 exited with status 143 after a retry"* ]]
}

@test "an ordinary test failure is never retried" {
  run_retry_lane STUB_BUN_EXITS="1 0"
  [ "$status" -eq 1 ]
  [ "$(bun_test_invocations)" -eq 1 ]
  [[ "$output" != *"RETRY:"* ]]
  [[ "$output" == *"FAIL: unit shard 0 exited with status 1"* ]]
  [[ "$output" != *"after a retry"* ]]
  [[ "$output" == *"retried=0"* ]]
}

@test "a shard retry emits a GitHub warning annotation and a step summary line only under Actions" {
  summary="$BATS_TEST_TMPDIR/step-summary.md"
  run_retry_lane STUB_BUN_EXITS="124 0" GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$summary"
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning title=Unit shard retried (infra exit)::unit shard 0 hit its 180s wall-clock budget (exit 124)"* ]]
  grep -q 'Unit shard 0 hit its 180s wall-clock budget (exit 124).*retried once' "$summary"

  : > "$BUN_ARGS_FILE"
  run env -u GITHUB_ACTIONS -u GITHUB_STEP_SUMMARY PATH="$STUB_BIN:$PATH" \
    AUTOMOBILE_UNIT_TEST_WORKERS=1 STUB_BUN_EXITS="124 0" bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" != *"::warning"* ]]
}

@test "shard retry can be disabled and rejects values other than 0 or 1" {
  run_retry_lane STUB_BUN_EXITS="124 0" AUTOMOBILE_UNIT_SHARD_RETRIES=0
  [ "$status" -eq 124 ]
  [ "$(bun_test_invocations)" -eq 1 ]
  [[ "$output" != *"RETRY:"* ]]

  : > "$BUN_ARGS_FILE"
  run_retry_lane AUTOMOBILE_UNIT_SHARD_RETRIES=2
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_UNIT_SHARD_RETRIES must be 0 or 1, got: 2"* ]]
  [ "$(bun_test_invocations)" -eq 0 ]
}

@test "a retry that would pass the lane cap is skipped and the lane fails" {
  # 180s budget + 60s overhead cannot fit a 200s lane cap.
  run_retry_lane STUB_BUN_EXITS="124 0" AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS=200
  [ "$status" -eq 124 ]
  [ "$(bun_test_invocations)" -eq 1 ]
  [[ "$output" == *"test-ts: not retrying unit shard 0 (status 124): a 180s retry at "*"s elapsed would pass the 200s lane cap"* ]]

  : > "$BUN_ARGS_FILE"
  run_retry_lane AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS=soon
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS must be a positive integer"* ]]
}

# Completion-order reaping (#10644). Three parallel shards: shard 0 is slow
# (it waits on a file another shard writes, bounded so a regression fails
# instead of hanging) and shard 2's first attempt exits fast.
write_completion_order_hook() {
  cat > "$1" <<'EOF'
stub_mark="$STUB_HOOK_DIR/${AUTOMOBILE_WATCHDOG_LABEL// /_}"
echo x >> "$stub_mark.attempts"
stub_attempt="$(wc -l < "$stub_mark.attempts" | tr -d ' ')"
stub_wait_for() {
  local tries=0
  while [[ ! -e "$1" ]]; do
    tries=$((tries + 1))
    if [[ "$tries" -gt 150 ]]; then return 1; fi
    sleep 0.02
  done
}
case "$AUTOMOBILE_WATCHDOG_LABEL" in
  "unit shard 0")
    if stub_wait_for "$STUB_HOOK_DIR/${STUB_SLOW_WAITS_FOR:-shard2-retry-started}"; then
      echo saw-gate > "$STUB_HOOK_DIR/shard0-result"
    else
      echo gate-missing > "$STUB_HOOK_DIR/shard0-result"
    fi
    exit "${STUB_SLOW_EXIT:-0}"
    ;;
  "unit shard 2")
    if [[ "$stub_attempt" -eq 1 ]]; then
      if [[ -n "${STUB_FAST_CLOCK:-}" ]]; then
        printf '%s\n' "$STUB_FAST_CLOCK" > "$STUB_HOOK_DIR/clock"
      fi
      echo "(fail) stub suite > slow test [5001.00ms]"
      touch "$STUB_HOOK_DIR/shard2-attempt1-done"
      exit "${STUB_FAST_EXIT:-124}"
    fi
    touch "$STUB_HOOK_DIR/shard2-retry-started"
    exit 0
    ;;
esac
EOF
}

# Usage: run_completion_order_lane [ENV=VALUE]...; uses $hook and $hook_dir.
run_completion_order_lane() {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=3 \
    AUTOMOBILE_UNIT_SHARD_POLL_SECONDS=0.02 \
    STUB_SHARD_HOOK="$hook" STUB_HOOK_DIR="$hook_dir" "$@" bash "$SCRIPT" unit
}

reset_completion_order_hook() {
  hook_dir="$BATS_TEST_TMPDIR/hook"
  hook="$BATS_TEST_TMPDIR/hook.sh"
  rm -rf "$hook_dir"
  mkdir -p "$hook_dir"
  write_completion_order_hook "$hook"
  : > "$BUN_ARGS_FILE"
}

@test "a fast-failing later shard is retried before a slow earlier shard finishes (#10644)" {
  reset_completion_order_hook
  run_completion_order_lane
  [ "$status" -eq 0 ]
  # Shard 0 was still running when shard 2's retry started; index-order
  # reaping would leave shard 0 waiting until its bounded wait gave up.
  [ "$(cat "$hook_dir/shard0-result")" = saw-gate ]
  [ "$(wc -l < "$hook_dir/unit_shard_2.attempts" | tr -d ' ')" -eq 2 ]
  [ "$(wc -l < "$hook_dir/unit_shard_0.attempts" | tr -d ' ')" -eq 1 ]
  [[ "$output" == *"RETRY: unit shard 2 hit its 180s wall-clock budget (exit 124)"* ]]
  [[ "$output" == *"test-ts: unit shard 2 passed on its retry"* ]]
  [[ "$output" == *"test-ts: unit shard 1/3 wall="*"s status=0"* ]]
  [[ "$output" == *"test-ts: unit shard 3/3 wall="*"s status=0 attempts=2"* ]]
  [[ "$output" == *"test-ts: unit shards total wall="*"s status=0 retried=1"* ]]
  [ -f scratch/test-ts-unit-shards/shard-2.attempt-1.log ]
  [ -s scratch/test-ts-unit-shards/shard-0.wall ]
  [ -s scratch/test-ts-unit-shards/shard-2.wall ]
}

@test "completion-order reaping judges the lane cap at each shard's own reap time (#10644)" {
  reset_completion_order_hook
  # Fake lane clock: base 1000 plus whatever the hook last wrote to `clock`.
  cat > "$STUB_BIN/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" != "+%s" ]]; then exec /bin/date "$@"; fi
offset=0
if [[ -f "$STUB_HOOK_DIR/clock" ]]; then offset="$(cat "$STUB_HOOK_DIR/clock")"; fi
printf '%s\n' "$((1000 + offset))"
EOF
  chmod +x "$STUB_BIN/date"

  # A retry needs 180s budget + 60s overhead; at 0s elapsed it fits a 245s cap.
  run_completion_order_lane AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS=245
  [ "$status" -eq 0 ]
  [ "$(cat "$hook_dir/shard0-result")" = saw-gate ]
  [[ "$output" == *"test-ts: unit shard 2 passed on its retry"* ]]

  # Shard 2 ends at 10s elapsed: 10 + 180 + 60 > 245, so no retry, and the
  # slow shard 0 is still reaped and reported.
  reset_completion_order_hook
  run_completion_order_lane AUTOMOBILE_UNIT_LANE_WALL_TIMEOUT_SECONDS=245 \
    STUB_FAST_CLOCK=10 STUB_SLOW_WAITS_FOR=shard2-attempt1-done
  [ "$status" -eq 124 ]
  [[ "$output" == *"test-ts: not retrying unit shard 2 (status 124): a 180s retry at 10s elapsed would pass the 245s lane cap"* ]]
  [[ "$output" != *"RETRY:"* ]]
  [ "$(wc -l < "$hook_dir/unit_shard_2.attempts" | tr -d ' ')" -eq 1 ]
  [ "$(cat "$hook_dir/shard0-result")" = saw-gate ]
  [[ "$output" == *"test-ts: unit shard 1/3 wall="*"s status=0"* ]]
  [[ "$output" == *"test-ts: unit shard 3/3 wall="*"s status=124"* ]]
  [[ "$output" == *"test-ts: unit shards total wall="*"s status=124 retried=0"* ]]
}

@test "completion-order reaping keeps the lane exit status independent of finish order (#10644)" {
  # A fast ordinary failure, then a slow timeout: 124 wins and both are named.
  reset_completion_order_hook
  run_completion_order_lane AUTOMOBILE_UNIT_SHARD_RETRIES=0 \
    STUB_FAST_EXIT=7 STUB_SLOW_EXIT=124 STUB_SLOW_WAITS_FOR=shard2-attempt1-done
  [ "$status" -eq 124 ]
  [ "$(cat "$hook_dir/shard0-result")" = saw-gate ]
  [[ "$output" == *"FAIL: unit shard 2 exited with status 7"* ]]
  [[ "$output" == *"TIMEOUT: unit shard 0 exceeded its wall-clock budget"* ]]
  [[ "$output" == *"test-ts: unit shards total wall="*"s status=124 retried=0"* ]]

  # A fast timeout, then a slow ordinary failure: still 124.
  reset_completion_order_hook
  run_completion_order_lane AUTOMOBILE_UNIT_SHARD_RETRIES=0 \
    STUB_FAST_EXIT=124 STUB_SLOW_EXIT=7 STUB_SLOW_WAITS_FOR=shard2-attempt1-done
  [ "$status" -eq 124 ]
  [[ "$output" == *"TIMEOUT: unit shard 2 exceeded its wall-clock budget"* ]]
  [[ "$output" == *"FAIL: unit shard 0 exited with status 7"* ]]

  # Only ordinary failures: 1, and neither is retried.
  reset_completion_order_hook
  run_completion_order_lane STUB_FAST_EXIT=7 STUB_SLOW_EXIT=3 \
    STUB_SLOW_WAITS_FOR=shard2-attempt1-done
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: unit shard 2 exited with status 7"* ]]
  [[ "$output" == *"FAIL: unit shard 0 exited with status 3"* ]]
  [[ "$output" != *"RETRY:"* ]]
}

@test "the shard reap poll interval rejects non-positive values" {
  for interval in 0 0.0 soon; do
    : > "$BUN_ARGS_FILE"
    run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
      AUTOMOBILE_UNIT_SHARD_POLL_SECONDS="$interval" bash "$SCRIPT" unit
    [ "$status" -eq 2 ]
    [[ "$output" == *"AUTOMOBILE_UNIT_SHARD_POLL_SECONDS must be a positive number of seconds, got: $interval"* ]]
    [ "$(bun_test_invocations)" -eq 0 ]
  done
}

@test "unit shards run the calibration probe at start and end of every attempt next to the JUnit reports" {
  report_dir="$BATS_TEST_TMPDIR/unit-reports"
  probes="$BATS_TEST_TMPDIR/probes"
  run_retry_lane STUB_BUN_EXITS="124 0" STUB_PROBE_RECORD="$probes" \
    AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir"
  [ "$status" -eq 0 ]
  [ "$(cat "$probes")" = "unit shard 0 attempt 1 start|$report_dir/calibration-unit-shard-0.tsv
unit shard 0 attempt 1 end|$report_dir/calibration-unit-shard-0.tsv
unit shard 0 attempt 2 start|$report_dir/calibration-unit-shard-0.tsv
unit shard 0 attempt 2 end|$report_dir/calibration-unit-shard-0.tsv" ]
  [ "$(wc -l < "$report_dir/calibration-unit-shard-0.tsv" | tr -d ' ')" -eq 4 ]
}

@test "the calibration probe is skippable and its failure never fails a shard" {
  probes="$BATS_TEST_TMPDIR/probes"
  run_retry_lane STUB_PROBE_RECORD="$probes" AUTOMOBILE_RUNNER_CALIBRATION=0
  [ "$status" -eq 0 ]
  [ ! -e "$probes" ]
  [ ! -e scratch/test-ts-unit-shards/calibration-unit-shard-0.tsv ]

  run_retry_lane STUB_PROBE_EXIT=3
  [ "$status" -eq 0 ]
  [[ "$output" == *"runner calibration probe failed (unit shard 0 attempt 1 start); continuing without this sample"* ]]
}

@test "unit shard wall time is each shard's own duration, not its reap time (#10583)" {
  # Deterministic per-shard clock: `date +%s` is a fixed base plus the offset the
  # stub bun wrote for the calling shard's label, so nothing really sleeps.
  local clock_dir
  clock_dir="$(mktemp -d)"
  cat > "$STUB_BIN/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" != "+%s" ]]; then exec /bin/date "$@"; fi
offset=0
label_file="$STUB_FAKE_CLOCK_DIR/${AUTOMOBILE_WATCHDOG_LABEL// /_}"
if [[ -n "${AUTOMOBILE_WATCHDOG_LABEL:-}" && -f "$label_file" ]]; then
  offset="$(cat "$label_file")"
fi
printf '%s\n' "$((1000 + offset))"
EOF
  chmod +x "$STUB_BIN/date"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    STUB_FAKE_CLOCK_DIR="$clock_dir" \
    STUB_SLOW_SHARD_LABEL="unit shard 0" STUB_SLOW_SHARD_SECONDS=2 \
    bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [ -s scratch/test-ts-unit-shards/shard-0.wall ]
  [ -s scratch/test-ts-unit-shards/shard-1.wall ]
  slow="$(sed -nE 's/^test-ts: unit shard 1\/2 wall=([0-9]+)s status=0$/\1/p' <<< "$output")"
  fast="$(sed -nE 's/^test-ts: unit shard 2\/2 wall=([0-9]+)s status=0$/\1/p' <<< "$output")"
  [ "$slow" -ge 2 ]
  # Shard 2 is reaped after shard 1, so the old reap-time clock reported >= 2s here.
  [ "$fast" -le 1 ]
}

@test "explicit unit worker count bypasses the macOS floor" {
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 \
    UNAME_S=Darwin STUB_NPROC_CORES=3 AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"test-ts: unit lane cores=3 workers=1"* ]]
  [[ "$output" == *"--shards=1"* ]]
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
  run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 \
    AUTOMOBILE_UNIT_TEST_WORKERS=3 bash "$SCRIPT" changed
  [ "$status" -eq 0 ]
  [[ "$output" != *"test-ts: unit lane cores="* ]]
  [ "$(printf '%s\n' "$output" | grep -c -- '--changed=origin/main')" -eq 3 ]
  for shard in 1 2 3; do
    [[ "$output" == *"--shard=$shard/3"* ]]
  done
}

@test "changed shards use a per-shard 180s budget and write separate JUnit reports" {
  report_dir="$BATS_TEST_TMPDIR/changed-reports"
  wall_file="$BATS_TEST_TMPDIR/wall-budgets"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" STUB_BUN_WALL_FILE="$wall_file" \
    bash "$SCRIPT" changed
  [ "$status" -eq 0 ]
  [ -s "$report_dir/changed-shard-1.xml" ]
  [ -s "$report_dir/changed-shard-2.xml" ]
  [ -f scratch/test-ts-changed-shards/shard-0.log ]
  grep -q -- '--changed=origin/main --shard=1/2' "$BUN_ARGS_FILE"
  [ "$(grep -c '^180$' "$wall_file")" -eq 2 ]
}

@test "changed lane names a failing shard" {
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    STUB_CHANGED_FAIL_SHARD=2/2 bash "$SCRIPT" changed
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: changed shard 2 exited with status 7"* ]]
}

@test "changed lane accepts a shard with no selected files" {
  report_dir="$BATS_TEST_TMPDIR/changed-reports"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    STUB_CHANGED_EMPTY_SHARD=2/2 AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir" \
    bash "$SCRIPT" changed
  [ "$status" -eq 0 ]
  [ -s "$report_dir/changed-shard-1.xml" ]
  [ ! -e "$report_dir/changed-shard-2.xml" ]
}

@test "changed lane keeps explicit paths and passthrough args in one process" {
  run_lane changed test/features/device/SetPosture.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *"test/features/device/SetPosture.test.ts"* ]]
  [[ "$output" != *"--shard="* ]]
  [ "$(printf '%s\n' "$output" | grep -c -- '--changed=origin/main')" -eq 1 ]
  run_lane changed --bail
  [ "$status" -eq 0 ]
  [[ "$output" != *"--shard="* ]]
}

@test "Windows changed lane remains one process" {
  run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 RUNNER_OS=Windows \
    bash "$SCRIPT" changed
  [ "$status" -eq 0 ]
  [[ "$output" == *"--changed=origin/main"* ]]
  [[ "$output" != *"--shard="* ]]
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
  [[ "$output" != *"--parallel="* ]]
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
  [ "$(grep -c '^bun test' <<< "$output")" -eq 4 ]
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

@test "coverage prints one chunked invocation per default shard over an explicit file list" {
  stub_chunk_discovery
  run_lane coverage
  [ "$status" -eq 0 ]
  # Two shard processes by default, never the four of the failed #10213 attempt.
  [ "$(wc -l <<< "$output" | tr -d ' ')" -eq 2 ]
  # Chunker args: root, OS, chunk size (50), no JUnit dir (printed as ''), 1-based shard.
  empty="''"
  [[ "$(sed -n 1p <<< "$output")" == *" 50 ${empty} 1 "* ]]
  [[ "$(sed -n 2p <<< "$output")" == *" 50 ${empty} 2 "* ]]
  [[ "$output" == *"bun-unit-chunks.sh"* ]]
  [[ "$output" == *" -- test/fixture00.test.ts test/fixture02.test.ts "* ]]
  [[ "$output" == *" -- test/fixture01.test.ts test/fixture03.test.ts "* ]]
}

@test "coverage chunk and shard sizes are configurable and validated before Bun" {
  stub_chunk_discovery
  run env PATH="$STUB_BIN:$PATH" TEST_TS_PRINT_CMD=1 AUTOMOBILE_COVERAGE_SHARDS=3 \
    AUTOMOBILE_COVERAGE_CHUNK_FILES=7 bash "$SCRIPT" coverage
  [ "$status" -eq 0 ]
  [ "$(wc -l <<< "$output" | tr -d ' ')" -eq 3 ]
  empty="''"
  [[ "$output" == *" 7 ${empty} 3 "* ]]

  for value in '' abc 1.5 0 -1 05; do
    run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_COVERAGE_CHUNK_FILES="$value" bash "$SCRIPT" coverage
    [ "$status" -eq 2 ]
    [[ "$output" == *"AUTOMOBILE_COVERAGE_CHUNK_FILES must be a positive integer"* ]]
  done
}

@test "coverage wall timeout is 720 seconds" {
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$BATS_TEST_TMPDIR/timeout-args"
exit 124
EOF
  chmod +x "$STUB_BIN/timeout"

  run env -u AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS PATH="$STUB_BIN:$PATH" bash "$SCRIPT" coverage
  [ "$status" -eq 124 ]
  grep -q -- '-k 2 720 ' "$BATS_TEST_TMPDIR/timeout-args"

  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=33 bash "$SCRIPT" coverage
  [ "$status" -eq 124 ]
  grep -q -- '-k 2 33 ' "$BATS_TEST_TMPDIR/timeout-args"
}

@test "coverage wall timeout prints a diagnostic on deadline" {
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
exit 124
EOF
  chmod +x "$STUB_BIN/timeout"

  run env PATH="$STUB_BIN:$PATH" bash "$SCRIPT" coverage
  [ "$status" -eq 124 ]
  [[ "$output" == *"Coverage test run exceeded its 720s wall-clock budget"* ]]
  [[ "$output" == *"shard 1/2"* ]]
}

@test "unit shards force the portable watchdog, capture a snapshot, and preserve exit 124" {
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
exit 77
EOF
  chmod +x "$STUB_BIN/timeout"

  # Retry disabled: this pins one watchdog firing, not the retry policy.
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    STUB_BUN_SLEEP_SECONDS=5 AUTOMOBILE_UNIT_SHARD_RETRIES=0 \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=1 bash "$SCRIPT" unit
  [ "$status" -eq 124 ]
  [ -s "scratch/test-ts-unit-shards/watchdog-shard-0.txt" ]
  [[ "$output" == *"TIMEOUT: unit shard 0 exceeded its wall-clock budget"* ]]
}

@test "wall timeout diagnostics are portable for coverage and stress modes" {
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
exit 124
EOF
  chmod +x "$STUB_BIN/timeout"

  for mode in coverage stress; do
    case "$mode" in
      coverage) label="Coverage"; expected_budget=720 ;;
      stress) label="Stress"; expected_budget=300 ;;
    esac
    run env PATH="$STUB_BIN:$PATH" bash "$SCRIPT" "$mode"
    [ "$status" -eq 124 ]
    [[ "$output" != *"bad substitution"* ]]
    [[ "$output" == *"${label} test run exceeded its ${expected_budget}s wall-clock budget"* ]]
  done
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
  grep -q -- "--shard=3/3" "$BUN_ARGS_FILE"
}

@test "timing gate treats grouping runners and the shared-process allowlist as lane inputs" {
  for input in scripts/lib/bun-unit-groups.sh scripts/lib/bun-unit-chunks.sh \
    scripts/test/classify-shared-safe.ts test/shared-process-allowlist.txt; do
    : > "$BUN_ARGS_FILE"
    run env \
      PATH="$STUB_BIN:$PATH" \
      BUN_TEST_TIMING_BASE_REF=origin/main \
      TIMING_CHANGED_FILES="$input\n" \
      bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
    [ "$status" -eq 0 ]
    [[ "$output" == *"measuring Bun-affected unit tests"* ]]
  done
}

@test "timing gate accepts successful empty changed shards without JUnit files" {
  run env PATH="$STUB_BIN:$PATH" BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES='src/example.ts\n' AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    STUB_CHANGED_EMPTY_SHARD=all bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/empty-timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No changed unit tests to validate"* ]]
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
  grep -q -- "--shard=3/3" "$BUN_ARGS_FILE"
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
    bash -c '
      if [[ "$3" == closed ]]; then
        exec 1>&-
        # Pin the stock macOS Bash 3.2 and the no-coreutils timeout path.
        export AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1
        exec /bin/bash "$1" "$2"
      elif [[ -n "$3" ]]; then
        exec > "$3"
      fi
      exec bash "$1" "$2"
    ' bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml" "${2:-}"
}

@test "timing gate preserves the exact recheck summary text" {
  seed_outlier_report
  summary_output="$BATS_TEST_TMPDIR/summary-output.txt"
  run_timing_gate_with_recheck_times "0.010 0.012 0.011" "$summary_output"
  [ "$status" -eq 0 ]
  cat > "$BATS_TEST_TMPDIR/expected-output.txt" <<'EOF'
Source changes detected; measuring complete unit-lane reports.
Rechecking 1 file(s) over the 100ms budget: 3 isolated run(s) each, median enforced.
Recheck cleared suite.slow: configured median guaranteed <= 100ms after 2 isolated runs (early stop: majority under budget; first sample 200.00ms).
EOF
  head -n 3 "$summary_output" > "$BATS_TEST_TMPDIR/original-output.txt"
  cmp "$BATS_TEST_TMPDIR/expected-output.txt" "$BATS_TEST_TMPDIR/original-output.txt"
}

# A closed stdout works on macOS as well as Linux, unlike /dev/full. The
# system-Bash path pins the Bash 3.2 failed-echo buffer regression on macOS.
@test "timing gate clears an outlier even when stdout writes fail" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.012 0.011" closed
  [ "$status" -eq 0 ]
  [ "$(cat "$BATS_TEST_TMPDIR/timings.recheck.d/verdict.txt")" -eq 0 ]
  grep -Fxq 'Recheck cleared suite.slow: configured median guaranteed <= 100ms after 2 isolated runs (early stop: majority under budget; first sample 200.00ms).' \
    "$BATS_TEST_TMPDIR/timings.recheck.d/summary.txt"
}

@test "timing gate fails a breaching median even when stdout writes fail" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.150 0.160" closed
  [ "$status" -eq 1 ]
  [ "$(cat "$BATS_TEST_TMPDIR/timings.recheck.d/verdict.txt")" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (median 150.00ms of 3 isolated runs)"* ]]
}

@test "timing gate ends failed output with verdicts and sample counts" {
  seed_changed_offender_report
  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES="src/example.ts\n$OFFENDER_FILE\n" \
    STUB_RECHECK_CLASSNAME_FROM_FILE=1 \
    STUB_RECHECK_TIMES="0.150 0.150 0.150 0.010 0.010 0.010 0.010 0.010 0.010 0.010 0.010 0.010" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Recheck cleared suite0.case"*"Unit timing budget failures:"*"FAIL: testLaneClassification.case | FAIL (median over budget) | first sample: 150.00ms | re-run samples: 150.00ms / 150.00ms / 150.00ms | median: 150.00ms"*"Rechecked tests: 4"*"Cleared tests: 3"*"Failing tests: 1" ]]
  [ "$(grep -n 'Unit timing budget failures:' <<< "$output" | cut -d: -f1)" -gt "$(grep -n 'Recheck cleared suite0.case' <<< "$output" | cut -d: -f1)" ]
}

@test "timing gate final block lists offenders it could not verify" {
  seed_outlier_report
  BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=600 run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: suite.slow | FAIL (could not verify within the recheck budget) | first sample: 200.00ms"* ]]
}

@test "timing gate emits GitHub annotations only under Actions" {
  seed_outlier_report
  export GITHUB_ACTIONS=true
  run_timing_gate_with_recheck_times "0.010 0.150 0.160"
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error::FAIL: suite.slow | FAIL (median over budget)"* ]]
  [[ "$output" != *"::error::FAIL: 1 test(s)"* ]]
  unset GITHUB_ACTIONS
  rm -f "$STUB_RECHECK_INDEX"
  run_timing_gate_with_recheck_times "0.010 0.150 0.160"
  [ "$status" -eq 1 ]
  [[ "$output" != *"::error::"* ]]
}

@test "timing gate adds the failing test list to the Markdown summary" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.150 0.160"
  [ "$status" -eq 1 ]
  grep -Fq 'FAIL: suite.slow | FAIL (median over budget) | first sample: 200.00ms' \
    "$report_dir/unit-timing-budget-summary.md"
}

@test "timing gate passing run has no failure block" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  [[ "$output" != *"Unit timing budget failures:"* ]]
  [[ "$output" != *"FAIL: suite.slow"* ]]
}

@test "timing gate closed stdout still records failure list and fails" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.150 0.160" closed
  [ "$status" -eq 1 ]
  grep -Fq 'FAIL: suite.slow | FAIL (median over budget)' \
    "$BATS_TEST_TMPDIR/timings.recheck.d/failures.txt"
  grep -Fq 'Failing tests: 1' "$BATS_TEST_TMPDIR/timings.recheck.d/failure-counts.txt"
}

@test "timing gate clears an outlier whose median recheck is within budget" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Rechecking 1 file(s)"* ]]
  [[ "$output" == *"Recheck cleared suite.slow"* ]]
  [[ "$output" == *"configured median guaranteed <= 100ms after 2 isolated runs"* ]]
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
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 2 ]
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
  # Worst first, but no offender is deferred: all 24 files get a passing majority.
  [ "$(grep -c "suite0\.test\.ts" "$BUN_ARGS_FILE")" -eq 2 ]
  [ "$(grep -c "suite7\.test\.ts" "$BUN_ARGS_FILE")" -eq 2 ]
  [ "$(grep -c "suite8\.test\.ts" "$BUN_ARGS_FILE")" -eq 2 ]
  [ "$(grep -c "suite23\.test\.ts" "$BUN_ARGS_FILE")" -eq 2 ]
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

# Exact-name testcases minted from ONE parameterized declaration share
# (file, classname, name, line) -- see test/features/utility/DisplayConfig.test.ts:130-132.
# Keying `seen_run` by line alone kept only the first matching row per recheck
# report, so a same-line duplicate's slow sample could be cleared by its fast
# sibling's row landing first. Aggregating the MAXIMUM per identity per report
# must keep this offender caught (review thread PRRT_kwDOP-GF5M6h9Pky on PR #6997).
@test "timing gate aggregates same-line duplicate tuples by their maximum duration" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report_with_lines "$report_dir/shard-0.xml" "$OFFENDER_FILE" \
    suite dup 0.010 130 \
    suite dup 0.150 130

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_DUP_TIMES="0.010 0.150" \
    STUB_RECHECK_DUP_LINES="130 130" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"median 150.00ms of 3 isolated runs"* ]]
  [[ "$output" != *"Recheck cleared suite.dup"* ]]
}

# A recheck which omits a sibling from the same source-line identity is not a
# complete sample. Keep the initial offender instead of letting its fast sibling
# clear it (review thread PRRT_kwDOP-GF5M6h9WUu on PR #6997).
@test "timing gate fails closed when a same-line duplicate recheck omits a sibling" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report_with_lines "$report_dir/shard-0.xml" "$OFFENDER_FILE" \
    suite dup 0.010 130 \
    suite dup 0.150 130

  run env \
    PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    STUB_RECHECK_DUP_TIMES="0.010" \
    STUB_RECHECK_DUP_LINES="130" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.dup"* ]]
  [[ "$output" != *"Recheck cleared suite.dup"* ]]
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
  [ "$(grep -c -- "$OFFENDER_FILE" "$BUN_ARGS_FILE")" -eq 2 ]
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
  [ "$(grep -c "suite0\.test\.ts" "$BUN_ARGS_FILE")" -eq 2 ]
  [ "$(grep -c "suite1\.test\.ts" "$BUN_ARGS_FILE")" -eq 2 ]
  [ "$(grep -c "suite2\.test\.ts" "$BUN_ARGS_FILE")" -eq 2 ]
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


@test "randomized unit lane shares canonical discovery and uses one non-isolated process" {
  cat > "$STUB_BIN/find" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' test/utils/FileDownloader.test.ts test/planUtils.test.ts \
  test/daemon/daemonClientAvailability.integration.test.ts test/stress/memory-leak.stress.test.ts
EOF
  chmod +x "$STUB_BIN/find"
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_RANDOM_SEED=907919 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"seed=907919"* ]]
  [ "$(wc -l < "$BUN_ARGS_FILE" | tr -d ' ')" -eq 1 ]
  [ "$(cat "$BUN_ARGS_FILE")" = "test --timeout 5000 --randomize --seed=907919 test/planUtils.test.ts test/utils/FileDownloader.test.ts" ]

  # Ordinary shards consume the same two files (one per worker).
  : > "$BUN_ARGS_FILE"
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$BUN_ARGS_FILE" | tr -d ' ')" -eq 2 ]
  grep -q 'test/planUtils.test.ts' "$BUN_ARGS_FILE"
  grep -q 'test/utils/FileDownloader.test.ts' "$BUN_ARGS_FILE"
  ! grep -qE 'integration.test.ts|test/stress/' "$BUN_ARGS_FILE"
}

@test "randomized unit lane reports seed and repro on failure and preserves exit status" {
  local summary="$STUB_BIN/summary.md"
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_RANDOM_SEED=42 \
    GITHUB_STEP_SUMMARY="$summary" STUB_BUN_EXIT=7 bash "$SCRIPT" unit
  [ "$status" -eq 7 ]
  [[ "$output" == *"seed=42"* ]]
  grep -Fq 'Seed: `42`' "$summary"
  grep -Fq 'AUTOMOBILE_UNIT_RANDOM_SEED=42 bash scripts/test-ts.sh unit' "$summary"
  grep -Fq 'bun test --randomize --seed=42 <files>' "$summary"
}

@test "randomized unit success does not write a failure summary" {
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_RANDOM_SEED=42 \
    GITHUB_STEP_SUMMARY="$STUB_BIN/summary.md" bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [ ! -e "$STUB_BIN/summary.md" ]
}

@test "randomized unit lane rejects invalid seeds and partial targets before invoking Bun" {
  for seed in 0 -1 abc 4294967296 99999999999999999999; do
    run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_RANDOM_SEED="$seed" bash "$SCRIPT" unit
    [ "$status" -eq 2 ]
  done
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_RANDOM_SEED=42 bash "$SCRIPT" unit test/planUtils.test.ts
  [ "$status" -eq 2 ]
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_RANDOM_SEED=42 bash "$SCRIPT" unit --isolate
  [ "$status" -eq 2 ]
  [ ! -s "$BUN_ARGS_FILE" ]
}

@test "randomized unit lane refuses empty discovery instead of running the whole suite" {
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_BIN/find"
  chmod +x "$STUB_BIN/find"
  run env -u RUNNER_OS PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_RANDOM_SEED=42 bash "$SCRIPT" unit
  [ "$status" -eq 1 ]
  [[ "$output" == *"No unit test files discovered"* ]]
  [ ! -s "$BUN_ARGS_FILE" ]
}

# Compare the actual Bun command in the fixture-only unit shard with each
# measurement path. Report/shard paths vary; the execution contract must not.
@test "timing gate shares the unit shard environment and flags with every measurement path" {
  for runner in Linux macOS; do
    expected_timeout=5000
    [[ "$runner" != macOS ]] || expected_timeout=20000
    mode_log="$BATS_TEST_TMPDIR/test-mode"
    : > "$mode_log"
    : > "$BUN_ARGS_FILE"
    run env -u AUTOMOBILE_TEST_MODE -u AUTOMOBILE_TEST_TIMEOUT_MS \
      PATH="$STUB_BIN:$PATH" RUNNER_OS="$runner" \
      STUB_BUN_TEST_MODE_FILE="$mode_log" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
      bash "$SCRIPT" unit
    [ "$status" -eq 0 ]
    [ -s "$mode_log" ]
    [ "$(grep -c '^true$' "$mode_log")" -eq "$(wc -l < "$mode_log")" ]
    main_contract="$(head -n 1 "$BUN_ARGS_FILE")"
    main_contract="${main_contract%% --reporter*}"
    # Full unit shards have file arguments after the shared flags.
    main_contract="${main_contract%% test/*}"
    [[ "$main_contract" == *"--isolate --timeout $expected_timeout --no-orphans --preload "* ]]

    for path in recheck changed-file changed-source; do
      : > "$mode_log"
      : > "$BUN_ARGS_FILE"
      changed_files='src/example.ts\n'
      source_reports=""
      case "$path" in
        recheck) seed_outlier_report; source_reports="$report_dir" ;;
        changed-file) changed_files="$OFFENDER_FILE\n" ;;
      esac
      run env -u AUTOMOBILE_TEST_MODE -u AUTOMOBILE_TEST_TIMEOUT_MS \
        PATH="$STUB_BIN:$PATH" RUNNER_OS="$runner" \
        STUB_BUN_TEST_MODE_FILE="$mode_log" STUB_RECHECK_TIMES="0.010 0.010 0.010" \
        BUN_TEST_TIMING_BASE_REF=origin/main \
        BUN_TEST_TIMING_REPORT_DIR="$source_reports" TIMING_CHANGED_FILES="$changed_files" \
        bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/$runner-$path.xml"
      [ "$status" -eq 0 ]
      [ -s "$mode_log" ]
      [ "$(grep -c '^true$' "$mode_log")" -eq "$(wc -l < "$mode_log")" ]
      while IFS= read -r command; do
        [[ "$command" != test\ * ]] || [[ "$command" == "$main_contract"* ]]
      done < "$BUN_ARGS_FILE"
    done
  done
}

@test "timing gate preserves explicit test mode and per-test timeout overrides" {
  mode_log="$BATS_TEST_TMPDIR/test-mode"
  seed_outlier_report
  run env PATH="$STUB_BIN:$PATH" RUNNER_OS=macOS AUTOMOBILE_TEST_MODE=false \
    AUTOMOBILE_TEST_TIMEOUT_MS=1234 STUB_BUN_TEST_MODE_FILE="$mode_log" \
    STUB_RECHECK_TIMES="0.010 0.010 0.010" \
    BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$mode_log")" -eq 2 ]
  [ "$(grep -c '^false$' "$mode_log")" -eq 2 ]
  [ "$(grep -c -- '--timeout 1234 --no-orphans --preload' "$BUN_ARGS_FILE")" -eq 2 ]
}

@test "timing gate bounds an in-flight recheck by the remaining budget and reports its file" {
  seed_outlier_report
  cat > "$STUB_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$STUB_TIMEOUT_ARGS"
exit 124
EOF
  chmod +x "$STUB_BIN/timeout"
  run env -u AUTOMOBILE_FORCE_PORTABLE_TIMEOUT PATH="$STUB_BIN:$PATH" \
    STUB_TIMEOUT_ARGS="$BATS_TEST_TMPDIR/timeout-args" \
    BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=60 BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=1 \
    TIMING_CHANGED_FILES='src/example.ts\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  grep -q -- '-k 2 59 ' "$BATS_TEST_TMPDIR/timeout-args"
  [[ "$output" == *"Could not verify within the 60s recheck budget: suite.slow"* ]]
  [[ "$output" == *"$OFFENDER_FILE"* ]]
}

@test "timing gate treats shared unit invocation changes as complete lane inputs" {
  run env PATH="$STUB_BIN:$PATH" BUN_TEST_TIMING_BASE_REF=origin/main \
    TIMING_CHANGED_FILES='scripts/lib/bun-unit-test.sh\n' \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"measuring Bun-affected unit tests"* ]]
  grep -q -- '--changed=origin/main' "$BUN_ARGS_FILE"
}


stub_chunk_discovery() {
  cat > "$STUB_BIN/find" <<'EOF'
#!/usr/bin/env bash
for ((i = 0; i < 12; i += 1)); do printf 'test/fixture%02d.test.ts\n' "$i"; done
EOF
  chmod +x "$STUB_BIN/find"
}

@test "unset chunking preserves one canonical invocation per shard and its args" {
  stub_chunk_discovery
  run env -u AUTOMOBILE_UNIT_TEST_CHUNK_FILES PATH="$STUB_BIN:$PATH" \
    AUTOMOBILE_UNIT_TEST_WORKERS=2 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 2 ]
  expected="test --isolate --timeout 5000 --no-orphans --preload $PWD/test/setup/fileTimingProbe.ts"
  for shard in 0 1; do
    args="$expected"
    for ((i = shard; i < 12; i += 2)); do args+=" $(printf 'test/fixture%02d.test.ts' "$i")"; done
    grep -Fxq "$args" "$BUN_ARGS_FILE"
  done
}

@test "chunking runs sequential 5 5 2 file lists with shared flags env timing and distinct reports" {
  stub_chunk_discovery
  record="$BATS_TEST_TMPDIR/chunks"
  reports="$BATS_TEST_TMPDIR/reports"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    AUTOMOBILE_UNIT_TEST_CHUNK_FILES=5 STUB_CHUNK_RECORD="$record" \
    AUTOMOBILE_UNIT_JUNIT_DIR="$reports" bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  # One summary follows the three test invocations.
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 4 ]
  for chunk in 0 1 2; do
    expected="test --isolate --timeout 5000 --no-orphans --preload $PWD/test/setup/fileTimingProbe.ts --reporter junit --reporter-outfile $reports/shard-0-chunk-$chunk.xml"
    for ((i = chunk * 5; i < (chunk + 1) * 5 && i < 12; i += 1)); do
      expected+=" $(printf 'test/fixture%02d.test.ts' "$i")"
    done
    [ "$(sed -n "$((chunk + 1))p" "$BUN_ARGS_FILE")" = "$expected" ]
    [ -s "$reports/shard-0-chunk-$chunk.xml" ]
  done
  timing="$PWD/scratch/test-ts-unit-shards/timing-shard-0.ndjson"
  [ "$(grep -Fxc "true|$timing|$timing" "$record")" -eq 3 ]
  [ "$(wc -l < "$timing")" -eq 12 ]
  for ((i = 0; i < 12; i += 1)); do
    grep -Fq "$(printf 'test/fixture%02d.test.ts' "$i")" "$timing"
  done
  # Exercise the same glob the timing validator uses, with the real XML parser.
  run "$REAL_BUN" run scripts/lib/junit-testcase-timings.ts "$reports"/*.xml
  [ "$status" -eq 0 ]
  [ "$(wc -l <<< "$output")" -eq 3 ]
}

@test "chunked shards skip the calibration probe so the shared chunk deadline holds" {
  stub_chunk_discovery
  record="$BATS_TEST_TMPDIR/chunks"
  probes="$BATS_TEST_TMPDIR/probes"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    AUTOMOBILE_UNIT_TEST_CHUNK_FILES=5 STUB_CHUNK_RECORD="$record" \
    AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=600 STUB_PROBE_RECORD="$probes" \
    AUTOMOBILE_UNIT_JUNIT_DIR="$BATS_TEST_TMPDIR/reports" bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [ ! -e "$probes" ]
}

@test "a failing chunk fails the shard and lane while later chunks still run" {
  stub_chunk_discovery
  record="$BATS_TEST_TMPDIR/chunks"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    AUTOMOBILE_UNIT_TEST_CHUNK_FILES=5 STUB_CHUNK_RECORD="$record" STUB_CHUNK_FAIL=2 \
    bash "$SCRIPT" unit
  [ "$status" -eq 1 ]
  [ "$(wc -l < "$record")" -eq 3 ]
  [[ "$output" == *"FAIL: unit shard 0 exited with status 7"* ]]
  [ "$(wc -l < scratch/test-ts-unit-shards/timing-shard-0.ndjson)" -eq 12 ]
}

@test "one watchdog bounds the complete chunk sequence rather than each fresh invocation" {
  stub_chunk_discovery
  record="$BATS_TEST_TMPDIR/chunks"
  # Each invocation fits the 2s deadline (1.5s); their 4.5s sequence cannot. A
  # per-invocation watchdog would let all three finish and exit 0, so the 124
  # below proves the one deadline spans the whole sequence. The margins are
  # wide so a loaded runner's slow startup or late watchdog wake-up does not
  # change which side of the deadline each invocation lands on.
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    AUTOMOBILE_UNIT_TEST_CHUNK_FILES=5 STUB_CHUNK_RECORD="$record" \
    STUB_BUN_SLEEP_SECONDS=1.5 AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=2 \
    bash "$SCRIPT" unit
  [ "$status" -eq 124 ]
  # The fake chunk only creates the record once it starts. On a loaded runner
  # the deadline can expire before the first chunk begins, and zero chunks
  # still satisfies "the sequence was cut short", so a missing file counts as 0.
  started=0
  if [ -e "$record" ]; then started="$(wc -l < "$record" | tr -d ' ')"; fi
  [ "$started" -lt 3 ]
  [ -s scratch/test-ts-unit-shards/watchdog-shard-0.txt ]
}

@test "chunk size rejects invalid values just like worker count before invoking Bun" {
  for value in '' abc 1.5 0 -1 05; do
    run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_CHUNK_FILES="$value" \
      bash "$SCRIPT" unit
    [ "$status" -eq 2 ]
    [[ "$output" == *"AUTOMOBILE_UNIT_TEST_CHUNK_FILES must be a positive integer"* ]]
  done
  [ ! -s "$BUN_ARGS_FILE" ]
}

# Five of the twelve chunk fixtures are allow-listed for shared processes
# (#10583). Comments, blank lines, CRLF endings and stale entries are ignored.
write_shared_allowlist() {
  printf '# shared-process allow-list\n\ntest/fixture01.test.ts\r\ntest/fixture02.test.ts\ntest/fixture05.test.ts\ntest/fixture08.test.ts\ntest/fixture11.test.ts\ntest/deleted.test.ts\n' \
    > "$AUTOMOBILE_UNIT_SHARED_ALLOWLIST"
}

fixture_list() {
  local list="" index
  for index in "$@"; do list+=" $(printf 'test/fixture%02d.test.ts' "$index")"; done
  printf '%s' "$list"
}

@test "unit shards run allow-listed files in one shared process and the rest isolated (#10583)" {
  stub_chunk_discovery
  write_shared_allowlist
  reports="$BATS_TEST_TMPDIR/reports"
  labels="$BATS_TEST_TMPDIR/labels"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    AUTOMOBILE_UNIT_JUNIT_DIR="$reports" STUB_GROUP_LABEL_RECORD="$labels" bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"test-ts: unit lane shared_files=5 isolated_files=7"* ]]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 4 ]
  shared="test --timeout 5000 --no-orphans --preload $PWD/test/setup/fileTimingProbe.ts --reporter junit --reporter-outfile"
  isolated="test --isolate --timeout 5000 --no-orphans --preload $PWD/test/setup/fileTimingProbe.ts --reporter junit --reporter-outfile"
  # Shared files lead the round-robin, so both groups split evenly: 3+2 and 4+3.
  grep -Fxq "$shared $reports/shard-0-shared.xml$(fixture_list 1 5 11)" "$BUN_ARGS_FILE"
  grep -Fxq "$isolated $reports/shard-0.xml$(fixture_list 3 6 9)" "$BUN_ARGS_FILE"
  grep -Fxq "$shared $reports/shard-1-shared.xml$(fixture_list 2 8)" "$BUN_ARGS_FILE"
  grep -Fxq "$isolated $reports/shard-1.xml$(fixture_list 0 4 7 10)" "$BUN_ARGS_FILE"
  for report in shard-0-shared shard-0 shard-1-shared shard-1; do
    [ -s "$reports/$report.xml" ]
  done
  # The timing probe names the shared group; isolated files keep their own entries.
  grep -Fxq "unit shard 0 shared process (3 files)" "$labels"
  grep -Fxq "unit shard 1 shared process (2 files)" "$labels"
  [ "$(grep -c '^none$' "$labels")" -eq 2 ]
  [[ "$output" == *"test-ts: unit shard 1/2 wall="*"s status=0"* ]]
}

@test "AUTOMOBILE_UNIT_SHARED_PROCESS=0 runs every unit file isolated as before" {
  stub_chunk_discovery
  write_shared_allowlist
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=2 \
    AUTOMOBILE_UNIT_SHARED_PROCESS=0 bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [[ "$output" == *"test-ts: unit lane shared_files=0 isolated_files=12"* ]]
  expected="test --isolate --timeout 5000 --no-orphans --preload $PWD/test/setup/fileTimingProbe.ts"
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 2 ]
  grep -Fxq "$expected$(fixture_list 0 2 4 6 8 10)" "$BUN_ARGS_FILE"
  grep -Fxq "$expected$(fixture_list 1 3 5 7 9 11)" "$BUN_ARGS_FILE"
}

@test "a failing shared process fails the shard and lane while its isolated group still runs" {
  stub_chunk_discovery
  write_shared_allowlist
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 STUB_SHARED_FAIL=7 \
    bash "$SCRIPT" unit
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: unit shard 0 shared process exited with status 7"* ]]
  [[ "$output" == *"FAIL: unit shard 0 exited with status 7"* ]]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 2 ]
  grep -q -- '--isolate.*test/fixture00.test.ts' "$BUN_ARGS_FILE"
}

@test "chunked shards chunk the shared group without --isolate and never mix the groups" {
  stub_chunk_discovery
  write_shared_allowlist
  reports="$BATS_TEST_TMPDIR/reports"
  labels="$BATS_TEST_TMPDIR/labels"
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    AUTOMOBILE_UNIT_TEST_CHUNK_FILES=2 AUTOMOBILE_UNIT_JUNIT_DIR="$reports" \
    STUB_GROUP_LABEL_RECORD="$labels" bash "$SCRIPT" unit
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$BUN_ARGS_FILE")" -eq 7 ]
  flags="--timeout 5000 --no-orphans --preload $PWD/test/setup/fileTimingProbe.ts --reporter junit --reporter-outfile $reports/shard-0-chunk"
  [ "$(sed -n 1p "$BUN_ARGS_FILE")" = "test $flags-0.xml$(fixture_list 1 2)" ]
  [ "$(sed -n 2p "$BUN_ARGS_FILE")" = "test $flags-1.xml$(fixture_list 5 8)" ]
  [ "$(sed -n 3p "$BUN_ARGS_FILE")" = "test $flags-2.xml$(fixture_list 11)" ]
  [ "$(sed -n 4p "$BUN_ARGS_FILE")" = "test --isolate $flags-3.xml$(fixture_list 0 3)" ]
  [ "$(sed -n 7p "$BUN_ARGS_FILE")" = "test --isolate $flags-6.xml$(fixture_list 10)" ]
  [ "$(sed -n 3p "$labels")" = "unit shard 0 shared chunk 2 (1 files)" ]
  [ "$(sed -n 4p "$labels")" = "none" ]
}

@test "one watchdog bounds the shared and isolated groups of a shard together" {
  stub_chunk_discovery
  write_shared_allowlist
  # Each group fits the 2s deadline (1.5s); the pair cannot. See the chunk
  # watchdog test above for the margins.
  # Retries are off so the shard's single attempt is what the isolated count sees.
  run env PATH="$STUB_BIN:$PATH" AUTOMOBILE_UNIT_TEST_WORKERS=1 \
    AUTOMOBILE_UNIT_SHARD_RETRIES=0 \
    STUB_BUN_SLEEP_SECONDS=1.5 AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=2 \
    bash "$SCRIPT" unit
  [ "$status" -eq 124 ]
  [ "$(grep -c -- '--isolate' "$BUN_ARGS_FILE")" -le 1 ]
  [ -s scratch/test-ts-unit-shards/watchdog-shard-0.txt ]
}

@test "a retried shard re-runs both its shared and isolated groups (#10583)" {
  stub_chunk_discovery
  write_shared_allowlist
  report_dir="$BATS_TEST_TMPDIR/unit-reports"
  run_retry_lane STUB_BUN_EXITS="124 0 0 0" AUTOMOBILE_UNIT_JUNIT_DIR="$report_dir"
  [ "$status" -eq 0 ]
  [ "$(bun_test_invocations)" -eq 4 ]
  [ "$(grep -c -- '--isolate' "$BUN_ARGS_FILE")" -eq 2 ]
  [ "$(grep -vc -- '--isolate' "$BUN_ARGS_FILE")" -eq 2 ]
  [[ "$output" == *"test-ts: unit shard 0 passed on its retry"* ]]
}

@test "timing gate summary records ordered samples and both median verdicts" {
  for times in "0.010 0.012 0.011" "0.010 0.150 0.160"; do
    seed_outlier_report
    cp "$report_dir/shard-0.xml" "$BATS_TEST_TMPDIR/original.xml"
    rm -f "$STUB_RECHECK_INDEX"
    unset GITHUB_STEP_SUMMARY
    run_timing_gate_with_recheck_times "$times"
    summary="$BATS_TEST_TMPDIR/timings.recheck.d/unit-timing-budget-summary.md"
    [ -s "$summary" ]
    grep -Fq 'First sample: 200.00ms' "$summary"
    grep -Fq 'Budget: 100ms; configured re-runs: 3' "$summary"
    if [[ "$times" == "0.010 0.012 0.011" ]]; then
      [ "$status" -eq 0 ]
      grep -Fq 'Completed samples: 2 of 3 (early stop: majority under budget)' "$summary"
      grep -Fq 'Re-run samples: 10.00ms / 12.00ms' "$summary"
      grep -Fq 'Median: guaranteed <= 100ms' "$summary"
      grep -Fq 'Verdict: PASS (cleared)' "$summary"
      grep -Fq 'Overall verdict: PASS' "$summary"
    else
      [ "$status" -eq 1 ]
      grep -Fq 'Re-run samples: 10.00ms / 150.00ms / 160.00ms' "$summary"
      grep -Fq 'Completed samples: 3 of 3' "$summary"
      grep -Fq 'Median: 150.00ms' "$summary"
      grep -Fq 'Verdict: FAIL (median over budget)' "$summary"
      grep -Fq 'Overall verdict: FAIL' "$summary"
    fi
    [[ "$output" == *"$(cat "$summary")"* ]]
    ! grep -Ei 'xceeded|recheck produced|isolated runs|isolated samples' "$summary"
    cmp "$summary" "$report_dir/unit-timing-budget-summary.md"
    cmp "$BATS_TEST_TMPDIR/original.xml" "$report_dir/shard-0.xml"
  done
}

@test "timing gate summary records incomplete and zero samples" {
  for times in "skip skip 0.010" "skip skip skip"; do
    seed_outlier_report
    rm -f "$STUB_RECHECK_INDEX"
    run_timing_gate_with_recheck_times "$times"
    [ "$status" -eq 1 ]
    summary="$BATS_TEST_TMPDIR/timings.recheck.d/unit-timing-budget-summary.md"
    grep -Fq 'Median: not computed' "$summary"
    if [[ "$times" == "skip skip 0.010" ]]; then
      grep -Fq 'Completed samples: 1 of 3' "$summary"
      grep -Fq 'Re-run samples: 10.00ms' "$summary"
      grep -Fq 'Verdict: FAIL (fewer samples than configured)' "$summary"
    else
      grep -Fq 'Completed samples: 0 of 3' "$summary"
      grep -Fq 'Verdict: FAIL (no samples)' "$summary"
    fi
  done
}

@test "timing gate summary appends step summary and tolerates write failure" {
  seed_outlier_report
  export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/step-summary.md"
  printf 'Existing content\n' > "$GITHUB_STEP_SUMMARY"
  run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  [ "$(head -n 1 "$GITHUB_STEP_SUMMARY")" = 'Existing content' ]
  tail -n +2 "$GITHUB_STEP_SUMMARY" > "$BATS_TEST_TMPDIR/appended.md"
  cmp "$BATS_TEST_TMPDIR/appended.md" "$report_dir/unit-timing-budget-summary.md"
  cp "$GITHUB_STEP_SUMMARY" "$BATS_TEST_TMPDIR/preserved-step-summary.md"
  unset GITHUB_STEP_SUMMARY
  rm -f "$STUB_RECHECK_INDEX"
  run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/step-summary.md" "$BATS_TEST_TMPDIR/preserved-step-summary.md"
  export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR"
  rm -f "$STUB_RECHECK_INDEX"
  run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Could not append unit timing summary"* ]]
}

@test "timing gate summary survives closed stdout with either verdict" {
  for times in "0.010 0.012 0.011" "0.010 0.150 0.160"; do
    seed_outlier_report
    rm -f "$STUB_RECHECK_INDEX"
    run_timing_gate_with_recheck_times "$times" closed
    if [[ "$times" == "0.010 0.012 0.011" ]]; then
      [ "$status" -eq 0 ]
    else
      [ "$status" -eq 1 ]
    fi
    [ -s "$BATS_TEST_TMPDIR/timings.recheck.d/unit-timing-budget-summary.md" ]
  done
}

@test "timing gate summary fails missing files and unverified offenders" {
  for file in "test/missing.test.ts" ""; do
    seed_outlier_report
    write_junit_report "$report_dir/shard-0.xml" "$file" suite slow 0.200
    run_timing_gate_with_recheck_times "0.010 0.012 0.011"
    [ "$status" -eq 1 ]
    grep -Fq 'First sample: 200.00ms' "$report_dir/unit-timing-budget-summary.md"
    grep -Fq 'Completed samples: 0 of 3' "$report_dir/unit-timing-budget-summary.md"
    grep -Fq 'Verdict: FAIL (not re-runnable; first sample stands)' "$report_dir/unit-timing-budget-summary.md"
  done
  seed_outlier_report
  BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=600 run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 1 ]
  grep -Fq 'Verdict: FAIL (could not verify within the recheck budget)' "$report_dir/unit-timing-budget-summary.md"
  seed_changed_offender_report
  BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=600 run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 1 ]
  summary="$report_dir/unit-timing-budget-summary.md"
  [ "$(grep -c '^<pre>' "$summary")" -eq 4 ]
  for label in suite0.case suite1.case suite2.case testLaneClassification.case; do
    grep -Fq "<pre>$label</pre>" "$summary"
  done
}

@test "timing gate writes no summary without offenders" {
  seed_outlier_report
  write_junit_report "$report_dir/shard-0.xml" "$OFFENDER_FILE" suite fast 0.010
  export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/step-summary.md"
  run_timing_gate_with_recheck_times "0.010 0.012 0.011"
  [ "$status" -eq 0 ]
  [ "$output" = 'Source changes detected; measuring complete unit-lane reports.' ]
  [ ! -e "$BATS_TEST_TMPDIR/timings.recheck.d/unit-timing-budget-summary.md" ]
  [ ! -e "$report_dir/unit-timing-budget-summary.md" ]
  [ ! -e "$GITHUB_STEP_SUMMARY" ]
}

@test "timing gate early stop skips the third run only after a passing majority" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.100 0.900"
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_RECHECK_INDEX")" -eq 2 ]
  [[ "$output" == *"Completed samples: 2 of 3 (early stop: majority under budget)"* ]]
  rm -f "$STUB_RECHECK_INDEX"
  run_timing_gate_with_recheck_times "0.010 0.150 0.020"
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_RECHECK_INDEX")" -eq 3 ]
  [[ "$output" == *"median 20.00ms over 3 isolated runs"* ]]
  [[ "$output" != *"Runner stall suspected"* ]]
}

@test "timing gate logs each isolated recheck sample as it lands" {
  seed_outlier_report
  run_timing_gate_with_recheck_times "0.010 0.150 0.020"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Recheck run 1/3 of "*"slowest testcase 10.00ms."* ]]
  [[ "$output" == *"Recheck run 2/3 of "*"slowest testcase 150.00ms."* ]]
  [[ "$output" == *"Recheck run 3/3 of "*"slowest testcase 20.00ms."* ]]
}

@test "timing gate even run counts never early stop" {
  seed_outlier_report
  BUN_TEST_TIMING_RECHECK_RUNS=4 run_timing_gate_with_recheck_times "0.010 0.010 0.010 0.150"
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_RECHECK_INDEX")" -eq 4 ]
  [[ "$output" != *"early stop"* ]]
}

@test "timing gate suspects widespread stalls but fails closed on budget exhaustion" {
  seed_loaded_runner_report 3
  run env PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' BUN_TEST_TIMING_STALL_MIN_OFFENDERS=3 \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=1 BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=1 \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Runner stall suspected: 3 distinct over-budget tests across 3 file(s)"* ]]
  [[ "$output" == *"Could not verify within the 1s recheck budget"*"Runner stall suspected; re-run the job on a quieter runner."* ]]
  grep -Fq 'Runner stall suspected' "$report_dir/unit-timing-budget-summary.md"
  [[ "$output" != *"Recheck cleared"* ]]
}

@test "timing gate validates the stall threshold as a canonical positive integer" {
  for threshold in 0 03 invalid; do
    BUN_TEST_TIMING_STALL_MIN_OFFENDERS="$threshold" run_timing_gate_with_recheck_times "0.010"
    [ "$status" -eq 2 ]
    [[ "$output" == *"BUN_TEST_TIMING_STALL_MIN_OFFENDERS must be a positive integer without leading zeros"* ]]
  done
}

# Runner calibration (#10583): shard probes scale the first-sample budget.
seed_calibration() {
  printf 'unit shard 0 attempt 1 start\t%s\t25\n' "$1" > "$report_dir/calibration-unit-shard-0.tsv"
}

run_calibrated_timing_gate() {
  run env PATH="$STUB_BIN:$PATH" \
    BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR="$report_dir" \
    TIMING_CHANGED_FILES='src/example.ts\n' "$@" \
    bash "$TIMING_SCRIPT" "$BATS_TEST_TMPDIR/timings.xml"
}

@test "timing gate scales the first-sample budget by the worst shard calibration slowdown" {
  seed_outlier_report
  seed_calibration 75
  printf 'unit shard 1 attempt 1 end\t30\t25\n' > "$report_dir/calibration-unit-shard-1.tsv"
  run_calibrated_timing_gate
  [ "$status" -eq 0 ]
  [[ "$output" == *"Runner calibration: slowdown 3.00x; first-sample budget 300.00ms (x3.00, cap 4x); isolated rechecks still enforce 100ms."* ]]
  [[ "$output" != *"Runner starved"* ]]
  [ ! -s "$BUN_ARGS_FILE" ]
}

@test "timing gate caps the calibration multiplier and still enforces the isolated median" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report "$report_dir/shard-0.xml" "$OFFENDER_FILE" suite slow 0.900
  seed_calibration 250
  run_calibrated_timing_gate STUB_RECHECK_TIMES="0.200 0.200 0.200"
  [ "$status" -eq 1 ]
  [[ "$output" == *"slowdown 10.00x; first-sample budget 400.00ms (x4.00, cap 4x)"* ]]
  [[ "$output" == *"Runner starved (slowdown above 4x)"* ]]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (median 200.00ms of 3 isolated runs)"* ]]
}

@test "timing gate reports unverified offenders on a starved runner as infra warnings" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report "$report_dir/shard-0.xml" "$OFFENDER_FILE" suite slow 0.900
  seed_calibration 250
  run_calibrated_timing_gate GITHUB_ACTIONS=true \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=1 BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"Infra warning (starved runner): could not verify suite.slow within the 1s recheck budget (first sample 900.00ms"* ]]
  [[ "$output" == *"::warning title=Unit timing budget (starved runner)::WARN: suite.slow | WARN (infra: starved runner; could not verify within the recheck budget) | first sample: 900.00ms"* ]]
  [[ "$output" != *"::error::"* ]]
  grep -Fq '## Infra warnings (starved runner)' "$report_dir/unit-timing-budget-summary.md"
  grep -Fq 'Overall verdict: PASS' "$report_dir/unit-timing-budget-summary.md"

  # Below the infra threshold the same unverified offender still fails closed.
  seed_calibration 75
  run_calibrated_timing_gate \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=1 BUN_TEST_TIMING_FAKE_ELAPSED_SECONDS=1
  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not verify within the 1s recheck budget: suite.slow"* ]]
}

@test "timing gate reports an unrecheckable offender on a starved runner as an infra warning" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  # File-less testcase: nothing to re-run, so only the starved first sample exists.
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuites name="bun test" tests="1" failures="0" skipped="0" time="0.9">\n'
    printf '  <testsuite name="suite" tests="1" failures="0" skipped="0" time="0" hostname="mac.lan">\n'
    printf '    <testcase name="slow" classname="suite" time="0.900" line="1" assertions="1" />\n'
    printf '  </testsuite>\n'
    printf '</testsuites>\n'
  } > "$report_dir/shard-0.xml"
  seed_calibration 250
  run_calibrated_timing_gate
  [ "$status" -eq 0 ]
  [[ "$output" == *"Infra warning (starved runner): suite.slow exceeded 100ms on its only sample (900.00ms) and cannot be re-run."* ]]
  grep -Fq 'WARN (infra: starved runner; not re-runnable)' "$report_dir/unit-timing-budget-summary.md"
}

@test "timing gate scopes the first-sample budget to the sample's own shard and final attempt" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report "$report_dir/shard-0.xml" "$OFFENDER_FILE" suite fast 0.010
  write_junit_report "$report_dir/shard-1.xml" "$OFFENDER_FILE" suite slow 0.200
  # Shard 0 is starved (3x) on its discarded attempt 1 only; shard 1 is healthy.
  printf 'unit shard 0 attempt 1 start\t75\t25\nunit shard 0 attempt 2 start\t25\t25\n' \
    > "$report_dir/calibration-unit-shard-0.tsv"
  printf 'unit shard 1 attempt 1 start\t25\t25\n' > "$report_dir/calibration-unit-shard-1.tsv"
  run_calibrated_timing_gate STUB_RECHECK_TIMES="0.200 0.200 0.200"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Test exceeded 100ms: suite.slow (median 200.00ms of 3 isolated runs)"* ]]

  # The same sample on a shard that itself measured 3x gets the scaled budget.
  printf 'unit shard 1 attempt 1 start\t75\t25\n' > "$report_dir/calibration-unit-shard-1.tsv"
  rm -f "$STUB_RECHECK_INDEX"
  run_calibrated_timing_gate STUB_RECHECK_TIMES="0.200 0.200 0.200"
  [ "$status" -eq 0 ]
  [[ "$output" != *"Test exceeded"* ]]
}

@test "timing gate keeps a partially rechecked file fail-closed on a starved runner" {
  report_dir="$BATS_TEST_TMPDIR/unit-timing-reports"
  mkdir -p "$report_dir"
  write_junit_report "$report_dir/shard-0.xml" "$OFFENDER_FILE" suite slow 0.900
  seed_calibration 250
  # Deterministic clock: one second elapses per isolated recheck run.
  cat > "$STUB_BIN/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" != "+%s" ]]; then exec /bin/date "$@"; fi
runs=0
if [[ -f "$STUB_RECHECK_INDEX" ]]; then runs="$(cat "$STUB_RECHECK_INDEX")"; fi
printf '%s\n' "$((1000 + runs))"
EOF
  chmod +x "$STUB_BIN/date"
  run_calibrated_timing_gate STUB_RECHECK_INDEX="$STUB_RECHECK_INDEX" \
    BUN_TEST_TIMING_RECHECK_BUDGET_SECONDS=1 STUB_RECHECK_TIMES="0.200 0.200 0.200"
  [ "$status" -eq 1 ]
  [ "$(cat "$STUB_RECHECK_INDEX")" -eq 1 ]
  [[ "$output" == *"Could not verify within the 1s recheck budget: suite.slow"* ]]
  [[ "$output" != *"Infra warning"* ]]
}

@test "timing gate slowdown override disables scaling and calibration settings are validated" {
  seed_outlier_report
  seed_calibration 75
  run_calibrated_timing_gate BUN_TEST_TIMING_SLOWDOWN=1 STUB_RECHECK_TIMES="0.010 0.010 0.010"
  [ "$status" -eq 0 ]
  [[ "$output" == *"first-sample budget 100.00ms (x1.00, cap 4x)"* ]]
  [[ "$output" == *"Recheck cleared suite.slow"* ]]

  run_calibrated_timing_gate BUN_TEST_TIMING_SLOWDOWN=fast
  [ "$status" -eq 2 ]
  [[ "$output" == *"BUN_TEST_TIMING_SLOWDOWN must be a non-negative decimal (got 'fast')."* ]]

  for name in BUN_TEST_TIMING_MAX_SLOWDOWN BUN_TEST_TIMING_INFRA_SLOWDOWN; do
    run_calibrated_timing_gate "$name=0"
    [ "$status" -eq 2 ]
    [[ "$output" == *"$name must be a positive integer without leading zeros"* ]]
  done
}
