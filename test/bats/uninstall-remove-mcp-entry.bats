#!/usr/bin/env bats

setup() {
  TEST_ROOT="${BATS_TEST_TMPDIR}"
  STUB_BIN="${TEST_ROOT}/bin"
  export HOME="${TEST_ROOT}/home" TMPDIR="${TEST_ROOT}/tmp" UNINSTALL_SH_SOURCE_ONLY=true
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
  source "${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"
  unset UNINSTALL_SH_SOURCE_ONLY
  DRY_RUN=false
}

teardown() {
  ! grep -Eq '^(pkill|killall|pgrep) ' "${PROCESS_CALLS}"
}

write_json_fixture() {
  cat > "$1" <<'JSON'
{"mcpServers":{"auto-mobile":{"command":"am"},"github":{"command":"gh"}},"projects":{"/Users/dev/code/auto-mobile":{"mcpServers":{"auto-mobile":{"command":"project-am"},"github":{"command":"project-gh"}},"note":"keep"},"/Users/dev/work/automobile-dealer-app":{"ok":true},"/Users/dev/other":{"ok":true}}}
JSON
}

@test "JSON removes only named entries, preserving projects and backup" {
  local path="${HOME}/claude.json"
  write_json_fixture "${path}"
  config_has_automobile "${path}" json
  remove_from_json_config "${path}"
  [ -f "${path}.bak" ]
  jq -e 'has("mcpServers") and (.mcpServers|has("github")) and (.mcpServers|has("auto-mobile")|not) and (.projects|length==3) and (.projects["/Users/dev/code/auto-mobile"].mcpServers|has("github")) and (.projects["/Users/dev/code/auto-mobile"].mcpServers|has("auto-mobile")|not)' "${path}"
  cmp -s <(jq -S 'del(.mcpServers["auto-mobile"], .projects[]?.mcpServers["auto-mobile"])' "${path}.bak") <(jq -S . "${path}")
}

@test "JSON works without jq using python3 and preserves valid structure" {
  local path="${HOME}/claude-nojq.json" bin="${TEST_ROOT}/nojq-bin"
  mkdir -p "${bin}"
  for tool in python3 cp mv rm dirname; do ln -s "$(command -v "${tool}")" "${bin}/${tool}"; done
  write_json_fixture "${path}"
  run env PATH="${STUB_BIN}:${bin}:/usr/bin:/bin" HOME="${HOME}" UNINSTALL_SH_SOURCE_ONLY=true /bin/bash -c 'source "$1"; remove_from_json_config "$2"' _ "${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh" "${path}"
  [ "${status}" -eq 0 ] || { echo "status=${status} output=${output}"; false; }
  [ -f "${path}.bak" ]
  "$(command -v python3)" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert "github" in d["mcpServers"] and "auto-mobile" not in d["mcpServers"]; assert len(d["projects"])==3' "${path}"
}

@test "TOML removes exact server and subtable only" {
  local path="${HOME}/config.toml"
  cat > "${path}" <<'TOML'
[mcp_servers.auto-mobile]
command = "am"

[mcp_servers.auto-mobile.env]
TOKEN = "x"

[projects."/x/auto-mobile"]
enabled = true

[mcp_servers.auto-mobile-dev]
command = "dev"
TOML
  remove_from_toml_config "${path}"
  [ -f "${path}.bak" ]
  run grep -q '^\[mcp_servers\.auto-mobile\]' "${path}"
  [ "${status}" -ne 0 ]
  grep -Fq '[projects."/x/auto-mobile"]' "${path}"
  grep -Fq '[mcp_servers.auto-mobile-dev]' "${path}"
}
