#!/usr/bin/env bats

setup() {
  TEST_ROOT="${BATS_TEST_TMPDIR}"
  GUARD_BIN="$PWD/scratch/guardbin"
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
  for tool in nc sleep; do
    cat > "${STUB_BIN}/${tool}" <<'STUB'
#!/usr/bin/env bash
# Never connect or wait on the host. nc refusal is the default probe result.
[[ -z "${NC_MESSAGE:-}" ]] || printf '%s\n' "${NC_MESSAGE}" >&2
[[ "${0##*/}" == nc ]] && exit "${NC_STATUS:-1}"
exit 0
STUB
    chmod +x "${STUB_BIN}/${tool}"
  done
  export PATH="${STUB_BIN}:${PATH}"
  export UNINSTALL_SH_SOURCE_ONLY=true
  source "${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"
  unset UNINSTALL_SH_SOURCE_ONLY
  daemon_termination_wait() { :; }
  export AUTOMOBILE_DAEMON_STOP_WAIT_ATTEMPTS=1 AUTOMOBILE_DAEMON_STOP_POLL_INTERVAL=0
  export SIGNALS="${TEST_ROOT}/signals" ALIVE="${TEST_ROOT}/alive"
  : > "${SIGNALS}"
  OWN_PID=424242
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
printf '%s\n' "${PID_COMMAND:-/opt/auto-mobile/dist/src/index.js --daemon-mode --daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH}}"
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
  [ "$status" -eq 3 ]
  [[ "$output" == *"not an AutoMobile daemon"* ]]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "socket without a PID record is retained with stop guidance" {
  rm "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
  run stop_daemon
  [ "$status" -eq 3 ]
  [[ "$output" == *"auto-mobile --daemon stop"* ]]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
}

@test "custom and relative paths honour primary and legacy precedence" {
  export AUTOMOBILE_DAEMON_LAUNCH_CWD="${TEST_ROOT}"
  export AUTOMOBILE_DAEMON_PID_FILE_PATH="custom.pid"
  export AUTOMOBILE_DAEMON_SOCKET_PATH="custom.sock"
  export AUTO_MOBILE_DAEMON_PID_FILE_PATH="ignored.pid"
  printf '{"pid":%s,"socketPath":"%s"}\n' "${OWN_PID}" "${TEST_ROOT}/custom.sock" > "${TEST_ROOT}/custom.pid"
  export PID_COMMAND="bun index.js --daemon-mode --daemon-socket-path=${TEST_ROOT}/custom.sock"
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
  [ "$status" -eq 3 ]
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
    [ "$status" -eq 3 ]
    [[ "$output" == *"valid PID record"* ]]
    [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
    [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  done
  [ ! -s "${SIGNALS}" ]
}

@test "without jq JSON is retained and a strict legacy PID can be stopped" {
  local no_jq="${TEST_ROOT}/no-jq" tool
  mkdir -p "${no_jq}"
  for tool in bash cat rm ps grep; do
    ln -s "$(command -v "${tool}")" "${no_jq}/${tool}"
  done
  export PATH="${no_jq}:${GUARD_BIN}"
  run stop_daemon
  [ "$status" -eq 3 ]
  [[ "$output" == *"jq is required"*"${AUTOMOBILE_DAEMON_PID_FILE_PATH}"*"auto-mobile --daemon stop"* ]]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [ ! -s "${SIGNALS}" ]
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
  [ "$status" -eq 3 ]
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
  [ "$status" -eq 3 ]
  [[ "$output" == *"not an AutoMobile daemon"* ]]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "another namespace marker never grants ownership" {
  export PID_COMMAND="bun index.js --daemon-mode --daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH}2"
  run stop_daemon
  [ "$status" -eq 3 ]
  [ ! -s "${SIGNALS}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [[ "$output" == *"auto-mobile --daemon stop"* ]]
}

# Bind only a BATS_TEST_TMPDIR socket; the child uses exported kill and PATH
# ps/nc stubs. Nothing probes the user's namespace.
stop_with_test_socket() {
  rm -f "${AUTOMOBILE_DAEMON_SOCKET_PATH}"
  export SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh" UNINSTALL_SH_SOURCE_ONLY=true
  bun -e '
    import { createServer } from "node:net";
    import { spawnSync } from "node:child_process";
    const server = createServer();
    server.listen(process.env.AUTOMOBILE_DAEMON_SOCKET_PATH, () => {
      const child = spawnSync("bash", ["-c", "source \"$SCRIPT\"; stop_daemon"], { encoding: "utf8" });
      process.stdout.write(child.stdout);
      server.close();
      process.exitCode = child.status ?? 1;
    });
  '
}

@test "unmarked older daemon requires matching record and a Unix socket" {
  export PID_COMMAND="bun index.js --daemon-mode"
  run stop_with_test_socket
  [ "$status" -eq 0 ]
  [ "$(cat "${SIGNALS}")" = "-TERM ${OWN_PID}" ]
}

@test "unmarked daemon without a socket is left alone" {
  export PID_COMMAND="bun index.js --daemon-mode"
  run stop_daemon
  [ "$status" -eq 3 ]
  [ ! -s "${SIGNALS}" ]
  [[ "$output" == *"auto-mobile --daemon stop"* ]]
}

@test "foreign record is retained even with matching argv or a dead PID" {
  printf '{"pid":%s,"socketPath":"/foreign.sock"}' "${OWN_PID}" > "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
  run stop_daemon
  [ "$status" -eq 3 ]
  [[ "$output" == *"Foreign daemon PID record"* ]]
  [ ! -s "${SIGNALS}" ]
  rm "${ALIVE}"
  run stop_daemon
  [ "$status" -eq 3 ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
}

@test "ambiguous invalid and malformed markers fail closed" {
  local argv
  for argv in \
    "--daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH} --daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH}" \
    "--daemon-socket-path=" \
    "--daemon-socket-path --other" \
    "--daemon-socket-path=%ZZ" \
    "--daemon-socket-path=%C0%AF" \
    "--daemon-socket-path=%ED%A0%80" \
    "--daemon-socket-path=%F4%90%80%80" \
    "--daemon-socket-path=%00" \
    "--daemon-socket-path='${AUTOMOBILE_DAEMON_SOCKET_PATH}"; do
    export PID_COMMAND="bun index.js --daemon-mode ${argv}"
    run stop_daemon
    [ "$status" -eq 3 ]
    [ ! -s "${SIGNALS}" ]
    [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  done
}

@test "name substring and daemon-mode alone are not identity" {
  printf '{"pid":%s}' "${OWN_PID}" > "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
  export PID_COMMAND="/fake/auto-mobile-pretender --daemon-mode"
  run stop_daemon
  [ "$status" -eq 3 ]
  [ ! -s "${SIGNALS}" ]
}

@test "quoted raw split marker and percent encoded marker match full tokens" {
  local marker
  for marker in "--daemon-socket-path '${AUTOMOBILE_DAEMON_SOCKET_PATH}'" \
    "--daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH//\//%2F}"; do
    touch "${ALIVE}"
    write_record
    export PID_COMMAND="bun index.js '--daemon-mode' ${marker}"
    run stop_daemon
    [ "$status" -eq 0 ]
    [ ! -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  done
  [ "$(wc -l < "${SIGNALS}" | tr -d ' ')" = 2 ]
}

@test "dead PID with accepting socket retains socket and record" {
  rm "${ALIVE}"
  export NC_STATUS=0
  run stop_daemon
  [ "$status" -eq 3 ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [[ "$output" == *"still accepts"*"auto-mobile --daemon stop"* ]]
}

@test "dead PID without nc retires only the stale PID record" {
  rm "${ALIVE}"
  local no_nc="${TEST_ROOT}/no-nc" tool
  mkdir -p "${no_nc}"
  for tool in bash cat rm ps jq grep; do
    ln -s "$(command -v "${tool}")" "${no_nc}/${tool}"
  done
  export PATH="${no_nc}:${GUARD_BIN}"
  run stop_daemon
  [ "$status" -eq 3 ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ ! -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [[ "$output" == *"auto-mobile --daemon stop"* ]]
}

@test "inconclusive socket probe retains socket and retires stale record" {
  rm "${ALIVE}"
  export NC_STATUS=2
  run stop_daemon
  [ "$status" -eq 3 ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ ! -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
}

@test "uninstall checks identity again immediately before TERM" {
  local reads="${TEST_ROOT}/reads"
  ps() {
    if [[ -e "${reads}" ]]; then printf 'bun index.js --daemon-mode --daemon-socket-path=/foreign.sock';
    else touch "${reads}"; printf '%s' "bun index.js --daemon-mode --daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH}"; fi
  }
  run stop_daemon
  [ "$status" -eq 3 ]
  [ ! -s "${SIGNALS}" ]
  [[ "$output" == *"identity changed"* ]]
}

@test "hot reload rejects another namespace and rechecks before KILL" {
  export HOT_RELOAD_SH_SOURCE_ONLY=true IGNORE_TERM=true
  source "${BATS_TEST_DIRNAME}/../../scripts/local-dev/hot-reload.sh"
  export PID_COMMAND="bun index.js --daemon-mode --daemon-socket-path=/foreign.sock"
  run stop_namespace_daemon_for_reload
  [ ! -s "${SIGNALS}" ]
  unset PID_COMMAND
  # The sourced helper calls this injected poll seam before escalation.
  sleep() { export PID_COMMAND="bun index.js --daemon-mode --daemon-socket-path=/foreign.sock"; }
  export -f sleep
  run stop_namespace_daemon_for_reload
  [ "$(cat "${SIGNALS}")" = "-TERM ${OWN_PID}" ]
}

@test "nc usage failure is inconclusive even with exit one" {
  rm "${ALIVE}"
  export NC_STATUS=1 NC_MESSAGE="nc: invalid option -- z"
  run stop_daemon
  [ "$status" -eq 3 ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [ ! -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [[ "$output" == *"auto-mobile --daemon stop"* ]]
}

@test "hot reload verifies again before TERM and retains a replaced record before KILL" {
  export HOT_RELOAD_SH_SOURCE_ONLY=true IGNORE_TERM=true READS="${TEST_ROOT}/reads"
  source "${BATS_TEST_DIRNAME}/../../scripts/local-dev/hot-reload.sh"
  ps() {
    if [[ -e "${READS}" ]]; then printf 'bun index.js --daemon-mode --daemon-socket-path=/foreign.sock';
    else touch "${READS}"; printf '%s' "bun index.js --daemon-mode --daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH}"; fi
  }
  export -f ps
  run stop_namespace_daemon_for_reload
  [ ! -s "${SIGNALS}" ]
  unset -f ps
  sleep() { printf '{"pid":424243,"socketPath":"/foreign.sock"}' > "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"; }
  export -f sleep
  run stop_namespace_daemon_for_reload
  [ "$(cat "${SIGNALS}")" = "-TERM ${OWN_PID}" ]
  [[ "$(cat "${AUTOMOBILE_DAEMON_PID_FILE_PATH}")" == *424243* ]]
}

@test "marker decoder preserves full path and rejects truncated UTF8" {
  local marker decoded
  for marker in '%C3' '%E2%82' '%F0%80%80%80' '%FF' '%2'; do
    run daemon_decode_socket_marker "${marker}"
    [ "$status" -ne 0 ]
  done
  decoded=$(daemon_decode_socket_marker '%2Ftmp%2F%C3%A9.sock')
  [ "${decoded}" = "/tmp/é.sock" ]
  # Raw absolute markers are used as-is, even with literal percent characters.
  decoded=$(daemon_decode_socket_marker '/tmp/%ZZ.sock')
  [ "${decoded}" = "/tmp/%ZZ.sock" ]
  export PID_COMMAND="bun index.js --daemon-mode --daemon-socket-path=${AUTOMOBILE_DAEMON_SOCKET_PATH//\//%2F}%0A"
  run stop_daemon
  [ ! -s "${SIGNALS}" ]
}

# Exercise main's real status/selection/summary and data removal, with binaries
# and configs represented by HOME sentinels. No host package-manager calls.
setup_main_fixture() {
  mkdir -p "${HOME}/.automobile"
  touch "${HOME}/cli" "${HOME}/desktop" "${HOME}/mcp" "${HOME}/marketplace"
  ensure_gum() { return 1; }
  detect_mcp_configs() { MCP_CONFIGS_FOUND=("fixture"); }
  detect_marketplace() { MARKETPLACE_INSTALLED=true; }
  detect_cli() { CLI_INSTALLED=true; }
  detect_desktop_app() { DESKTOP_APP_INSTALLED=true; DESKTOP_APP_PATHS=("${HOME}/Applications/AutoMobile.app"); }
  stop_desktop_app_processes() { printf 'desktop-stop\n' >> "${TEST_ROOT}/steps"; }
  remove_cli() { rm "${HOME}/cli"; }
  remove_desktop_app() { rm "${HOME}/desktop"; }
  remove_mcp_configs() { rm "${HOME}/mcp"; CHANGES_MADE=true; }
  remove_marketplace() { rm "${HOME}/marketplace"; CHANGES_MADE=true; }
}

assert_blocked_main() {
  [ "$status" -eq 3 ]
  [ -d "${HOME}/.automobile" ]
  [ -f "${HOME}/cli" ]
  [ -f "${HOME}/desktop" ]
  [ ! -e "${HOME}/mcp" ]
  [ ! -e "${HOME}/marketplace" ]
  [ "$(cat "${TEST_ROOT}/steps")" = desktop-stop ]
  [[ "$output" == *"Uninstall blocked"*"remove_cli"*"remove_data_dir"*"remove_desktop_app"*"auto-mobile --daemon stop"* ]]
  [[ "$output" != *"Uninstall complete"* ]]
}

@test "all uninstall without jq preserves data and binaries but removes independent configs" {
  setup_main_fixture
  local no_jq="${TEST_ROOT}/no-jq" tool
  mkdir -p "${no_jq}"
  for tool in bash cat rm ps grep; do
    ln -s "$(command -v "${tool}")" "${no_jq}/${tool}"
  done
  export PATH="${no_jq}:${GUARD_BIN}"
  run main --all --force
  assert_blocked_main
  [[ "$output" == *"jq is required"* ]]
  [ ! -s "${SIGNALS}" ]
}

@test "all uninstall with unverifiable identity preserves data and binaries" {
  setup_main_fixture
  export PID_COMMAND="/usr/bin/sleep 60"
  run main --all --force
  assert_blocked_main
  [ ! -s "${SIGNALS}" ]
}

@test "independent cleanup errors still reach the blocked summary and status" {
  setup_main_fixture
  export PID_COMMAND="/usr/bin/sleep 60"
  remove_mcp_configs() { return 1; }
  run main --all --force
  [ "$status" -eq 3 ]
  [ -d "${HOME}/.automobile" ]
  [ -f "${HOME}/cli" ]
  [ -f "${HOME}/desktop" ]
  [ -f "${HOME}/mcp" ]
  [ ! -e "${HOME}/marketplace" ]
  [[ "$output" == *"MCP configuration cleanup failed"*"Uninstall blocked"*"auto-mobile --daemon stop"* ]]
}

@test "all uninstall after verified stop removes selected data binaries and configs" {
  setup_main_fixture
  run main --all --force
  [ "$status" -eq 0 ]
  [ ! -e "${HOME}/.automobile" ]
  [ ! -e "${HOME}/cli" ]
  [ ! -e "${HOME}/desktop" ]
  [ ! -e "${HOME}/mcp" ]
  [ ! -e "${HOME}/marketplace" ]
  [[ "$output" == *"Uninstall complete"* ]]
}

@test "all uninstall with empty desktop app paths removes selected data binaries and configs" {
  setup_main_fixture
  detect_desktop_app() { DESKTOP_APP_INSTALLED=true; DESKTOP_APP_PACKAGE=""; DESKTOP_APP_PATHS=(); }
  run main --all --force
  [ "$status" -eq 0 ]
  [ ! -e "${HOME}/.automobile" ]
  [ ! -e "${HOME}/cli" ]
  [ ! -e "${HOME}/desktop" ]
  [ ! -e "${HOME}/mcp" ]
  [ ! -e "${HOME}/marketplace" ]
  [[ "$output" == *"Uninstall complete"* ]]
}

@test "all uninstall with no namespace files removes selected components" {
  setup_main_fixture
  rm "${AUTOMOBILE_DAEMON_SOCKET_PATH}" "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"
  run main --all --force
  [ "$status" -eq 0 ]
  [ ! -e "${HOME}/.automobile" ]
  [ ! -e "${HOME}/cli" ]
  [ ! -e "${HOME}/desktop" ]
  [ ! -e "${HOME}/mcp" ]
  [ ! -e "${HOME}/marketplace" ]
  [ ! -s "${SIGNALS}" ]
}

@test "daemon paths normalize lexically without requiring existing targets" {
  export AUTOMOBILE_DAEMON_LAUNCH_CWD=/tmp/x/launch
  local entry input expected
  for entry in \
    '../daemon.sock|/tmp/x/daemon.sock' \
    './a/../b|/tmp/x/launch/b' \
    'a//b///|/tmp/x/launch/a/b' \
    '../../../..//daemon.sock/|/daemon.sock' \
    '/tmp//x/./a/../daemon.sock/|/tmp/x/daemon.sock' \
    '/../../..///|/' \
    '~user/daemon.sock|/tmp/x/launch/~user/daemon.sock'; do
    input="${entry%%|*}"; expected="${entry#*|}"
    export AUTOMOBILE_DAEMON_SOCKET_PATH="${input}" AUTOMOBILE_DAEMON_PID_FILE_PATH="${input}"
    run daemon_path AUTOMOBILE_DAEMON_SOCKET_PATH AUTO_MOBILE_DAEMON_SOCKET_PATH sock
    [ "$status" -eq 0 ]; [ "$output" = "${expected}" ]
    run daemon_path AUTOMOBILE_DAEMON_PID_FILE_PATH AUTO_MOBILE_DAEMON_PID_FILE_PATH pid
    [ "$status" -eq 0 ]; [ "$output" = "${expected}" ]
  done
}

@test "unverifiable launch cwd and newline paths fail closed" {
  export AUTOMOBILE_DAEMON_LAUNCH_CWD=relative AUTOMOBILE_DAEMON_SOCKET_PATH=daemon.sock
  run daemon_path AUTOMOBILE_DAEMON_SOCKET_PATH AUTO_MOBILE_DAEMON_SOCKET_PATH sock
  [ "$status" -ne 0 ]
  run stop_daemon
  [ "$status" -eq 3 ]
  [[ "$output" == *"Unverifiable daemon socket path"*"auto-mobile --daemon stop"* ]]
  export AUTOMOBILE_DAEMON_SOCKET_PATH=$'/tmp/path\n.sock'
  run daemon_path AUTOMOBILE_DAEMON_SOCKET_PATH AUTO_MOBILE_DAEMON_SOCKET_PATH sock
  [ "$status" -ne 0 ]
  [ ! -s "${SIGNALS}" ]
}

@test "normalized relative namespace stops the verified daemon" {
  export AUTOMOBILE_DAEMON_LAUNCH_CWD="${TEST_ROOT}/launch" AUTOMOBILE_DAEMON_SOCKET_PATH=../daemon.sock AUTOMOBILE_DAEMON_PID_FILE_PATH=../daemon.pid
  export PID_COMMAND="bun index.js --daemon-mode --daemon-socket-path=${TEST_ROOT}/daemon.sock"
  run stop_daemon
  [ "$status" -eq 0 ]
  [ ! -e "${TEST_ROOT}/daemon.pid" ]
}

@test "hot reload fails before invoking restart on an unverifiable daemon" {
  export HOT_RELOAD_SH_SOURCE_ONLY=true PID_COMMAND="/usr/bin/sleep 60"
  source "${BATS_TEST_DIRNAME}/../../scripts/local-dev/hot-reload.sh"
  auto-mobile() { printf 'restart invoked\n' >> "${TEST_ROOT}/restart"; }
  export -f auto-mobile
  run reload_mcp_daemon
  [ "$status" -eq 3 ]
  [ ! -e "${TEST_ROOT}/restart" ]
  [ ! -s "${SIGNALS}" ]
  [[ "$output" == *"Hot reload blocked"*"auto-mobile --daemon stop"* ]]
}

@test "post-stop accepting socket blocks removal and retains the record" {
  export NC_STATUS=0
  run stop_daemon
  [ "$status" -eq 3 ]
  [ ! -e "${ALIVE}" ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
}

@test "TERM failure is unconfirmed and does not escalate in reload" {
  kill() { [[ "$1" == -0 ]]; }
  run stop_daemon reload
  [ "$status" -eq 3 ]
  [ -e "${AUTOMOBILE_DAEMON_PID_FILE_PATH}" ]
  [ ! -s "${SIGNALS}" ]
}

@test "changed PID record after stop blocks cleanup" {
  wait_for_daemon_to_stop() { printf '{"pid":424243}' > "${AUTOMOBILE_DAEMON_PID_FILE_PATH}"; return 0; }
  run stop_daemon
  [ "$status" -eq 3 ]
  [ -e "${AUTOMOBILE_DAEMON_SOCKET_PATH}" ]
  [[ "$output" == *"PID record changed"*"auto-mobile --daemon stop"* ]]
}
