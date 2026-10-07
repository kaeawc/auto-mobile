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
  for tool in nc sleep; do
    cat > "${STUB_BIN}/${tool}" <<'STUB'
#!/usr/bin/env bash
# Never connect or wait on the host. nc refusal is the default probe result.
[[ "${0##*/}" == nc ]] && exit "${NC_STATUS:-1}"
exit 0
STUB
    chmod +x "${STUB_BIN}/${tool}"
  done
  export PATH="${STUB_BIN}:${PATH}"
}

teardown() {
  ! grep -Eq '^(pkill|killall|pgrep) ' "${PROCESS_CALLS}"
}
#
# The jq-less path uses Python's JSON parser and never falls back to line edits.

SCRIPT="scripts/uninstall.sh"

@test "JSON cleanup has no destructive sed fallback" {
  run grep -nE 'sed +-i\.tmp|sed +-E' "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "JSON cleanup uses structured Python fallback" {
  grep -q 'command_exists_check python3' "$SCRIPT"
  grep -q 'json.load' "$SCRIPT"
}
