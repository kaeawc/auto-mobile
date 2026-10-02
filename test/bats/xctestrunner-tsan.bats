#!/usr/bin/env bats
# Bats deliberately isolates each test and reruns setup in that subshell.
# shellcheck disable=SC2030,SC2031

setup() {
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  fixture="${BATS_TEST_TMPDIR}/fixture"
  mkdir -p "${fixture}/scripts/ci" "${fixture}/scripts/ios" "${fixture}/bin"
  cp "${repo_root}/scripts/ci/xctestrunner-tsan.sh" "${fixture}/scripts/ci/"
  cp "${repo_root}/scripts/ios/"{xctestrunner_test_filter,swift_test_counts}.sh "${fixture}/scripts/ios/"
  export XCTESTRUNNER_TSAN_LOG_DIR="${BATS_TEST_TMPDIR}/logs"
  export XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=5
  export XCTESTRUNNER_TSAN_POLL_SECONDS=0.05
  export XCTESTRUNNER_TSAN_KILL_GRACE_SECONDS=0
  export TSAN_COMMAND_LOG="${BATS_TEST_TMPDIR}/commands"
  export TSAN_PID_FILE="${BATS_TEST_TMPDIR}/swift.pid"
  export TSAN_MODE=clean
  export PATH="${fixture}/bin:${PATH}"
  cat > "${fixture}/bin/swift" << 'STUB'
#!/usr/bin/env bash
set -eu
printf 'CI=%s %s\n' "${CI:-unset}" "$*" >> "${TSAN_COMMAND_LOG}"
if [[ ${1:-} == test && ${2:-} == list ]]; then
  case "${TSAN_MODE}" in
    list-failure) echo 'discovery failed'; exit 19 ;;
    list-hang) echo "$$" > "${TSAN_PID_FILE}"; exec sleep 30 ;;
    empty-filter) echo 'XCTestRunnerTests.RemindersAddPlanTests/testX'; exit 0 ;;
  esac
  echo 'XCTestRunnerTests.AutoMobileVersionTests/testCurrentVersionIsNonEmptySemver'
  echo 'XCTestRunnerTests.AsyncLockOrderTests/testCancellation'
  echo 'XCTestRunnerTests.RemindersAddPlanTests/testX'
  exit 0
fi
# These two lines are copied from scratch/tsan-format-sample.log.
if [[ ${TSAN_MODE} != no-start && ${TSAN_MODE} != zero ]]; then
  echo "Test Case '-[XCTestRunnerTests.AutoMobileVersionTests testCurrentVersionIsNonEmptySemver]' started."
fi
case "${TSAN_MODE}" in
  hang|no-start)
    echo "$$" > "${TSAN_PID_FILE}"
    exec sleep 30
    ;;
  stubborn)
    echo "$$" > "${TSAN_PID_FILE}"
    trap '' TERM
    # The launched group includes this child, not just the stub shell.
    sleep 30 &
    echo "$!" > "${TSAN_PID_FILE}.child"
    wait
    exit 0
    ;;
  testing-crash)
    echo '◇ Test "cancellation" started.'
    echo '◇ Test run started.'
    exit 17
    ;;
  crash) exit 17 ;;
  report|report-failure)
    echo 'WARNING: ThreadSanitizer: data race (pid=123)'
    echo 'SUMMARY: ThreadSanitizer: data race in example'
    if [[ ${TSAN_MODE} == report-failure ]]; then exit 66; fi
    ;;
  zero)
    echo '◇ Test run started.'
    echo '✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.'
    exit 0
    ;;
esac
echo "Test Case '-[XCTestRunnerTests.AutoMobileVersionTests testCurrentVersionIsNonEmptySemver]' passed (0.001 seconds)."
echo ' Executed 1 test, with 0 failures (0 unexpected) in 0.001 seconds'
echo '◇ Test run started.'
echo '✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.'
STUB
  chmod +x "${fixture}/bin/swift"
}

run_lane() {
  # macOS /bin/bash is 3.2: exercise the oldest supported runner shell.
  run /bin/bash "${fixture}/scripts/ci/xctestrunner-tsan.sh" "$@"
}

assert_stub_gone() {
  local pid
  pid="$(cat "${TSAN_PID_FILE}")"
  run kill -0 "${pid}"
  [ "$status" -ne 0 ]
}

@test "clean run saves complete output and uses sanitized simulator-free discovery and CI" {
  run_lane
  [ "$status" -eq 0 ]
  [[ "$output" == *'clean run (1 tests)'* ]]
  grep -Fq "passed (0.001 seconds)." "${XCTESTRUNNER_TSAN_LOG_DIR}/xctestrunner-tsan.log"
  grep -Fq '✔ Test run with 0 tests' "${XCTESTRUNNER_TSAN_LOG_DIR}/xctestrunner-tsan.log"
  run cat "${TSAN_COMMAND_LOG}"
  [[ "$output" == *'CI=1 test list --package-path ios/XCTestRunner --disable-sandbox --sanitize=thread'* ]]
  [[ "$output" == *'CI=1 test --package-path ios/XCTestRunner --disable-sandbox --sanitize=thread --filter XCTestRunnerTests\.(AutoMobileVersionTests|AsyncLockOrderTests)'* ]]
  [[ "$output" != *'RemindersAddPlanTests'* ]]
}

@test "sanitizer report fails with 3 even when Swift exits zero" {
  export TSAN_MODE=report
  run_lane
  [ "$status" -eq 3 ]
  [[ "$output" == *'xctestrunner-tsan.sh: WARNING: ThreadSanitizer: data race'* ]]
  [[ "$output" == *'xctestrunner-tsan.sh: SUMMARY: ThreadSanitizer: data race'* ]]
  [[ "$output" == *"${XCTESTRUNNER_TSAN_LOG_DIR}/xctestrunner-tsan.log"* ]]
}

@test "sanitizer report takes precedence over a nonzero Swift exit" {
  export TSAN_MODE=report-failure
  run_lane
  [ "$status" -eq 3 ]
  [[ "$output" == *'last started test:'* ]]
}

@test "timeout names the last XCTest start and kills only the launched process" {
  export TSAN_MODE=hang XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=2
  run_lane
  [ "$status" -eq 124 ]
  [[ "$output" == *'timed out after 2 seconds'* ]]
  [[ "$output" == *'last started test:'*'testCurrentVersionIsNonEmptySemver'* ]]
  assert_stub_gone
}

@test "timeout without a started test identifies a build or discovery hang" {
  export TSAN_MODE=no-start XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=2
  run_lane
  [ "$status" -eq 124 ]
  [[ "$output" == *'no test had started (build or test discovery hung)'* ]]
  assert_stub_gone
}

@test "discovery itself is covered by the wall clock deadline" {
  export TSAN_MODE=list-hang XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=2
  run_lane
  [ "$status" -eq 124 ]
  [[ "$output" == *'no test had started (build or test discovery hung)'* ]]
  assert_stub_gone
  [ "$(wc -l < "${TSAN_COMMAND_LOG}" | tr -d ' ')" -eq 1 ]
}

@test "timeout escalates to KILL for a group ignoring TERM" {
  export TSAN_MODE=stubborn XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=2
  run_lane
  [ "$status" -eq 124 ]
  assert_stub_gone
  local child
  child="$(cat "${TSAN_PID_FILE}.child")"
  run kill -0 "${child}"
  [ "$status" -ne 0 ]
}

@test "Swift failure without a sanitizer report propagates its exit and last start" {
  export TSAN_MODE=crash
  run_lane
  [ "$status" -eq 17 ]
  [[ "$output" == *'last started test:'*'testCurrentVersionIsNonEmptySemver'* ]]
  [[ "$output" == *'swift test failed (exit 17)'* ]]
}

@test "zero executed tests fails explicitly" {
  export TSAN_MODE=zero
  run_lane
  [ "$status" -eq 1 ]
  [[ "$output" == *'filter executed 0 tests'* ]]
}

@test "failed listing does not run tests" {
  export TSAN_MODE=list-failure
  run_lane
  [ "$status" -eq 19 ]
  [[ "$output" == *'swift test list failed (exit 19)'* ]]
  [ "$(wc -l < "${TSAN_COMMAND_LOG}" | tr -d ' ')" -eq 1 ]
}

@test "denylist-only listing fails without running tests" {
  export TSAN_MODE=empty-filter
  run_lane
  [ "$status" -eq 1 ]
  [[ "$output" == *'no simulator-free XCTestRunnerTests classes after excluding the denylist'* ]]
  [ "$(wc -l < "${TSAN_COMMAND_LOG}" | tr -d ' ')" -eq 1 ]
}

@test "help documents the environment without invoking Swift" {
  run_lane --help
  [ "$status" -eq 0 ]
  [[ "$output" == *'XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=1800'* ]]
  [[ "$output" == *'XCTESTRUNNER_TSAN_KILL_GRACE_SECONDS=10'* ]]
  [ ! -e "${TSAN_COMMAND_LOG}" ]
}

@test "Swift Testing starts are recognized without mistaking its run-level start" {
  export TSAN_MODE=testing-crash
  run_lane
  [ "$status" -eq 17 ]
  [[ "$output" == *'last started test: ◇ Test "cancellation" started.'* ]]
}

@test "invalid arguments and timer settings fail before invoking Swift" {
  run_lane --unknown
  [ "$status" -eq 2 ]
  export XCTESTRUNNER_TSAN_POLL_SECONDS=0
  run_lane
  [ "$status" -eq 2 ]
  [ ! -e "${TSAN_COMMAND_LOG}" ]
}
