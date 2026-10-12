#!/usr/bin/env bats

setup_file() {
  MOCK_BIN="${BATS_FILE_TMPDIR}/bin"
  mkdir -p "${MOCK_BIN}" "${BATS_FILE_TMPDIR}/batch/daemon1"
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${COMMAND_LOG}"
MOCK
  cat > "${MOCK_BIN}/check-env" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$AUTOMOBILE_AUX_SOCKET_DIR" "$AUTOMOBILE_DAEMON_SOCKET_PATH" "$MT_SERVER" "$PWD" "$@" >> "${COMMAND_LOG}"
MOCK
  chmod +x "${MOCK_BIN}/bun" "${MOCK_BIN}/check-env"
}

setup() {
  MOCK_BIN="${BATS_FILE_TMPDIR}/bin"
  BATCH="${BATS_FILE_TMPDIR}/batch"
  COMMAND_LOG="${BATS_TEST_TMPDIR}/commands.log"
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/manual-test/in-daemon-env.sh"
  export COMMAND_LOG
  export PATH="${MOCK_BIN}:${PATH}"
  printf '%s\n' 'export AUTOMOBILE_AUX_SOCKET_DIR=/fake/aux' \
    'export AUTOMOBILE_DAEMON_SOCKET_PATH=/fake/aux/d.sock' \
    "export MT_SERVER='/fake/built entry.js'" > "${BATCH}/daemon1/env.sh"
  unset AUTOMOBILE_AUX_SOCKET_DIR AUTOMOBILE_DAEMON_SOCKET_PATH
}

@test "argument errors exit 2 without running a command" {
  for scenario in missing-batch missing-daemon missing-value unknown nonnumeric zero missing-file no-command; do
    case "${scenario}" in
      missing-batch) args=(--daemon 1 check-env) ;;
      missing-daemon) args=(--batch-dir "${BATCH}" check-env) ;;
      missing-value) args=(--batch-dir) ;;
      unknown) args=(--wat x) ;;
      nonnumeric) args=(--batch-dir "${BATCH}" --daemon x check-env) ;;
      zero) args=(--batch-dir "${BATCH}" --daemon 0 check-env) ;;
      missing-file) args=(--batch-dir "${BATCH}" --daemon 2 check-env) ;;
      no-command) args=(--batch-dir "${BATCH}" --daemon 1 --) ;;
    esac
    run bash "${SCRIPT}" "${args[@]}"
    [ "${status}" -eq 2 ]
    [[ "${output}" == *Usage:* ]]
    [ ! -f "${COMMAND_LOG}" ]
  done
}

@test "exec loads env, preserves cwd and argv including spaces" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 -- check-env 'one two'
  [ "${status}" -eq 0 ]
  expected="$(printf '%s\n' /fake/aux /fake/aux/d.sock '/fake/built entry.js' "$PWD" 'one two')"
  [ "$(cat "${COMMAND_LOG}")" = "${expected}" ]
}

@test "daemon shorthand uses built server and --daemon" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 daemon status --debug
  [ "${status}" -eq 0 ]
  expected="$(printf '%s\n' '/fake/built entry.js' --daemon status --debug)"
  [ "$(cat "${COMMAND_LOG}")" = "${expected}" ]
}

@test "proxy shorthand uses repository driver" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 proxy status --dir /fake/session
  [ "${status}" -eq 0 ]
  repo="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  expected="$(printf '%s\n' "${repo}/scripts/manual-test/proxy-session.ts" status --dir /fake/session)"
  [ "$(cat "${COMMAND_LOG}")" = "${expected}" ]
}

@test "missing and relative auxiliary/socket env paths are refused" {
  for content in 'export MT_SERVER=/fake/server' 'export AUTOMOBILE_AUX_SOCKET_DIR=relative; export AUTOMOBILE_DAEMON_SOCKET_PATH=/fake/socket' 'export AUTOMOBILE_AUX_SOCKET_DIR=/fake/aux; export AUTOMOBILE_DAEMON_SOCKET_PATH=relative'; do
    printf '%s\n' "${content}" > "${BATCH}/daemon1/env.sh"
    run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 check-env
    [ "${status}" -eq 2 ]
    [ ! -f "${COMMAND_LOG}" ]
  done
}

@test "daemon start shorthand refuses the default port policy" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 daemon start
  [ "${status}" -eq 2 ]
  [[ "${output}" == *'use private-daemon.ts start, which owns --port --strict-port; a restart is stop + start'* ]]
  [ ! -f "${COMMAND_LOG}" ]
}

@test "daemon restart shorthand refuses and directs stop plus owned start" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 daemon restart
  [ "${status}" -eq 2 ]
  [[ "${output}" == *'a restart is stop + start'* ]]
  [ ! -f "${COMMAND_LOG}" ]
}

@test "frame shorthand uses repository raw-frame driver and preserves args" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 frame send ide/status '{"a":"one two"}'
  [ "${status}" -eq 0 ]
  repo="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  expected="$(printf '%s\n' "${repo}/scripts/manual-test/daemon-frame.ts" send ide/status '{"a":"one two"}')"
  [ "$(cat "${COMMAND_LOG}")" = "${expected}" ]
}

@test "aux shorthand uses repository auxiliary driver" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 aux recording status --observer
  [ "${status}" -eq 0 ]
  repo="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  expected="$(printf '%s\n' "${repo}/scripts/manual-test/aux-socket.ts" recording status --observer)"
  [ "$(cat "${COMMAND_LOG}")" = "${expected}" ]
}

@test "daemon restart-admitted shorthand refuses before launching" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 daemon restart-admitted
  [ "${status}" -eq 2 ]
  [[ "${output}" == *'use private-daemon.ts start'* ]]
  [ ! -f "${COMMAND_LOG}" ]
}

@test "daemon restart-acceptance-session shorthand refuses before launching" {
  run bash "${SCRIPT}" --batch-dir "${BATCH}" --daemon 1 daemon restart-acceptance-session
  [ "${status}" -eq 2 ]
  [[ "${output}" == *'use private-daemon.ts start'* ]]
  [ ! -f "${COMMAND_LOG}" ]
}
