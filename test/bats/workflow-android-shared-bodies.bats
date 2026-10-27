#!/usr/bin/env bats
#
# #11872: the Android build and unit-test jobs shared by pull_request.yml and merge.yml keep their
# steps in one composite action each. The job (name, runs-on, needs, if, timeout, working directory)
# stays in each workflow because the required status check context is built from the job name; a
# reusable workflow would rename it to `caller / job`. The names below are the green-main ruleset's
# literal contexts, pinned here so a rename made identically in both workflows still fails.

PR_WF=".github/workflows/pull_request.yml"
MERGE_WF=".github/workflows/merge.yml"

setup() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify the shared job wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

# job-id|composite action|required context
ANDROID=(
  "build-android-control-proxy|ci-build-android-control-proxy|Build CtrlProxy APK"
  "junit-runner-unit-tests|ci-junit-runner-unit-tests|Run JUnit Runner Unit Tests"
)

@test "each job calls its composite action from both workflows, after checking out" {
  local row job action context wf
  for row in "${ANDROID[@]}"; do
    IFS='|' read -r job action context <<<"$row"
    [ "$(yq -r '.runs.using' ".github/actions/${action}/action.yml")" = "composite" ]
    for wf in "$PR_WF" "$MERGE_WF"; do
      [ "$(yq -r ".jobs.\"${job}\".steps[0].uses" "$wf")" = "actions/checkout@v6" ]
      [ "$(yq -r ".jobs.\"${job}\".steps[1].uses" "$wf")" = "./.github/actions/${action}" ]
      [ "$(yq -r ".jobs.\"${job}\".steps | length" "$wf")" = "2" ]
    done
  done
}

@test "the required context names are unchanged" {
  local row job action context wf
  for row in "${ANDROID[@]}"; do
    IFS='|' read -r job action context <<<"$row"
    for wf in "$PR_WF" "$MERGE_WF"; do
      [ "$(yq -r ".jobs.\"${job}\".name" "$wf")" = "$context" ]
    done
  done
}

@test "secrets reach the composite actions as inputs, never read inside them" {
  local row job action context wf input
  for row in "${ANDROID[@]}"; do
    IFS='|' read -r job action context <<<"$row"
    if grep -q 'secrets\.' ".github/actions/${action}/action.yml"; then
      echo "${action}: reads a secret; take it as an input instead" >&2
      return 1
    fi
    for wf in "$PR_WF" "$MERGE_WF"; do
      for input in gradle-encryption-key release-keystore-base64 release-keystore-password \
        release-key-alias release-key-password; do
        [[ "$(yq -r ".jobs.\"${job}\".steps[1].with.\"${input}\"" "$wf")" == *'${{ secrets.'* ]]
      done
    done
  done
}

@test "both workflows gate each job the same way apart from the PR-only detect-changes condition" {
  local row job action context
  for row in "${ANDROID[@]}"; do
    IFS='|' read -r job action context <<<"$row"
    [ "$(yq -r ".jobs.\"${job}\".\"runs-on\"" "$PR_WF")" = "$(yq -r ".jobs.\"${job}\".\"runs-on\"" "$MERGE_WF")" ]
    [ "$(yq -r ".jobs.\"${job}\".\"timeout-minutes\"" "$PR_WF")" = "$(yq -r ".jobs.\"${job}\".\"timeout-minutes\"" "$MERGE_WF")" ]
    [ "$(yq -r ".jobs.\"${job}\".defaults.run.\"working-directory\"" "$PR_WF")" = "android" ]
    [ "$(yq -r ".jobs.\"${job}\".defaults.run.\"working-directory\"" "$MERGE_WF")" = "android" ]
  done
}

@test "an action-only change reruns the jobs: its glob is in the android paths filter" {
  local row job action context globs
  globs="$(yq -r '.jobs."detect-changes".steps[] | select(.id == "filter-android") | .with.filters' "$PR_WF" | yq -r '.android[]' -)"
  for row in "${ANDROID[@]}"; do
    IFS='|' read -r job action context <<<"$row"
    grep -qxF ".github/actions/${action}/**" <<<"$globs" || {
      echo "${action}: glob missing from the android filter" >&2
      return 1
    }
  done
}
