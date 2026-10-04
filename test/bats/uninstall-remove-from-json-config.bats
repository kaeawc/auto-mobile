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
# Tests for the jq-less JSON fallback in scripts/uninstall.sh
#
# Regression guard for #3638: the fallback reverted its own edit.
# `tmp_file="${path}.tmp"` is exactly the backup `sed -i.tmp` writes, and the
# `A || B && C` precedence ran `mv "${tmp_file}" "${path}"` after a *successful*
# in-place edit, restoring the original. So on machines without jq the
# uninstaller silently left auto-mobile entries in the MCP config.
#
# The fix guards the in-place edit with `if sed -i.tmp ...; then`. These are
# source-scan assertions (portable + deterministic across sed variants).

SCRIPT="scripts/uninstall.sh"

@test "in-place sed edit is not chained with '||' (the revert-prone form)" {
  # The buggy fallback was:
  #   sed -i.tmp -E '...' "${path}" || \
  #   sed -E '...' "${path}" > "${tmp_file}" && mv "${tmp_file}" "${path}"
  # i.e. an in-place `sed -i.tmp` followed by `||`. Fail if that reappears.
  run grep -nE 'sed +-i\.tmp.*\|\|' "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "in-place sed edit is guarded by 'if ... then'" {
  grep -qE 'if +sed +-i\.tmp' "$SCRIPT"
}

@test "the fallback still has a non-in-place sed branch (for seds lacking -i)" {
  # The else branch writes to a temp file then moves it into place.
  grep -qE 'mv +"\$\{tmp_file\}" +"\$\{path\}"' "$SCRIPT"
}
