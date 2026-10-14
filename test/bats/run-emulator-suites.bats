#!/usr/bin/env bats
#
# Guards scripts/android/run-emulator-suites.sh (#10891): both emulator suites
# run on one booted emulator, a red suite never hides the other, and the
# Playground chain alone gets the navigation-only tool set.

SCRIPT="scripts/android/run-emulator-suites.sh"

setup() {
  SCRIPT_ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  TEST_DIR="$(mktemp -d)"
  export CALLS="${TEST_DIR}/calls"
  : > "$CALLS"

  # Each fake records its argv plus the tool restriction it saw, and exits with
  # the status named by FAIL_<NAME> (default 0).
  for name in gradle reset permission navgraph smoke; do
    cat > "${TEST_DIR}/${name}" <<EOF
#!/usr/bin/env bash
printf '%s %s tools=%s\n' "${name}" "\$*" "\${AUTOMOBILE_ENABLED_TOOLS:-unset}" >> "\$CALLS"
case "${name} \$*" in
  "gradle :junit-runner:testClasses"*) exit "\${FAIL_PREBUILD:-0}" ;;
  "gradle :junit-runner:test"*) printf '%s\\n' "\${JUNIT_OUTPUT:-}"; exit "\${FAIL_JUNIT:-0}" ;;
  "gradle :playground:app:test"*) exit "\${FAIL_PLAYGROUND:-0}" ;;
  "permission"*) exit "\${FAIL_PERMISSION:-0}" ;;
esac
exit 0
EOF
    chmod +x "${TEST_DIR}/${name}"
  done
  cat > "${TEST_DIR}/smoke" <<'EOF'
#!/usr/bin/env bash
printf 'smoke %s tools=%s\n' "$*" "${AUTOMOBILE_ENABLED_TOOLS:-unset}" >> "$CALLS"
exit "${FAIL_SMOKE:-0}"
EOF
  chmod +x "${TEST_DIR}/smoke"
  cat > "${TEST_DIR}/reset" <<'EOF'
#!/usr/bin/env bash
count=0
[[ -f "$RESET_COUNT_FILE" ]] && count="$(cat "$RESET_COUNT_FILE")"
count=$((count + 1))
printf '%s' "$count" > "$RESET_COUNT_FILE"
printf 'reset %s tools=%s\n' "$count" "${AUTOMOBILE_ENABLED_TOOLS:-unset}" >> "$CALLS"
if [[ "$count" -eq 2 && "${FAIL_SECOND_RESET:-0}" -eq 1 ]]; then exit 9; fi
EOF
  chmod +x "${TEST_DIR}/reset"
  export RESET_COUNT_FILE="$TEST_DIR/reset-count"
}

teardown() {
  rm -rf "$TEST_DIR"
}

run_suites() {
  run env -u AUTOMOBILE_ENABLED_TOOLS \
    GRADLE_CMD="${TEST_DIR}/gradle" \
    RESET_DAEMON_CMD="${TEST_DIR}/reset" \
    PERMISSION_CMD="${TEST_DIR}/permission" \
    NAV_GRAPH_CMD="${TEST_DIR}/navgraph" \
    SAVED_PROTOTYPE_SMOKE_CMD="${TEST_DIR}/smoke" \
    RESET_COUNT_FILE="$RESET_COUNT_FILE" \
    "$@" bash "$SCRIPT_ABS" control-proxy.apk
}

@test "runs JUnit Runner, a daemon reset, then the Playground chain in order" {
  run_suites
  [ "$status" -eq 0 ]
  expected="gradle :junit-runner:test --rerun --stacktrace --info tools=unset
reset 1 tools=unset
permission control-proxy.apk tools=navigateTo,getNavigationGraph,explore
navgraph  tools=navigateTo,getNavigationGraph,explore
gradle :playground:app:test --stacktrace --info tools=navigateTo,getNavigationGraph,explore
reset 2 tools=unset
smoke  tools=unset"
  [ "$(cat "$CALLS")" = "$expected" ]
}

@test "a failing JUnit Runner suite still runs the Playground suite and fails" {
  run_suites FAIL_JUNIT=3
  [ "$status" -eq 1 ]
  grep -q '^gradle :playground:app:test' "$CALLS"
  [[ "$output" == *"JUnit Runner emulator suite exit status: 3"* ]]
  [[ "$output" == *"Playground Automobile emulator suite exit status: 0"* ]]
}

@test "a failing Playground suite fails the run after JUnit Runner passed" {
  run_suites FAIL_PLAYGROUND=5
  [ "$status" -eq 1 ]
  [[ "$output" == *"Playground Automobile emulator suite exit status: 5"* ]]
}

@test "the Playground chain stops at its first failing step" {
  run_suites FAIL_PERMISSION=2
  [ "$status" -eq 1 ]
  [[ "$(cat "$CALLS")" != *"navgraph"* ]]
  [[ "$(cat "$CALLS")" != *"gradle :playground:app:test"* ]]
  [[ "$output" == *"Playground Automobile emulator suite exit status: 2"* ]]
}

@test "requires the CtrlProxy APK argument" {
  run bash "$SCRIPT_ABS"
  [ "$status" -ne 0 ]
  [[ "$output" == *"usage: run-emulator-suites.sh <ctrl-proxy-apk>"* ]]
}

@test "prebuild runs only the four non-test Gradle tasks without an APK" {
  run env GRADLE_CMD="${TEST_DIR}/gradle" bash "$SCRIPT_ABS" --prebuild
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS")" = "gradle :junit-runner:testClasses :control-proxy:assembleDebug :playground:app:assembleDebug :playground:app:compileDebugUnitTestKotlin --stacktrace tools=unset" ]
}

@test "prebuild propagates the Gradle failure status" {
  run env GRADLE_CMD="${TEST_DIR}/gradle" FAIL_PREBUILD=8 bash "$SCRIPT_ABS" --prebuild
  [ "$status" -eq 8 ]
  [ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 1 ]
}

@test "cached or skipped JUnit outcomes fail while Playground still runs" {
  for outcome in FROM-CACHE UP-TO-DATE SKIPPED NO-SOURCE; do
    run_suites JUNIT_OUTPUT="> Task :junit-runner:test $outcome"
    [ "$status" -eq 1 ]
    [[ "$output" == *"did not execute against the emulator ($outcome)"* ]]
    grep -q '^gradle :playground:app:test' "$CALLS"
  done
}

@test "a bare executed JUnit task passes and its output streams" {
  run_suites JUNIT_OUTPUT="> Task :junit-runner:test"
  [ "$status" -eq 0 ]
  [[ "$output" == *"> Task :junit-runner:test"* ]]
}

@test "smoke failure is advisory and does not fail passing suites" {
  run_suites FAIL_SMOKE=7
  [ "$status" -eq 0 ]
  [[ "$output" == *'Saved prototype smoke exit status: 7 (advisory; does not fail the job)'* ]]
  [[ "$output" == *'::warning title=Saved prototype smoke::saved prototype smoke failed (advisory)'* ]]
}

@test "second daemon reset failure is advisory when suites passed" {
  run_suites FAIL_SECOND_RESET=1
  [ "$status" -eq 0 ]
  [[ "$output" == *'::warning title=Saved prototype smoke::daemon reset failed (advisory)'* ]]
  grep -q '^smoke ' "$CALLS"
}

@test "smoke timeout is advisory" {
  mkdir -p "$TEST_DIR/timeout-bin"
  cat > "$TEST_DIR/timeout-bin/timeout" <<'EOF'
#!/usr/bin/env bash
exit 124
EOF
  chmod +x "$TEST_DIR/timeout-bin/timeout"
  run_suites PATH="$TEST_DIR/timeout-bin:$PATH" SAVED_PROTOTYPE_SMOKE_TIMEOUT_SECONDS=1
  [ "$status" -eq 0 ]
  [[ "$output" == *'Saved prototype smoke exit status: 124 (advisory; does not fail the job)'* ]]
  [[ "$output" == *'::warning title=Saved prototype smoke::saved prototype smoke timed out (advisory)'* ]]
}

@test "smoke runs after a failing suite and preserves suite failure" {
  run_suites FAIL_PLAYGROUND=5 FAIL_SMOKE=7
  [ "$status" -eq 1 ]
  grep -q '^smoke ' "$CALLS"
  [[ "$output" == *'Playground Automobile emulator suite exit status: 5'* ]]
}
