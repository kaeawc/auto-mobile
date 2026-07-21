#!/usr/bin/env bats

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
