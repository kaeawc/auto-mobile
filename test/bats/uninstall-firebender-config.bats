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

@test "dry-run detects an AutoMobile configuration in Firebender" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${test_home}/.firebender"
  printf '%s\n' '{"mcpServers":{"auto-mobile":{"command":"bunx"}}}' > "${test_home}/.firebender/firebender.json"

  run env HOME="${test_home}" bash scripts/uninstall.sh --all --dry-run --force

  [ "$status" -eq 0 ]
  [[ "$output" == *"Firebender (User)"* ]]
}

@test "dry-run finds project configuration from a nested Git directory" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  local test_project="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${test_project}/nested"
  git -C "${test_project}" init --quiet
  printf '%s\n' '{"mcpServers":{"auto-mobile":{"command":"bunx"}}}' > "${test_project}/.mcp.json"

  run env HOME="${test_home}" SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh" TEST_PROJECT="${test_project}" bash -c '
    cd "$TEST_PROJECT/nested"
    bash "$SCRIPT" --all --dry-run --force
  '

  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude Code (Project)"* ]]
}
