#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/claude/validate_plugin.sh
#
# The plugin root at install time is the marketplace entry's source directory,
# so every path in plugin.json must resolve from there (#16915). A `claude`
# stub stands in for the CLI so these tests never depend on it being installed.

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
  write_valid_fixture
}

teardown() {
  rm -rf "$TEST_ROOT" "$BIN_DIR"
}

write_claude_stub() {
  cat > "${BIN_DIR}/claude" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CLAUDE_LOG"
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
}

run_validator() {
  VALIDATE_PLUGIN_ROOT="$TEST_ROOT" run bash "$SCRIPT_ABS"
}

@test "a plugin whose paths resolve from its own root passes and runs the CLI on both roots" {
  run_validator

  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude plugin validation passed"* ]]
  grep -Fqx 'plugin validate .' "$CLAUDE_LOG"
  grep -Fqx 'plugin validate plugins/auto-mobile' "$CLAUDE_LOG"
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
