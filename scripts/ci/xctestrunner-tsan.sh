#!/usr/bin/env bash
# Advisory, simulator-free diagnostic for races and the #6061 lock-order hang.
set -euo pipefail

usage() {
  cat << 'HELP'
xctestrunner-tsan.sh: Usage: bash scripts/ci/xctestrunner-tsan.sh [--help]
xctestrunner-tsan.sh: Runs simulator-free XCTestRunner tests with Thread Sanitizer (CI=1).
xctestrunner-tsan.sh: Environment:
xctestrunner-tsan.sh:   XCTESTRUNNER_TSAN_TIMEOUT_SECONDS=1800 (whole discovery/build/test wall clock)
xctestrunner-tsan.sh:   XCTESTRUNNER_TSAN_LOG_DIR=scratch/xctestrunner-tsan (relative to repo root)
xctestrunner-tsan.sh:   XCTESTRUNNER_TSAN_POLL_SECONDS=1 (positive seconds; fractions allowed)
xctestrunner-tsan.sh:   XCTESTRUNNER_TSAN_KILL_GRACE_SECONDS=10 (TERM before KILL)
xctestrunner-tsan.sh: Exit 124: timeout; 3: sanitizer report; otherwise Swift's failure or 1 for no tests.
HELP
}
if [[ $# -gt 0 ]]; then
  if [[ $# -eq 1 && $1 == --help ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "${repo_root}"
# shellcheck source=scripts/ios/xctestrunner_test_filter.sh disable=SC1091
source "${repo_root}/scripts/ios/xctestrunner_test_filter.sh"
# shellcheck source=scripts/ios/swift_test_counts.sh disable=SC1091
source "${repo_root}/scripts/ios/swift_test_counts.sh"
timeout_seconds="${XCTESTRUNNER_TSAN_TIMEOUT_SECONDS:-1800}"
poll_seconds="${XCTESTRUNNER_TSAN_POLL_SECONDS:-1}"
grace_seconds="${XCTESTRUNNER_TSAN_KILL_GRACE_SECONDS:-10}"
for value in "${timeout_seconds}" "${grace_seconds}"; do
  if [[ ! ${value} =~ ^[0-9]+$ ]]; then
    echo 'xctestrunner-tsan.sh: timeout and kill grace must be integer seconds' >&2
    exit 2
  fi
done
# Force decimal arithmetic (including values with leading zeroes).
timeout_seconds=$((10#${timeout_seconds}))
grace_seconds=$((10#${grace_seconds}))
if [[ ${timeout_seconds} -eq 0 || ! ${poll_seconds} =~ ^[0-9]+([.][0-9]+)?$ || ! ${poll_seconds} =~ [1-9] ]]; then
  echo 'xctestrunner-tsan.sh: timeout and poll interval must be positive seconds' >&2
  exit 2
fi
log_dir="${XCTESTRUNNER_TSAN_LOG_DIR:-scratch/xctestrunner-tsan}"
mkdir -p "${log_dir}"
log_file="${log_dir}/xctestrunner-tsan.log"
list_log="${log_dir}/xctestrunner-tsan-list.log"
# A discovery failure must not leave a previous run's test transcript as evidence.
: > "${log_file}"
export CI=1
run_pid="" tail_pid=""
# Job control gives each background command its own process group on macOS too.
set -m

stop_run() {
  local grace_start
  if [[ -n ${run_pid} ]]; then
    if kill -0 -- "-${run_pid}" 2> /dev/null; then
      if kill -TERM -- "-${run_pid}" 2> /dev/null; then :; fi
      grace_start=${SECONDS}
      while kill -0 -- "-${run_pid}" 2> /dev/null && ((SECONDS - grace_start < grace_seconds)); do
        sleep "${poll_seconds}"
      done
      if kill -0 -- "-${run_pid}" 2> /dev/null; then
        if kill -KILL -- "-${run_pid}" 2> /dev/null; then :; fi
      fi
    fi
    if wait "${run_pid}" 2> /dev/null; then :; fi
    run_pid=""
  fi
}
stop_tail() {
  if [[ -n ${tail_pid} ]]; then
    if kill "${tail_pid}" 2> /dev/null; then :; fi
    if wait "${tail_pid}" 2> /dev/null; then :; fi
    tail_pid=""
  fi
}
cleanup() {
  stop_tail
  stop_run
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

last_started_test() {
  local last
  # At minimum report the last started test, even if it subsequently completed.
  # Do not mistake Swift Testing's "Test run started." for an individual test.
  last="$(sed -n \
    -e "/^Test Case '.*' started\./p" \
    -e '/◇ Test .* started\./ { /◇ Test run started\./!p; }' \
    "${1}" | tail -1)"
  if [[ -n ${last} ]]; then
    echo "xctestrunner-tsan.sh: last started test: ${last}" >&2
  else
    echo 'xctestrunner-tsan.sh: no test had started (build or test discovery hung)' >&2
  fi
}

SECONDS=0
swift_rc=0
bounded_swift() {
  local output_file="$1"
  shift
  : > "${output_file}"
  "$@" > "${output_file}" 2>&1 &
  run_pid=$!
  tail -n +1 -f "${output_file}" &
  tail_pid=$!
  while kill -0 "${run_pid}" 2> /dev/null; do
    if ((SECONDS >= timeout_seconds)); then
      stop_run
      stop_tail
      # The complete transcript also covers tail's final buffered chunk.
      cat "${output_file}"
      echo "xctestrunner-tsan.sh: timed out after ${timeout_seconds} seconds; log: ${output_file}" >&2
      last_started_test "${output_file}"
      exit 124
    fi
    sleep "${poll_seconds}"
  done
  swift_rc=0
  wait "${run_pid}" || swift_rc=$?
  # Clean up any descendants that outlived the Swift launcher.
  stop_run
  stop_tail
  cat "${output_file}"
}

bounded_swift "${list_log}" swift test list --package-path ios/XCTestRunner --disable-sandbox --sanitize=thread
if [[ ${swift_rc} -ne 0 ]]; then
  echo "xctestrunner-tsan.sh: swift test list failed (exit ${swift_rc}); log: ${list_log}" >&2
  last_started_test "${list_log}"
  exit "${swift_rc}"
fi
xctestrunner_build_test_filter "$(< "${list_log}")" xctestrunner-tsan.sh
bounded_swift "${log_file}" swift test --package-path ios/XCTestRunner --disable-sandbox --sanitize=thread --filter "${XCTESTRUNNER_TEST_FILTER}"
if [[ ${swift_rc} -ne 0 ]]; then
  last_started_test "${log_file}"
fi
if grep -q 'ThreadSanitizer:' "${log_file}"; then
  echo "xctestrunner-tsan.sh: ThreadSanitizer report detected; log: ${log_file}" >&2
  while IFS= read -r report; do
    echo "xctestrunner-tsan.sh: ${report}" >&2
  done < <(sed -n '/WARNING: ThreadSanitizer:/ { p; q; }' "${log_file}")
  while IFS= read -r report; do
    echo "xctestrunner-tsan.sh: ${report}" >&2
  done < <(sed -n '/SUMMARY: ThreadSanitizer:/ { p; q; }' "${log_file}")
  exit 3
fi
if [[ ${swift_rc} -ne 0 ]]; then
  echo "xctestrunner-tsan.sh: swift test failed (exit ${swift_rc}); log: ${log_file}" >&2
  exit "${swift_rc}"
fi
executed_test_count "$(< "${log_file}")"
if [[ ${EXECUTED_TESTS} -eq 0 ]]; then
  echo "xctestrunner-tsan.sh: XCTestRunnerTests filter executed 0 tests; log: ${log_file}" >&2
  exit 1
fi
echo "xctestrunner-tsan.sh: clean run (${EXECUTED_TESTS} tests); log: ${log_file}"
