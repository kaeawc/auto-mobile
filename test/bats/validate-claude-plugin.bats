#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/claude/validate_plugin.sh
#
# The plugin root at install time is the marketplace entry's source directory,
# so every path in plugin.json must resolve from there (#16915). A `claude`
# stub stands in for the CLI so these tests never depend on it being installed;
# the CLI-absent cases run on a PATH without it (#16963).

SCRIPT_SRC="scripts/claude/validate_plugin.sh"

setup() {
  REPO_ROOT="$(pwd)"
  SCRIPT_ABS="${REPO_ROOT}/${SCRIPT_SRC}"
  TEST_ROOT="$(mktemp -d)"
  BIN_DIR="$(mktemp -d)"
  CLAUDE_LOG="${BIN_DIR}/claude.log"
  write_claude_stub
  PATH="${BIN_DIR}:$PATH"
  export PATH CLAUDE_LOG
  # Each case states whether it runs as CI; the default is a local run.
  unset CI
  write_valid_fixture
}

teardown() {
  rm -rf "$TEST_ROOT" "$BIN_DIR"
}

write_claude_stub() {
  cat > "${BIN_DIR}/claude" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CLAUDE_LOG"
if [[ " $* " == *" --help "* ]]; then
  if [[ "${CLAUDE_STUB_HAS_PROFILE:-1}" == "1" ]]; then
    echo "  --profile <name>  Also exit 1 when the plugin directory would refuse it"
  fi
  echo "  --strict          Treat warnings as errors (exit 1)"
  exit 0
fi
if [[ " $* " == *" --profile "* ]]; then
  exit "${CLAUDE_STUB_PROFILE_STATUS:-0}"
fi
exit "${CLAUDE_STUB_STATUS:-0}"
SH
  chmod +x "${BIN_DIR}/claude"
}

write_valid_fixture() {
  local plugin="${TEST_ROOT}/plugins/auto-mobile"
  mkdir -p "${TEST_ROOT}/.claude-plugin" "${plugin}/.claude-plugin" "${plugin}/skills"
  printf '{"version": "1.2.3"}\n' > "${TEST_ROOT}/package.json"
  cat > "${TEST_ROOT}/.claude-plugin/marketplace.json" <<'JSON'
{"name": "m", "plugins": [{"name": "auto-mobile", "source": "./plugins/auto-mobile"}]}
JSON
  cat > "${plugin}/.claude-plugin/plugin.json" <<'JSON'
{"name": "auto-mobile", "version": "1.2.3", "commands": ["./skills/"], "hooks": "./hooks.json"}
JSON
  printf '{"hooks": {"PostToolUse": []}}\n' > "${plugin}/hooks.json"
  printf -- '---\ndescription: d\nallowed-tools: x\n---\n' > "${plugin}/skills/doctor.md"
  printf '# auto-mobile\n' > "${plugin}/README.md"
}

run_validator() {
  VALIDATE_PLUGIN_ROOT="$TEST_ROOT" run bash "$SCRIPT_ABS"
}

# A PATH holding only the tools the validator needs, so no `claude` resolves.
# Scope it to one run (`PATH="$NO_CLAUDE_PATH" run_validator`): teardown needs rm.
use_path_without_claude() {
  local tool
  local tools_dir="${BIN_DIR}/no-claude"
  mkdir -p "$tools_dir"
  for tool in bash python3 find wc tr head grep basename dirname cat; do
    ln -s "$(command -v "$tool")" "${tools_dir}/${tool}"
  done
  NO_CLAUDE_PATH="$tools_dir"
}

write_icon() {
  local plugin="${TEST_ROOT}/plugins/auto-mobile"
  mkdir -p "${plugin}/assets"
  printf '%s\n' "$1" > "${plugin}/assets/icon.png"
  cat > "${plugin}/.claude-plugin/plugin.json" <<'JSON'
{"name": "auto-mobile", "version": "1.2.3", "commands": ["./skills/"], "hooks": "./hooks.json", "icon": "./assets/icon.png"}
JSON
}

@test "a plugin whose paths resolve from its own root passes and runs the CLI on both roots" {
  run_validator

  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude plugin validation passed"* ]]
  grep -Fqx 'plugin validate .' "$CLAUDE_LOG"
  grep -Fqx 'plugin validate plugins/auto-mobile' "$CLAUDE_LOG"
  grep -Fqx 'plugin validate --profile directory plugins/auto-mobile' "$CLAUDE_LOG"
}

@test "the committed repository plugin passes" {
  run bash "$SCRIPT_ABS"

  [ "$status" -eq 0 ]
  grep -Fqx 'plugin validate plugins/auto-mobile' "$CLAUDE_LOG"
}

@test "a marketplace source without a nested plugin manifest fails (#16915 layout)" {
  # The pre-fix shape: source ./.claude-plugin with plugin.json directly inside
  # it, so the runtime finds no <root>/.claude-plugin/plugin.json.
  cat > "${TEST_ROOT}/.claude-plugin/marketplace.json" <<'JSON'
{"name": "m", "plugins": [{"name": "auto-mobile", "source": "./.claude-plugin"}]}
JSON
  cp "${TEST_ROOT}/plugins/auto-mobile/.claude-plugin/plugin.json" "${TEST_ROOT}/.claude-plugin/plugin.json"

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"Plugin manifest '.claude-plugin/.claude-plugin/plugin.json' not found"* ]]
  [ ! -f "$CLAUDE_LOG" ]
}

@test "a hooks path that does not resolve from the plugin root fails" {
  mv "${TEST_ROOT}/plugins/auto-mobile/hooks.json" "${TEST_ROOT}/hooks.json"

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"plugin.json hooks path './hooks.json' not found"* ]]
  [[ "$output" == *"plugins/auto-mobile/hooks.json"* ]]
}

@test "a hooks file without the top-level hooks object fails" {
  printf '{"PostToolUse": []}\n' > "${TEST_ROOT}/plugins/auto-mobile/hooks.json"

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *'top-level "hooks" object'* ]]
}

@test "a plugin version that differs from package.json fails" {
  printf '{"version": "9.9.9"}\n' > "${TEST_ROOT}/package.json"

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"Version mismatch"* ]]
}

@test "a failing claude CLI validation fails the check" {
  export CLAUDE_STUB_STATUS=1

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"Claude CLI marketplace validation failed"* ]]
}

@test "a failing plugin directory profile run fails the check (#16963)" {
  export CLAUDE_STUB_PROFILE_STATUS=1

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"plugin directory profile validation failed"* ]]
}

@test "a claude CLI without --profile skips only the directory profile run" {
  export CLAUDE_STUB_HAS_PROFILE=0

  CI=true run_validator

  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping the plugin directory checks"* ]]
  grep -Fqx 'plugin validate plugins/auto-mobile' "$CLAUDE_LOG"
  ! grep -Fq -- '--profile directory' "$CLAUDE_LOG"
}

@test "no claude CLI passes with a note outside CI" {
  use_path_without_claude

  PATH="$NO_CLAUDE_PATH" run_validator

  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude CLI not installed, skipping advanced validation"* ]]
}

@test "no claude CLI fails in CI" {
  use_path_without_claude

  CI=true PATH="$NO_CLAUDE_PATH" run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"Claude CLI not installed; CI must run"* ]]
}

@test "an icon that is an LFS pointer instead of a PNG fails without the CLI" {
  write_icon "version https://git-lfs.github.com/spec/v1"

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"is not a PNG"* ]]
  [ ! -f "$CLAUDE_LOG" ]
}

@test "a PNG icon passes" {
  write_icon $'\x89PNG\r\n\x1a\nrest'

  run_validator

  [ "$status" -eq 0 ]
  [[ "$output" == *"plugins/auto-mobile/assets/icon.png is a PNG"* ]]
}

@test "a plugin without its own README fails without the CLI" {
  rm "${TEST_ROOT}/plugins/auto-mobile/README.md"
  printf '# repo\n' > "${TEST_ROOT}/README.md"

  run_validator

  [ "$status" -eq 1 ]
  [[ "$output" == *"Plugin README 'plugins/auto-mobile/README.md' not found"* ]]
  [ ! -f "$CLAUDE_LOG" ]
}
