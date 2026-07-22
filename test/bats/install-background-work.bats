#!/usr/bin/env bats

setup() {
  TEST_DIR="$(mktemp -d)"
  STUB_BIN="${TEST_DIR}/bin"
  mkdir -p "${STUB_BIN}"

  ORIG_PATH="${PATH}"
  PGREP="$(command -v pgrep)"
  export PATH="${STUB_BIN}:/usr/bin:/bin"
  export INSTALL_SH_SOURCE_ONLY=true
  # shellcheck source=/dev/null
  source scripts/install.sh

  log_info() { printf '[INFO] %s\n' "$1"; }
}

assert_process_is_not_active() {
  local state
  state=$(ps -o stat= -p "$1" 2>/dev/null || true)
  [[ -z "${state}" || "${state}" == *Z* ]]
}

teardown() {
  export PATH="${ORIG_PATH}"
  rm -rf "${TEST_DIR}"
}

@test "iOS runtime probe runs in the background and reports its completed result" {
  cat > "${STUB_BIN}/xcrun" <<'STUB'
#!/usr/bin/env bash
sleep 0.1
printf 'iOS 26.5 - Available\n'
STUB
  chmod +x "${STUB_BIN}/xcrun"

  detect_os() { printf 'macos\n'; }

  start_ios_runtime_probe
  [ -n "${IOS_RUNTIME_PROBE_PID}" ]
  [ -f "${IOS_RUNTIME_PROBE_FILE}" ]

  local output_file="${TEST_DIR}/runtime-output"
  local status=0
  finish_ios_runtime_probe >"${output_file}" 2>&1 || status=$?
  local output
  output=$(cat "${output_file}")

  [ "${status}" -eq 0 ]
  [[ "$output" == *"iOS runtimes available: iOS 26.5"* ]]
  [ -z "${IOS_RUNTIME_PROBE_PID}" ]
  [ -z "${IOS_RUNTIME_PROBE_FILE}" ]
}

@test "post-Bun setup propagates changes and replays output after joining" {
  NON_INTERACTIVE=true
  INSTALL_AUTOMOBILE_CLI=true
  START_DAEMON=true
  INSTALL_CLAUDE_MARKETPLACE=false
  CHANGES_MADE=false

  install_auto_mobile_cli() {
    printf 'cli complete\n'
    CHANGES_MADE=true
  }
  migrate_stale_daemon() { printf 'daemon migration complete\n'; }
  start_mcp_daemon() { printf 'daemon healthy\n'; }

  start_post_bun_setup
  [ -n "${POST_BUN_SETUP_PID}" ]

  local output_file="${TEST_DIR}/post-bun-output"
  local status=0
  finish_post_bun_setup >"${output_file}" 2>&1 || status=$?
  local output
  output=$(cat "${output_file}")

  [ "${status}" -eq 0 ]
  [[ "$output" == *"cli complete"* ]]
  [[ "$output" == *"daemon healthy"* ]]
  [ "${CHANGES_MADE}" = "true" ]
  [ -z "${POST_BUN_SETUP_PID}" ]
}

@test "post-Bun setup reports a daemon startup failure" {
  NON_INTERACTIVE=true
  INSTALL_AUTOMOBILE_CLI=false
  START_DAEMON=true
  INSTALL_CLAUDE_MARKETPLACE=false

  migrate_stale_daemon() { :; }
  start_mcp_daemon() {
    printf 'daemon startup failed\n' >&2
    return 17
  }

  start_post_bun_setup

  local output_file="${TEST_DIR}/post-bun-failure-output"
  local status=0
  finish_post_bun_setup >"${output_file}" 2>&1 || status=$?
  local output
  output=$(cat "${output_file}")

  [ "${status}" -eq 17 ]
  [[ "$output" == *"daemon startup failed"* ]]
}

@test "cancellation terminates the post-Bun worker and its active child" {
  NON_INTERACTIVE=true
  INSTALL_AUTOMOBILE_CLI=true
  START_DAEMON=false
  INSTALL_CLAUDE_MARKETPLACE=false

  install_auto_mobile_cli() { sleep 20; }

  start_post_bun_setup
  local worker_pid="${POST_BUN_SETUP_PID}"
  local child_pid
  child_pid=$("${PGREP}" -P "${worker_pid}" sleep)

  cleanup_background_installer_work

  assert_process_is_not_active "${worker_pid}"
  assert_process_is_not_active "${child_pid}"
}

@test "cancellation passes a pattern to BSD pgrep when finding children" {
  NON_INTERACTIVE=true
  INSTALL_AUTOMOBILE_CLI=true
  START_DAEMON=false
  INSTALL_CLAUDE_MARKETPLACE=false

  install_auto_mobile_cli() { sleep 20; }

  start_post_bun_setup
  local worker_pid="${POST_BUN_SETUP_PID}"
  local child_pid
  child_pid=$("${PGREP}" -P "${worker_pid}" sleep)

  cat > "${STUB_BIN}/pgrep" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-P" && "${2:-}" == "${WORKER_PID}" && "${3:-}" == "." ]]; then
  printf '%s\n' "${CHILD_PID}"
  exit 0
fi
exit 1
STUB
  chmod +x "${STUB_BIN}/pgrep"
  export WORKER_PID="${worker_pid}"
  export CHILD_PID="${child_pid}"

  cleanup_background_installer_work

  assert_process_is_not_active "${worker_pid}"
  assert_process_is_not_active "${child_pid}"
}

@test "background cleanup succeeds when no work was started" {
  cleanup_background_installer_work
}

@test "dry-run setup stays synchronous so its plan remains in the parent shell" {
  NON_INTERACTIVE=true
  DRY_RUN=true
  INSTALL_AUTOMOBILE_CLI=true
  START_DAEMON=true
  INSTALL_CLAUDE_MARKETPLACE=false

  install_auto_mobile_cli() { DRY_RUN_LOG+=("[DRY-RUN] Install AutoMobile CLI with Bun"); }
  migrate_stale_daemon() { DRY_RUN_LOG+=("[DRY-RUN] Restart daemon for version upgrade"); }
  start_mcp_daemon() { DRY_RUN_LOG+=("[DRY-RUN] Start MCP daemon"); }

  start_post_bun_setup

  [ -z "${POST_BUN_SETUP_PID}" ]

  # This is the synchronous branch main takes when no background PID exists.
  install_auto_mobile_cli
  migrate_stale_daemon
  start_mcp_daemon
  [[ "${DRY_RUN_LOG[*]}" == *"Install AutoMobile CLI with Bun"* ]]
  [[ "${DRY_RUN_LOG[*]}" == *"Restart daemon for version upgrade"* ]]
  [[ "${DRY_RUN_LOG[*]}" == *"Start MCP daemon"* ]]
}
