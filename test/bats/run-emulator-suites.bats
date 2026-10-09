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
  for name in gradle reset permission navgraph; do
    cat > "${TEST_DIR}/${name}" <<EOF
#!/usr/bin/env bash
printf '%s %s tools=%s\n' "${name}" "\$*" "\${AUTOMOBILE_ENABLED_TOOLS:-unset}" >> "\$CALLS"
case "${name} \$*" in
  "gradle :junit-runner:test"*) exit "\${FAIL_JUNIT:-0}" ;;
  "gradle :playground:app:test"*) exit "\${FAIL_PLAYGROUND:-0}" ;;
  "permission"*) exit "\${FAIL_PERMISSION:-0}" ;;
esac
exit 0
EOF
    chmod +x "${TEST_DIR}/${name}"
  done
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
    "$@" bash "$SCRIPT_ABS" control-proxy.apk
}

@test "runs JUnit Runner, a daemon reset, then the Playground chain in order" {
  run_suites
  [ "$status" -eq 0 ]
  expected="gradle :junit-runner:test --stacktrace --info tools=unset
reset  tools=unset
permission control-proxy.apk tools=navigateTo,getNavigationGraph,explore
navgraph  tools=navigateTo,getNavigationGraph,explore
gradle :playground:app:test --stacktrace --info tools=navigateTo,getNavigationGraph,explore"
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
