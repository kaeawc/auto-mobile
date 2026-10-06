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

# SIGKILL is delivered asynchronously, and an orphaned grandchild (the stubborn
# stub's `sleep`) is reaped by init rather than by the script, so right after the
# script exits `kill -0` can still succeed on a dying process or an unreaped
# zombie (#9960). Poll until the pid is gone or a zombie; a process that really
# survived the KILL stays alive for 30 seconds and still fails the bound.
pid_is_gone() {
  local stat
  stat="$(ps -o stat= -p "$1" 2> /dev/null || true)"
  stat="${stat//[[:space:]]/}"
  [[ -z ${stat} || ${stat} == Z* ]]
}

assert_pid_gone() {
  local attempt
  # An empty or non-numeric pid would make `ps` match nothing and pass vacuously.
  if [[ ! ${1:-} =~ ^[0-9]+$ ]]; then
    echo "assert_pid_gone: not a numeric pid: '${1:-}'" >&2
    return 1
  fi
  for ((attempt = 0; attempt < 100; attempt++)); do
    if pid_is_gone "$1"; then return 0; fi
    sleep 0.05
  done
  echo "pid $1 is still running after the script exited" >&2
  return 1
}

assert_stub_gone() {
  local pid_file="${1:-${TSAN_PID_FILE}}" pid
  if [[ ! -s ${pid_file} ]]; then
    echo "assert_stub_gone: missing or empty pid file: ${pid_file}" >&2
    return 1
  fi
  pid="$(< "${pid_file}")"
  assert_pid_gone "${pid}"
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
  local started elapsed
  started=$(date +%s)
  run_lane
  elapsed=$(($(date +%s) - started))
  [ "$status" -eq 124 ]
  # The stub's sleep lasts 30s and ignores TERM, so only KILL ends the run early.
  [ "${elapsed}" -lt 20 ]
  assert_stub_gone
  assert_stub_gone "${TSAN_PID_FILE}.child"
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

@test "tail ignoring TERM is reaped promptly when Swift executes zero tests" {
  export TSAN_MODE=zero TSAN_TAIL_PID_FILE="${BATS_TEST_TMPDIR}/tail.pid"
  export XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=30
  TSAN_REAL_TAIL="$(command -v tail)"
  export TSAN_REAL_TAIL
  cat > "${fixture}/bin/tail" << 'STUB'
#!/usr/bin/env bash
if [[ ${3:-} != -f ]]; then
  exec "${TSAN_REAL_TAIL}" "$@"
fi
trap '' TERM
echo "$$" > "${TSAN_TAIL_PID_FILE}"
deadline=$(($(date +%s) + 8))
while (($(date +%s) < deadline)); do
  sleep 0.1
done
STUB
  # Make both instant Swift exits wait until their tail has installed its trap.
  mv "${fixture}/bin/swift" "${fixture}/bin/swift-stub"
  cat > "${fixture}/bin/swift" << 'STUB'
#!/usr/bin/env bash
SECONDS=0
while [[ ! -s ${TSAN_TAIL_PID_FILE} ]] || ! kill -0 "$(cat "${TSAN_TAIL_PID_FILE}")" 2> /dev/null; do
  if ((SECONDS >= 2)); then
    echo 'tail stub did not become ready' >&2
    exit 99
  fi
  sleep 0.01
done
exec "${0%/*}/swift-stub" "$@"
STUB
  chmod +x "${fixture}/bin/tail" "${fixture}/bin/swift"
  local started elapsed
  started=$(date +%s)
  run_lane
  elapsed=$(($(date +%s) - started))
  printf 'elapsed=%ss; status=%s\n%s\n' "${elapsed}" "${status}" "${output}"
  [ "$status" -eq 1 ]
  [[ "$output" == *'filter executed 0 tests'* ]]
  [ "${elapsed}" -lt 4 ]
  assert_stub_gone "${TSAN_TAIL_PID_FILE}"
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
