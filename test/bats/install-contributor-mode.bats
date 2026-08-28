#!/usr/bin/env bats

@test "development and local-dev presets require contributor mode" {
  run bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    parse_args --preset development
  '

  [ "$status" -eq 1 ]
  [[ "$output" == *"Re-run with --contributor"* ]]
}

@test "contributor mode automatically selects the development preset" {
  run bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    parse_args --contributor
    [[ "$CONTRIBUTOR_MODE" == "true" ]]
    [[ "$PRESET" == "development" ]]
  '

  [ "$status" -eq 0 ]
}

@test "installer requires Bun but does not check or manage Node.js" {
  run bash -c '
    ! rg -q "REQUIRED_NODE_MAJOR|Checking Node\\.js|NVM_DIR|nvm (ls|use|install)" scripts/install.sh
  '

  [ "$status" -eq 0 ]
}

@test "the end-user menu does not include a development route" {
  local options_file
  options_file="${BATS_TEST_TMPDIR}/installer-options"

  run env OPTIONS_FILE="${options_file}" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    CLAUDE_CLI_INSTALLED=true
    is_claude_code_installed() { return 1; }
    is_claude_desktop_installed() { return 1; }
    is_cursor_installed() { return 1; }
    is_windsurf_installed() { return 1; }
    is_vscode_installed() { return 1; }
    is_codex_installed() { return 1; }
    is_codex_user_installed() { return 1; }
    is_goose_installed() { return 1; }
    gum() {
      if [[ "$1" == "filter" ]]; then
        cat > "$OPTIONS_FILE"
        printf "skip\n"
      fi
    }
    select_preset || true
    ! grep -q "Development" "$OPTIONS_FILE"
  '

  [ "$status" -eq 0 ]
}

@test "end-user installs explain when an MCP client is required" {
  run bash -c '
    test_home=$(mktemp -d)
    export HOME="$test_home"
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    CLAUDE_CLI_INSTALLED=false
    client_base_has_config() { return 1; }
    is_claude_code_installed() { return 1; }
    is_claude_desktop_installed() { return 1; }
    is_cursor_installed() { return 1; }
    is_windsurf_installed() { return 1; }
    is_vscode_installed() { return 1; }
    is_codex_installed() { return 1; }
    is_codex_user_installed() { return 1; }
    is_goose_installed() { return 1; }
    error_message=""
    log_error() { error_message="$1"; }
    if select_preset; then
      exit 1
    fi
    [[ "$error_message" == *"No supported MCP client was detected"* ]]
  '

  [ "$status" -eq 0 ]
}

@test "detects Claude Code and Codex project configuration" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  local test_project="${BATS_TEST_TMPDIR}/project"
  local test_bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${test_home}/.claude" "${test_home}/.codex" "${test_project}/.codex" "${test_bin}"
  touch "${test_bin}/claude"
  chmod +x "${test_bin}/claude"
  touch "${test_project}/.mcp.local.json"

  run env HOME="${test_home}" TEST_PROJECT="${test_project}" PATH="${test_bin}:/usr/bin:/bin" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    PROJECT_ROOT="$TEST_PROJECT"
    MCP_PROJECT_ROOT="$TEST_PROJECT"
    MCP_CONFIG_SCOPE=project
    detect_mcp_clients
    printf "%s\n" "${MCP_CLIENT_LIST[@]}" | grep -F "Claude Code (Project)|${TEST_PROJECT}/.mcp.json|json|local"
    printf "%s\n" "${MCP_CLIENT_LIST[@]}" | grep -F "Codex (Project)|${TEST_PROJECT}/.codex/config.toml|toml|local"
    ! printf "%s\n" "${MCP_CLIENT_LIST[@]}" | grep -q ".mcp.local.json"
  '

  [ "$status" -eq 0 ]
}

@test "detects user configuration paths for newly installed Claude Code and Codex" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  local test_project="${BATS_TEST_TMPDIR}/project"
  local test_bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${test_home}" "${test_project}" "${test_bin}"
  touch "${test_bin}/claude" "${test_bin}/codex"
  chmod +x "${test_bin}/claude" "${test_bin}/codex"

  run env HOME="${test_home}" TEST_PROJECT="${test_project}" PATH="${test_bin}:/usr/bin:/bin" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    PROJECT_ROOT="$TEST_PROJECT"
    MCP_CONFIG_SCOPE=global
    detect_mcp_clients
    printf "%s\n" "${MCP_CLIENT_LIST[@]}" | grep -F "Claude Code (User)|${HOME}/.claude.json|json|global"
    printf "%s\n" "${MCP_CLIENT_LIST[@]}" | grep -F "Codex (User)|${HOME}/.codex/config.toml|toml|global"
  '

  [ "$status" -eq 0 ]
}

@test "treats an existing project .codex directory as Codex installation" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  local test_project="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${test_home}" "${test_project}/.codex"

  run env HOME="${test_home}" TEST_PROJECT="${test_project}" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    PROJECT_ROOT="$TEST_PROJECT"
    MCP_PROJECT_ROOT="$TEST_PROJECT"
    command_exists() { return 1; }
    is_codex_installed
    ! is_codex_user_installed
  '

  [ "$status" -eq 0 ]
}

@test "uses the Git project root for project-scoped configuration" {
  local test_project="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${test_project}/nested"
  git -C "${test_project}" init --quiet

  run env TEST_PROJECT="${test_project}" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    INVOCATION_DIR="$TEST_PROJECT/nested"
    detect_invocation_project
    [[ "$INVOKED_IN_GIT_REPO" == "true" ]]
    [[ "$(cd "$MCP_PROJECT_ROOT" && pwd -P)" == "$(cd "$TEST_PROJECT" && pwd -P)" ]]
  '

  [ "$status" -eq 0 ]
}

@test "defaults a Git invocation to project-scoped setup in non-interactive mode" {
  run bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    NON_INTERACTIVE=true
    INVOKED_IN_GIT_REPO=true
    select_mcp_config_scope
    [[ "$MCP_CONFIG_SCOPE" == "project" ]]
  '

  [ "$status" -eq 0 ]
}

@test "dry-run and record mode select a scope without prompting" {
  run bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    gum() { return 99; }

    DRY_RUN=true
    INVOKED_IN_GIT_REPO=true
    select_mcp_config_scope
    [[ "$MCP_CONFIG_SCOPE" == "project" ]]

    DRY_RUN=false
    RECORD_MODE=true
    INVOKED_IN_GIT_REPO=false
    select_mcp_config_scope
    [[ "$MCP_CONFIG_SCOPE" == "global" ]]
  '

  [ "$status" -eq 0 ]
}

@test "installation progress keeps every planned step visible and marks the current step" {
  run bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    gum() { printf "%s\n" "$*"; }
    set_installation_steps "Choose setup scope" "Select agent configurations" "Apply configuration"
    show_installation_progress 2
  '

  [ "$status" -eq 0 ]
  [[ "$output" == *"1.   Choose setup scope"* ]]
  [[ "$output" == *"2. → Select agent configurations"* ]]
  [[ "$output" == *"3.   Apply configuration"* ]]
}

@test "dry-run does not create a missing Codex configuration directory" {
  local test_home="${BATS_TEST_TMPDIR}/home"

  run env HOME="${test_home}" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    DRY_RUN=true
    NON_INTERACTIVE=true
    merge_toml_config() { printf "%s" "$2"; }
    gum() { :; }
    config_path="$HOME/.codex/config.toml"
    update_mcp_client_config "Codex (User)" "$config_path" "[mcp_servers.auto-mobile]" toml
    [[ ! -e "$config_path" ]]
    [[ ! -d "${config_path%/*}" ]]
    [[ "${DRY_RUN_LOG[*]}" == *"Configure Codex (User): $config_path"* ]]
  '

  [ "$status" -eq 0 ]
}

@test "declining an interactive config preview does not create its directory" {
  local test_home="${BATS_TEST_TMPDIR}/home"

  run env HOME="${test_home}" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    merge_toml_config() { printf "%s" "$2"; }
    gum() {
      if [[ "$1" == "confirm" ]]; then
        return 1
      fi
    }
    config_path="$HOME/.codex/config.toml"
    update_mcp_client_config "Codex (User)" "$config_path" "[mcp_servers.auto-mobile]" toml
    [[ ! -e "$config_path" ]]
    [[ ! -d "${config_path%/*}" ]]
  '

  [ "$status" -eq 0 ]
}

@test "project setup selects Codex when Claude Code is not installed" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  local test_project="${BATS_TEST_TMPDIR}/project"
  local test_bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${test_home}" "${test_project}" "${test_bin}"
  touch "${test_bin}/codex"
  chmod +x "${test_bin}/codex"

  run env HOME="${test_home}" TEST_PROJECT="${test_project}" PATH="${test_bin}:/usr/bin:/bin" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    MCP_CONFIG_SCOPE=project
    MCP_PROJECT_ROOT="$TEST_PROJECT"
    detect_mcp_clients
    [[ -z "$(find_client_entry "Claude Code (Project)")" ]]
    [[ -n "$(find_client_entry "Codex (Project)")" ]]
  '

  [ "$status" -eq 0 ]
}

@test "project setup excludes Codex without an installation or project config" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  local test_project="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${test_home}" "${test_project}"

  run env HOME="${test_home}" TEST_PROJECT="${test_project}" PATH="/usr/bin:/bin" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    MCP_CONFIG_SCOPE=project
    MCP_PROJECT_ROOT="$TEST_PROJECT"
    command_exists() { return 1; }
    detect_mcp_clients
    [[ -z "$(find_client_entry "Claude Code (Project)")" ]]
    [[ -z "$(find_client_entry "Codex (Project)")" ]]
    [[ -z "$(find_client_entry "Cursor (Project)")" ]]
  '

  [ "$status" -eq 0 ]
}

@test "empty MCP client detection is a safe lookup miss under strict mode" {
  run bash -c '
    set -u
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    MCP_CLIENT_LIST=()
    ! find_client_entry "Codex (Project)"
  '

  [ "$status" -eq 0 ]
}

@test "project setup excludes Claude Desktop's user configuration" {
  local test_home="${BATS_TEST_TMPDIR}/home"
  local test_project="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${test_home}/.config/Claude" "${test_project}"

  run env HOME="${test_home}" TEST_PROJECT="${test_project}" bash -c '
    export INSTALL_SH_SOURCE_ONLY=true
    source scripts/install.sh
    MCP_CONFIG_SCOPE=project
    MCP_PROJECT_ROOT="$TEST_PROJECT"
    detect_os() { printf "linux\n"; }
    detect_mcp_clients
    ! printf "%s\n" "${MCP_CLIENT_LIST[@]}" | grep -q "Claude Desktop"
  '

  [ "$status" -eq 0 ]
}
