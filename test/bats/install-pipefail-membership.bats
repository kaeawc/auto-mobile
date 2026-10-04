#!/usr/bin/env bats

# shellcheck disable=SC2329 # BATS invokes setup, teardown, and test helpers.
# shellcheck disable=SC2030,SC2031 # Each BATS test has an isolated environment.
setup() {
  TEST_DIR="$(mktemp -d)"
  STUB_BIN="${TEST_DIR}/bin"
  mkdir -p "${STUB_BIN}"
  export PATH="${STUB_BIN}:/usr/bin:/bin"
  cat > "${TEST_DIR}/source" <<'STUB'
# shellcheck source=/dev/null
source "$INSTALL_UNDER_TEST"
log_info() { printf '[INFO] %s\n' "$1"; }
log_warn() { printf '[WARN] %s\n' "$1"; }
log_error() { printf '[ERROR] %s\n' "$1"; }
STUB
  export TEST_SOURCE="${TEST_DIR}/source"
  export INSTALL_SH_SOURCE_ONLY=true
  export INSTALL_UNDER_TEST="${BATS_TEST_DIRNAME}/../../scripts/install.sh"
  export TEST_DIR STUB_BIN
  export PRODUCER_OUTPUT="${TEST_DIR}/output"
  export PRODUCER_STATUS=0
  export HOME="${TEST_DIR}/home"
  mkdir -p "${HOME}"
  # Fail closed: no test may reach a real package manager or Claude CLI.
  local binary
  for binary in brew npm claude curl wget jq bun bunx apt-get; do
    cat > "${STUB_BIN}/${binary}" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
cat "${PRODUCER_OUTPUT}"
exit "${PRODUCER_STATUS}"
STUB
    chmod +x "${STUB_BIN}/${binary}"
  done
}

teardown() {
  /bin/rm -rf "${TEST_DIR}"
}

large_output() {
  printf '%s\n' "$1" > "${PRODUCER_OUTPUT}"
  awk 'BEGIN { for (i=1; i<=20000; i++) print "filler-" i }' >> "${PRODUCER_OUTPUT}"
}

repeat_output() {
  awk -v line="$1" 'BEGIN { for (i=1; i<=20000; i++) print line }' > "${PRODUCER_OUTPUT}"
}

@test "marketplace membership detects a first match in large output" {
  large_output 'prefix-auto-mobile-suffix'
  run bash -c 'source "$TEST_SOURCE"; is_claude_marketplace_installed'
  [ "$status" -eq 0 ]
}

@test "marketplace membership rejects absent, case-mismatched, and failed output" {
  for value in filler AUTO-MOBILE auto-mobile; do
    large_output "${value}"
    [[ "${value}" != auto-mobile ]] || export PRODUCER_STATUS=42
    run bash -c 'source "$TEST_SOURCE"; is_claude_marketplace_installed'
    [ "$status" -ne 0 ]
  done
}

config_check() {
  run bash -c '
    source "$TEST_SOURCE"
    DRY_RUN=true
    merge_mcp_config() { echo changed; }
    show_config_diff() { :; }
    update_mcp_client_config Test "$PRODUCER_OUTPUT" ignored
  '
}

@test "npx migration detects all three ERE alternatives first in large configs" {
  local value
  for value in '"npx"' 'command = "npx"' 'cmd: npx'; do
    large_output "${value}"
    config_check
    [ "$status" -eq 0 ]
    [[ "$output" == *'[MIGRATION]'* ]]
  done
}

@test "npx migration does not announce absent or case-mismatched commands" {
  large_output '"NPX"'
  config_check
  [ "$status" -eq 0 ]
  [[ "$output" != *'[MIGRATION]'* ]]
}

npm_check() {
  run bash -c 'source "$TEST_SOURCE"; DRY_RUN=true; migrate_npm_global_auto_mobile'
}

@test "npm migration detects a first substring match in large output" {
  large_output 'prefix-@kaeawc/auto-mobile-suffix'
  npm_check
  [ "$status" -eq 0 ]
  [[ "$output" == *'Would remove npm global install'* ]]
}

@test "npm migration skips absent and failed producer output" {
  large_output filler
  npm_check
  [ "$status" -eq 0 ]
  [[ "$output" != *'Would remove'* ]]
  large_output '@kaeawc/auto-mobile'
  export PRODUCER_STATUS=42
  npm_check
  [ "$status" -eq 0 ]
  [[ "$output" != *'Would remove'* ]]
}

daemon_check() {
  run bash -c '
    source "$TEST_SOURCE"
    resolve_auto_mobile_command() { AUTO_MOBILE_CMD=(claude); }
    gum() { return 1; } # Decline reset: never delete database files.
    start_mcp_daemon
  '
}

@test "daemon recognizes corrupted migrations first in large output" {
  large_output 'error: corrupted migrations: FIRST'
  export PRODUCER_STATUS=42
  daemon_check
  [ "$status" -eq 1 ]
  [[ "$output" == *'Database has corrupted migrations: FIRST'* ]]
  [[ "$output" == *'Cannot start daemon with corrupted database'* ]]
}

@test "daemon extracts only the first error from many matching lines" {
  repeat_output 'error: corrupted migrations: FIRST'
  export PRODUCER_STATUS=42
  daemon_check
  echo "daemon status=${status}"
  [ "$status" -eq 1 ]
  [[ "$output" == *'Database has corrupted migrations: FIRST'* ]]
  [[ "$output" == *'Cannot start daemon with corrupted database'* ]]
}

@test "daemon uses fallback for unstructured migration errors and rejects unrelated errors" {
  large_output 'corrupted migrations'
  export PRODUCER_STATUS=42
  daemon_check
  [[ "$output" == *'Database has corrupted migrations (version mismatch)'* ]]
  large_output unrelated
  daemon_check
  [ "$status" -eq 1 ]
  [[ "$output" == *'Failed to start MCP daemon:'* ]]
  [[ "$output" != *'Database has'* ]]
}

brew_check() {
  run bash -c '
    source "$TEST_SOURCE"
    run_bounded_install() { printf "bounded: %s\n" "$1"; }
    install_bun_homebrew
  '
}

@test "Homebrew detects a first tap substring match in large output" {
  large_output 'prefix-oven-sh/bun-suffix'
  brew_check
  [ "$status" -eq 0 ]
  [[ "$output" != *'Adding Homebrew tap'* ]]
  [[ "$output" == *'Installing Bun via Homebrew'* ]]
}

@test "Homebrew adds absent taps and treats failed listings as absent" {
  large_output filler
  brew_check
  [ "$status" -eq 0 ]
  [[ "$output" == *'Adding Homebrew tap'* ]]
  large_output oven-sh/bun
  export PRODUCER_STATUS=42
  brew_check
  [ "$status" -eq 0 ]
  [[ "$output" == *'Adding Homebrew tap'* ]]
}

main_check() {
  run bash -c '
    source "$TEST_SOURCE"
    parse_args() { :; }
    detect_existing_setup() { CLAUDE_CLI_INSTALLED=true; }
    ensure_gum() { :; }
    gum() { :; }
    play_logo_animation() { :; }
    detect_os() { echo linux; }
    parse_required_versions() { :; }
    run_spinner() {
      [[ "$1" == "Checking Claude marketplace plugin" ]] || return 1
      shift
      # Exercise the actual bash -c string with inherited pipefail too.
      export SHELLOPTS
      "$@"
    }
    detect_invocation_project() {
      printf "marketplace=%s\n" "$CLAUDE_MARKETPLACE_INSTALLED"
      exit 0 # Stop main before choices, installs, or daemon operations.
    }
    main
  '
}

@test "main spinner detects first marketplace match with inherited pipefail" {
  large_output auto-mobile
  main_check
  [ "$status" -eq 0 ]
  [[ "$output" == *'marketplace=true'* ]]
}

@test "main spinner treats absent and failed marketplace listings as missing" {
  large_output filler
  main_check
  [ "$status" -eq 0 ]
  [[ "$output" == *'marketplace=false'* ]]
  large_output auto-mobile
  export PRODUCER_STATUS=42
  main_check
  [ "$status" -eq 0 ]
  [[ "$output" == *'marketplace=false'* ]]
}

@test "compile SDK extraction drains many matches and returns the first" {
  repeat_output 'build-android-compileSdk = "37"'
  run bash -c 'source "$TEST_SOURCE"; read_required_compile_sdk "$PRODUCER_OUTPUT"'
  [ "$status" -eq 0 ]
  [ "$output" = 37 ]
}

@test "compile SDK extraction still rejects missing keys" {
  large_output filler
  run bash -c 'source "$TEST_SOURCE"; read_required_compile_sdk "$PRODUCER_OUTPUT"'
  [ "$status" -ne 0 ]
}

@test "version comparison drains sorted output and retains first-line comparison" {
  large_output 1.0
  cp "${STUB_BIN}/claude" "${STUB_BIN}/sort"
  run bash -c 'source "$TEST_SOURCE"; version_gte 2.0 1.0'
  [ "$status" -eq 0 ]
  run bash -c 'source "$TEST_SOURCE"; version_gte 2.0 3.0'
  [ "$status" -ne 0 ]
}

@test "ANDROID_HOME extraction drains repeated settings and selects the first" {
  repeat_output 'export ANDROID_HOME="/stub/sdk"'
  cp "${PRODUCER_OUTPUT}" "${HOME}/.zshrc"
  run bash -c '
    source "$TEST_SOURCE"
    gum() { return 0; }
    offer_android_home_shell_setup /unused
    printf "sdk=%s\n" "$ANDROID_HOME"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *'sdk=/stub/sdk'* ]]
}

gum_release_check() {
  repeat_output '"tag_name": "v0.99.0"'
  export PRODUCER="$1"
  run bash -c '
    source "$TEST_SOURCE"
    command_exists() { [[ "$1" == "$PRODUCER" ]]; }
    fetch_gum_version
  '
  [ "$status" -eq 0 ]
  [ "$output" = 0.99.0 ]
}

@test "Gum release extraction drains curl matches and selects first" {
  gum_release_check curl
}

@test "Gum release extraction drains wget matches and selects first" {
  gum_release_check wget
}

@test "Gum release extraction retains the empty response fallback" {
  large_output filler
  run bash -c 'source "$TEST_SOURCE"; fetch_gum_version'
  [ "$status" -eq 0 ]
  [ "$output" = 0.17.0 ]
}

@test "desktop jq asset extraction drains many results and selects first" {
  repeat_output 'https://example.invalid/first.dmg'
  run bash -c '
    source "$TEST_SOURCE"
    command_exists() { [[ "$1" == jq ]]; }
    resolve_desktop_app_release_asset ignored .dmg
  '
  [ "$status" -eq 0 ]
  [ "$output" = https://example.invalid/first.dmg ]
}

@test "desktop jq asset extraction keeps empty output when no asset matches" {
  : > "${PRODUCER_OUTPUT}"
  run bash -c '
    source "$TEST_SOURCE"
    command_exists() { [[ "$1" == jq ]]; }
    resolve_desktop_app_release_asset ignored .dmg
  '
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "dry-run preset selects first client from a large list" {
  printf 'Codex\n' > "${PRODUCER_OUTPUT}"
  awk 'BEGIN { for (i=1; i<=20000; i++) printf "filler-%d ", i; print "" }' >> "${PRODUCER_OUTPUT}"
  run bash -c '
    source "$TEST_SOURCE"
    DRY_RUN=true
    detect_mcp_clients() { :; }
    get_detected_client_names() { cat "$PRODUCER_OUTPUT"; }
    client_has_auto_mobile() { return 1; }
    get_client_config_path() { echo /unused; }
    apply_preset() { :; }
    select_preset
    printf "client=%s\n" "$PRESET_CLIENT_FILTER"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *'client=Codex'* ]]
}
