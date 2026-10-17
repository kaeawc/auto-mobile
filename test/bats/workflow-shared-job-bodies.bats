#!/usr/bin/env bats
#
# Guards #11872: job bodies shared by pull_request.yml and merge.yml live in one
# composite action, called from both. The job (its `name:`, `runs-on`, `needs`
# and `if`) stays in each workflow because the required status check context is
# built from the job name; a reusable workflow would rename it to `caller / job`.

setup() {
  command -v yq >/dev/null || skip "yq not installed"
}

# job-id:composite-action pairs
PAIRS=(
  "build-desktop-core:ci-build-desktop-core"
  "build-ide-plugin:ci-build-ide-plugin"
  "ide-plugin-unit-tests:ci-ide-plugin-unit-tests"
  "desktop-app-unit-tests:ci-desktop-app-unit-tests"
)

@test "shared jobs call the same composite action from both workflows" {
  local pair job action wf
  for pair in "${PAIRS[@]}"; do
    job="${pair%%:*}"
    action="${pair##*:}"
    [ -f ".github/actions/${action}/action.yml" ]
    for wf in pull_request merge; do
      run yq -r ".jobs.\"${job}\".steps[].uses" ".github/workflows/${wf}.yml"
      [ "$status" -eq 0 ]
      [[ "$output" == *"./.github/actions/${action}"* ]]
    done
  done
}

@test "shared jobs keep the same display name in both workflows" {
  local pair job
  for pair in "${PAIRS[@]}"; do
    job="${pair%%:*}"
    [ "$(yq -r ".jobs.\"${job}\".name" .github/workflows/pull_request.yml)" = \
      "$(yq -r ".jobs.\"${job}\".name" .github/workflows/merge.yml)" ]
  done
}

@test "shared composite actions take the Gradle key as an input, not a secret" {
  local pair action
  for pair in "${PAIRS[@]}"; do
    action="${pair##*:}"
    [ "$(yq -r '.runs.using' ".github/actions/${action}/action.yml")" = "composite" ]
    ! grep -q 'secrets\.' ".github/actions/${action}/action.yml"
  done
}
