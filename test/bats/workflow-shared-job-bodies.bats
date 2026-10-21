#!/usr/bin/env bats
#
# Guards #11872: job bodies shared by pull_request.yml and merge.yml live in one
# composite action, called from both. The job (its `name:`, `runs-on`, `needs`
# and `if`) stays in each workflow because the required status check context is
# built from the job name; a reusable workflow would rename it to `caller / job`.

PR_WF=".github/workflows/pull_request.yml"

setup() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify the shared job wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

# job-id|composite-action|required context|detect-changes output gating the job
#
# The context is the green-main ruleset's literal name. Pinning it here (not
# just comparing the two workflows) fails a rename made identically in both,
# which would leave the required context Expected forever (#14581).
SHARED=(
  "build-desktop-core|ci-build-desktop-core|Build Desktop Core Module|desktop_core_changed"
  "build-ide-plugin|ci-build-ide-plugin|Build IDE Plugin|ide_plugin_changed"
  "ide-plugin-unit-tests|ci-ide-plugin-unit-tests|Run IDE Plugin Unit Tests|ide_plugin_changed"
  "desktop-app-unit-tests|ci-desktop-app-unit-tests|Run Desktop App Unit Tests|desktop_app_changed"
)

# Splits one SHARED row into job, action, context and gate (not `output`,
# which bats' `run` overwrites).
read_row() {
  IFS='|' read -r job action context gate <<<"$1"
}

@test "shared jobs call the same composite action from both workflows" {
  local row job action context gate wf
  for row in "${SHARED[@]}"; do
    read_row "$row"
    [ -f ".github/actions/${action}/action.yml" ]
    for wf in pull_request merge; do
      run yq -r ".jobs.\"${job}\".steps[].uses" ".github/workflows/${wf}.yml"
      [ "$status" -eq 0 ]
      [[ "$output" == *"./.github/actions/${action}"* ]]
    done
  done
}

@test "shared jobs emit their required context name in both workflows" {
  local row job action context gate wf
  for row in "${SHARED[@]}"; do
    read_row "$row"
    for wf in pull_request merge; do
      run yq -r ".jobs.\"${job}\".name" ".github/workflows/${wf}.yml"
      [ "$status" -eq 0 ]
      [ "$output" = "$context" ] || {
        echo "${wf}.yml ${job}: name '${output}', ruleset context '${context}'" >&2
        return 1
      }
    done
  done
}

@test "shared composite actions take the Gradle key as an input, not a secret" {
  local row job action context gate
  for row in "${SHARED[@]}"; do
    read_row "$row"
    [ "$(yq -r '.runs.using' ".github/actions/${action}/action.yml")" = "composite" ]
    # A bare `! grep` never fails a bats test (set -e ignores negated commands).
    if grep -q 'secrets\.' ".github/actions/${action}/action.yml"; then
      echo "${action}: reads a secret; take it as an input instead" >&2
      return 1
    fi
  done
}

@test "workflow-check-contexts.sh lists the shared jobs with their display names" {
  run bash scripts/ci/workflow-check-contexts.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *$'pull_request\tbuild-ide-plugin\tBuild IDE Plugin'* ]]
  [[ "$output" == *$'merge\tide-plugin-unit-tests\tRun IDE Plugin Unit Tests'* ]]
}

# Globs of paths filter $2 in the detect-changes step with id $1, one per line.
# The step's `filters:` is a YAML document inside a string, so parse it again.
filter_globs() {
  set -o pipefail
  yq -r ".jobs.\"detect-changes\".steps[] | select(.id == \"$1\") | .with.filters" "$PR_WF" |
    yq -r ".\"$2\"[]" -
}

# An action-only change must run the jobs that consume it, so each action's glob
# has to sit in the paths filter whose output gates its consumer, not merely
# somewhere in pull_request.yml (#14582). Follows job `if` -> detect-changes
# output -> `steps.<id>.outputs.<filter>` -> that filter's glob list.
@test "each shared action's glob is in the paths filter that gates its consumer" {
  local row job action context gate expr step filter
  local step_re='^\$\{\{ *steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_]+) *\}\}$'
  for row in "${SHARED[@]}"; do
    read_row "$row"

    run yq -r ".jobs.\"${job}\".if" "$PR_WF"
    [ "$status" -eq 0 ]
    [[ "$output" == *"needs.detect-changes.outputs.${gate} == 'true'"* ]] || {
      echo "${job}: if does not gate on ${gate}: ${output}" >&2
      return 1
    }

    expr="$(yq -r ".jobs.\"detect-changes\".outputs.\"${gate}\"" "$PR_WF")"
    [[ "$expr" =~ $step_re ]] || {
      echo "detect-changes output ${gate} is not a step output: ${expr}" >&2
      return 1
    }
    step="${BASH_REMATCH[1]}"
    filter="${BASH_REMATCH[2]}"

    run filter_globs "$step" "$filter"
    [ "$status" -eq 0 ]
    grep -qxF ".github/actions/${action}/**" <<<"$output" || {
      echo "${action}: glob missing from ${step} filter '${filter}', which gates ${job}" >&2
      return 1
    }
  done
}
