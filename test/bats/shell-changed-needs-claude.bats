#!/usr/bin/env bats
# scripts/ci/shell-changed-needs-claude.sh and its Shell Changed Files wiring
# (#17010): the job installs the Claude Code CLI only when the selector picks
# the `claude-plugin` check.

load yq-helpers

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  WF="${REPO_ROOT}/.github/workflows/pull_request.yml"
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "${TEST_ROOT}/scripts/ci"
  cp "${REPO_ROOT}/scripts/ci/shell-changed-needs-claude.sh" "${TEST_ROOT}/scripts/ci/"
  # The selector stub logs its arguments and prints SELECTOR_CHECKS.
  cat > "${TEST_ROOT}/scripts/prepush-shell.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${SELECTOR_ARGS_LOG}"
if [[ -n "${SELECTOR_CHECKS:-}" ]]; then
  printf '%s\n' "${SELECTOR_CHECKS}"
fi
exit "${SELECTOR_STATUS:-0}"
STUB
  chmod +x "${TEST_ROOT}/scripts/prepush-shell.sh"
  export SELECTOR_ARGS_LOG="${TEST_ROOT}/selector-args.log"
  export GITHUB_OUTPUT="${TEST_ROOT}/github-output"
  SCRIPT="${TEST_ROOT}/scripts/ci/shell-changed-needs-claude.sh"
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

@test "claude_plugin=true when the selector picks claude-plugin" {
  export SELECTOR_CHECKS=$'codex-skills\nclaude-plugin'

  run bash "${SCRIPT}" abc123

  [ "${status}" -eq 0 ]
  [ "$(cat "${SELECTOR_ARGS_LOG}")" = "--base abc123 --list-checks" ]
  [ "$(cat "${GITHUB_OUTPUT}")" = "claude_plugin=true" ]
  [[ "${output}" == *"Selected check: claude-plugin"* ]]
}

@test "claude_plugin=false when the selector picks other checks only" {
  export SELECTOR_CHECKS=$'shellcheck\nclaude-plugin-extra\ncodex-skills'

  run bash "${SCRIPT}" abc123

  [ "${status}" -eq 0 ]
  [ "$(cat "${GITHUB_OUTPUT}")" = "claude_plugin=false" ]
}

@test "claude_plugin=false when the selector picks nothing" {
  run bash "${SCRIPT}" abc123

  [ "${status}" -eq 0 ]
  [ "$(cat "${GITHUB_OUTPUT}")" = "claude_plugin=false" ]
}

@test "a selector failure fails the step and writes no output" {
  export SELECTOR_CHECKS="claude-plugin"
  export SELECTOR_STATUS=7

  run bash "${SCRIPT}" abc123

  [ "${status}" -eq 7 ]
  [ ! -e "${GITHUB_OUTPUT}" ]
  [[ "${output}" == *"Failed to list the changed-file shell checks against abc123."* ]]
}

@test "a missing base ref or GITHUB_OUTPUT is a usage error" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"Usage: shell-changed-needs-claude.sh <base-ref>"* ]]

  run env -u GITHUB_OUTPUT bash "${SCRIPT}" abc123
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"GITHUB_OUTPUT is not set."* ]]
  [ ! -e "${SELECTOR_ARGS_LOG}" ]
}

@test "Shell Changed Files installs Claude Code only when the selector picks claude-plugin" {
  require_mikefarah_yq
  local steps='.jobs."shell-changed-gate".steps[]'
  local select="${steps} | select(.id == \"select-shell-checks\")"

  [ "$(yq -r "${select} | .env.BASE_SHA" "${WF}")" = '${{ github.event.pull_request.base.sha }}' ]
  run yq -r "${select} | .run" "${WF}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'base="$(scripts/ci/resolve-pr-base.sh "${BASE_SHA}")"'* ]]
  [[ "${output}" == *'scripts/ci/shell-changed-needs-claude.sh "${base}"'* ]]

  [ "$(yq -r "${steps} | select(.uses == \"./.github/actions/install-claude-code\") | .if" "${WF}")" = \
    "steps.select-shell-checks.outputs.claude_plugin == 'true'" ]
}

@test "Shell Changed Files selects after the Bun install and installs Claude Code before the checks run" {
  require_mikefarah_yq
  local order
  order="$(yq -r '.jobs."shell-changed-gate".steps[] | .id // .uses // .name' "${WF}" |
    awk '$0 == "Install Bun dependencies" || $0 == "select-shell-checks" || $0 == "./.github/actions/install-claude-code" || $0 == "Run changed-file shell checks"' |
    tr '\n' '|')"
  [ "${order}" = 'Install Bun dependencies|select-shell-checks|./.github/actions/install-claude-code|Run changed-file shell checks|' ]
}
