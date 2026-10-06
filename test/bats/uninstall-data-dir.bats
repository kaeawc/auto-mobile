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
  export UNINSTALL_SH_SOURCE_ONLY=true
  source "${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"
  unset UNINSTALL_SH_SOURCE_ONLY
}

teardown() {
  ! grep -Eq '^(pkill|killall|pgrep) ' "${PROCESS_CALLS}"
}

@test "detects and removes configured and legacy data directories" {
  export AUTOMOBILE_DATA_DIR="${HOME}/.auto-mobile"
  mkdir -p "${AUTOMOBILE_DATA_DIR}" "${HOME}/.automobile"
  mkdir -p "${HOME}/.automobile/bin"
  touch "${AUTOMOBILE_DATA_DIR}/auto-mobile.db" "${HOME}/.automobile/bin/gum"
  detect_data_dir
  [ "${DATA_DIR_EXISTS}" = true ]
  remove_data_dir
  [ ! -e "${AUTOMOBILE_DATA_DIR}/auto-mobile.db" ]
  [ ! -e "${HOME}/.automobile/bin/gum" ]
}

@test "dry run lists both data paths and preserves them" {
  export AUTOMOBILE_DATA_DIR="${HOME}/.auto-mobile" DRY_RUN=true
  mkdir -p "${AUTOMOBILE_DATA_DIR}" "${HOME}/.automobile"
  detect_data_dir
  run remove_data_dir
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"${AUTOMOBILE_DATA_DIR}"* ]]
  [[ "${output}" == *"${HOME}/.automobile"* ]]
  [ -d "${AUTOMOBILE_DATA_DIR}" ] && [ -d "${HOME}/.automobile" ]
}

@test "detects product data directory alone and honors override" {
  mkdir -p "${HOME}/.auto-mobile"
  detect_data_dir
  [ "${DATA_DIR_EXISTS}" = true ]
  local override="${HOME}/custom-data"
  mkdir -p "${override}"
  export AUTOMOBILE_DATA_DIR="${override}"
  detect_data_dir
  [ "${DATA_DIR_EXISTS}" = true ]
  remove_data_dir
  [ ! -e "${override}" ]
  [ -d "${HOME}/.auto-mobile" ]
}

@test "refuses unsafe data paths" {
  export AUTOMOBILE_DATA_DIR="${HOME}"
  DATA_DIR_EXISTS=true
  run remove_data_dir
  [ "${status}" -ne 0 ]
  [ -d "${HOME}" ]
}
