#!/usr/bin/env bats
#
# Contract tests for the iOS WHEP lane's screen-capture-helper crash-report
# collector (#7604). Report directories are injected, so no real
# DiagnosticReports folder is read.

SCRIPT="scripts/webrtc/collect-helper-crash-reports.sh"

setup() {
  TEST_DIR="$(mktemp -d)"
  USER_REPORTS="${TEST_DIR}/user"
  SYSTEM_REPORTS="${TEST_DIR}/system"
  DEST="${TEST_DIR}/artifacts"
  mkdir -p "${USER_REPORTS}" "${SYSTEM_REPORTS}"
  export AUTOMOBILE_CRASH_REPORT_DIRS="${USER_REPORTS}:${SYSTEM_REPORTS}:${TEST_DIR}/missing"
}

teardown() {
  rm -rf "${TEST_DIR}"
  unset AUTOMOBILE_CRASH_REPORT_DIRS
}

@test "script is executable" {
  [ -x "${SCRIPT}" ]
}

@test "requires a destination directory" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"usage:"* ]]
}

@test "reports none found and creates nothing when no helper report exists" {
  printf '{}\n' > "${USER_REPORTS}/Simulator-2026-10-07-120000.ips"

  run bash "${SCRIPT}" "${DEST}"

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"No screen-capture-helper crash reports found."* ]]
  [ ! -e "${DEST}/crash-reports" ]
}

@test "copies only helper reports from every directory and names the exception" {
  printf '{"app_name":"screen-capture-helper"}\n{\n  "exception" : {"type":"EXC_BREAKPOINT","signal":"SIGTRAP"},\n}\n' \
    > "${USER_REPORTS}/screen-capture-helper-2026-10-07-120000.ips"
  printf 'legacy\n' > "${SYSTEM_REPORTS}/screen-capture-helper_2026-10-07-120001_host.crash"
  printf '{}\n' > "${USER_REPORTS}/Simulator-2026-10-07-120000.ips"

  run bash "${SCRIPT}" "${DEST}"

  [ "${status}" -eq 0 ]
  [ -f "${DEST}/crash-reports/screen-capture-helper-2026-10-07-120000.ips" ]
  [ -f "${DEST}/crash-reports/screen-capture-helper_2026-10-07-120001_host.crash" ]
  [ ! -e "${DEST}/crash-reports/Simulator-2026-10-07-120000.ips" ]
  [[ "${output}" == *'"signal":"SIGTRAP"'* ]]
  [[ "${output}" == *"Copied 2 screen-capture-helper crash report(s)"* ]]
}
