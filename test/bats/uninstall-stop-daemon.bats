#!/usr/bin/env bats

setup() {
  TEST_ROOT="${BATS_TEST_TMPDIR}"
  STUB_BIN="${TEST_ROOT}/bin"
  export HOME="${TEST_ROOT}/home" TMPDIR="${TEST_ROOT}/tmp"
  export AUTOMOBILE_DAEMON_SOCKET_PATH="${TEST_ROOT}/daemon.sock"
  export AUTOMOBILE_DAEMON_PID_FILE_PATH="${TEST_ROOT}/daemon.pid"
  export AUTOMOBILE_DAEMON_LOCK_FILE_PATH="${TEST_ROOT}/daemon.lock"
  export PROCESS_CALLS="${TEST_ROOT}/process-calls.log"
  mkdir -p "${HOME}" "${TMPDIR}" "${STUB_BIN}"
  : > "${PROCESS_CALLS}"
  local tool
  for tool in pkill killall pgrep; do
    cat > "${STUB_BIN}/${tool}" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >> "${PROCESS_CALLS}"
exit 1
STUB
    chmod +x "${STUB_BIN}/${tool}"
  done
  cat > "${STUB_BIN}/ps" <<'STUB'
#!/usr/bin/env bash
printf 'ps %s\n' "$*" >> "${PROCESS_CALLS}"
# Empty process table: never inspect the developer's processes.
exit 0
STUB
  chmod +x "${STUB_BIN}/ps"
  # Bash uses a builtin kill; PATH alone cannot intercept it.
  kill() { printf 'kill %s\n' "$*" >> "${PROCESS_CALLS}"; return 1; }
  export -f kill
  export PATH="${STUB_BIN}:${PATH}"
  export UNINSTALL_SH_SOURCE_ONLY=true
  source "${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"
  unset UNINSTALL_SH_SOURCE_ONLY
  daemon_termination_wait() { :; }
  export AUTOMOBILE_DAEMON_STOP_WAIT_ATTEMPTS=1 AUTOMOBILE_DAEMON_STOP_POLL_INTERVAL=0
  export SIGNALS="${TEST_ROOT}/signals" ALIVE="${TEST_ROOT}/alive"
  : > "${SIGNALS}"
  sleep 60 &
  OWN_PID=$!
  export OWN_PID
  touch "${ALIVE}"
  kill() {
    printf 'kill %s\n' "$*" >> "${PROCESS_CALLS}"
    [[ "$2" == "${OWN_PID}" ]] || return 1
    if [[ "$1" == "-0" ]]; then
      [[ -e "${ALIVE}" ]]
    else
      printf '%s %s\n' "$1" "$2" >> "${SIGNALS}"
      [[ "${IGNORE_TERM:-false}" == true && "$1" == -TERM ]] || rm -f "${ALIVE}"
    fi
  }
  export -f kill
  cat > "${STUB_BIN}/ps" <<'STUB'
#!/usr/bin/env bash
printf 'ps %s\n' "$*" >> "${PROCESS_CALLS}"
[[ "$1" == -p && "$2" == "${OWN_PID}" && -e "${ALIVE}" ]] || exit 1
printf '%s\n' "${PID_COMMAND:-/opt/auto-mobile/dist/src/index.js --daemon-mode}"
STUB
  chmod +x "${STUB_BIN}/ps"
  write_record
}

write_record() {
  printf '{"pid":%s,"socketPath":"%s","port":3000,"version":"0.0.1"}\n' "${OWN_PID}" "${AUTOMOBILE_DAEMON_SOCKET_PATH}" > "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
  # A filesystem sentinel suffices for stop; detection's socket branch is
  # tested independently below.
  touch "${AUTOMOBILE_DAEMON_SOCKET_PATH}"
}

teardown() {
  # This is the only real signal: the sleep created by this test, by exact PID.
  builtin kill -TERM "${OWN_PID}" 2>/dev/null || true
  wait "${OWN_PID}" 2>/dev/null || true
  ! grep -Eq '^(pkill|killall|pgrep) ' "${PROCESS_CALLS}"
}

@test "TERM targets only the namespace PID and removes files after exit" {
  run stop_daemon
  [ "$status" -eq 0 ]
  [ "$(cat "${SIGNALS}")" = "-TERM ${OWN_PID}" ]
  [ ! -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ ! -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "reused live PID is neither signalled nor unlinked" {
  export PID_COMMAND="/usr/bin/sleep 60"
  run stop_daemon
  [ "$status" -eq 0 ]
  [[ "$output" == *"not an AutoMobile daemon"* ]]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "socket without a PID record is retained with stop guidance" {
  rm "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
  run stop_daemon
  [[ "$output" == *"auto-mobile --daemon stop"* ]]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
}

@test "custom and relative paths honour primary and legacy precedence" {
  export AUTOMOBILE_DAEMON_LAUNCH_CWD="${TEST_ROOT}"
  export AUTOMOBILE_DAEMON_PID_FILE_PATH="custom.pid"
  export AUTOMOBILE_DAEMON_SOCKET_PATH="custom.sock"
  export AUTO_MOBILE_DAEMON_PID_FILE_PATH="ignored.pid"
  cp "${TEST_ROOT}/daemon.pid" "${TEST_ROOT}/custom.pid"
  touch "${TEST_ROOT}/custom.sock"
  run stop_daemon
  [ ! -e "${TEST_ROOT}/custom.pid" ]
  [ ! -e "${TEST_ROOT}/custom.sock" ]
  [ -e "${TEST_ROOT}/daemon.pid" ]
  [ -e "${TEST_ROOT}/daemon.sock" ]
  # Check defaults by string only: never read/write the real default namespace.
  export AUTOMOBILE_DAEMON_PID_FILE_PATH=""
  [ "$(daemon_path AUTOMOBILE_DAEMON_PID_FILE_PATH AUTO_MOBILE_DAEMON_PID_FILE_PATH pid)" = "/tmp/auto-mobile-daemon-$(id -u).pid" ]
  unset AUTOMOBILE_DAEMON_PID_FILE_PATH
  [ "$(daemon_path AUTOMOBILE_DAEMON_PID_FILE_PATH AUTO_MOBILE_DAEMON_PID_FILE_PATH pid)" = "${TEST_ROOT}/ignored.pid" ]
}

@test "dry run retains files and signals nothing" {
  DRY_RUN=true
  run stop_daemon
  [[ "$output" == *"[DRY-RUN] Would stop MCP daemon"* ]]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "detection uses only socket or verified PID and never pgrep" {
  detect_daemon
  [ "${DAEMON_RUNNING}" = true ]
  export PID_COMMAND="auto-mobile daemon without-mode"
  detect_daemon
  [ "${DAEMON_RUNNING}" = false ]
  ! grep -q '^pgrep ' "${PROCESS_CALLS}"
}

@test "dead PID record removes stale files without a signal" {
  rm "${ALIVE}"
  run stop_daemon
  [[ "$output" == *"removing stale namespace files"* ]]
  [ ! -s "${SIGNALS}" ]
  [ ! -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ ! -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "bounded TERM wait retains files and never escalates" {
  export IGNORE_TERM=true
  run stop_daemon
  [[ "$output" == *"within 10 seconds"*"auto-mobile --daemon stop"* ]]
  [ "$(cat "${SIGNALS}")" = "-TERM ${OWN_PID}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "invalid PID values fail closed" {
  local record
  for record in '{"pid":1}' '{"pid":-2}' '{"pid":"123"}' '{"pid":2.5}' '{"pid":999999999999999999999999}' '{"pid":22'; do
    printf '%s' "${record}" > "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
    run stop_daemon
    [[ "$output" == *"valid PID record"* ]]
    [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
    [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  done
  [ ! -s "${SIGNALS}" ]
}

@test "without jq JSON is retained and a strict legacy PID can be stopped" {
  command_exists() { [[ "$1" != jq ]]; }
  run stop_daemon
  [[ "$output" == *"valid PID record"* ]]
  printf '%s\n' "${OWN_PID}" > "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
  run stop_daemon
  [ "$(cat "${SIGNALS}")" = "-TERM ${OWN_PID}" ]
}

@test "hot reload only escalates the same verified namespace PID" {
  export HOT_RELOAD_SH_SOURCE_ONLY=true IGNORE_TERM=true
  source "${BATS_TEST_DIRNAME}/../../scripts/local-dev/hot-reload.sh"
  run stop_namespace_daemon_for_reload
  [ "$status" -eq 0 ]
  [ "$(cat "${SIGNALS}")" = "$(printf '%s %s\n%s %s' -TERM "${OWN_PID}" -KILL "${OWN_PID}")" ]
}

@test "hot reload preserves a live unrelated namespace PID" {
  export HOT_RELOAD_SH_SOURCE_ONLY=true PID_COMMAND="/usr/bin/sleep 60"
  source "${BATS_TEST_DIRNAME}/../../scripts/local-dev/hot-reload.sh"
  run stop_namespace_daemon_for_reload
  [ "$status" -eq 0 ]
  [ ! -s "${SIGNALS}" ]
}

@test "detection recognises an isolated Unix socket without a PID file" {
  rm "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" "${AUTOMOBILE_DAEMON_SOCKET_PATH}"
  export SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh" UNINSTALL_SH_SOURCE_ONLY=true
  run bun -e '
    import { createServer } from "node:net";
    import { spawnSync } from "node:child_process";
    const server = createServer();
    server.listen(process.env.AUTOMOBILE_DAEMON_SOCKET_PATH, () => {
      const child = spawnSync("bash", ["-c", "source \"$SCRIPT\"; detect_daemon; echo \"$DAEMON_RUNNING\""], { encoding: "utf8" });
      process.stdout.write(child.stdout);
      server.close();
      process.exitCode = child.status ?? 1;
    });
  '
  [ "$status" -eq 0 ]
  [ "$output" = true ]
  [ ! -s "${SIGNALS}" ]
  ! grep -q '^pgrep ' "${PROCESS_CALLS}"
}

@test "an unreadable live PID is preserved when kill probe fails" {
  kill() { printf 'kill %s\n' "$*" >> "${PROCESS_CALLS}"; return 1; }
  export -f kill
  run stop_daemon
  [[ "$output" == *"not an AutoMobile daemon"* ]]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}
