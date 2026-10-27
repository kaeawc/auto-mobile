#!/usr/bin/env bats
#
# #11872: the WebRTC jobs shared by pull_request.yml and merge.yml keep their body in one composite
# action. The job (name, runs-on, needs, if, timeout) stays in each workflow, because the status
# check context is built from the job name. These jobs are not required checks today, but the
# names are pinned so a rename is a decision, not an accident.

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

# job-id|composite action|job name
WHEP=(
  "android-device-webrtc|ci-android-device-whep|Android Device Capture to WHEP"
  "webrtc-integration-test|ci-webrtc-publisher-integration|WebRTC Publisher Integration (MediaMTX)"
)

@test "each WebRTC job calls its composite action from both workflows, after checking out" {
  local row job action name wf
  for row in "${WHEP[@]}"; do
    IFS='|' read -r job action name <<<"$row"
    [ -f ".github/actions/${action}/action.yml" ]
    [ "$(yq -r '.runs.using' ".github/actions/${action}/action.yml")" = "composite" ]
    for wf in "$PR_WF" "$MERGE_WF"; do
      [ "$(yq -r ".jobs.\"${job}\".steps[0].uses" "$wf")" = "actions/checkout@v6" ]
      [ "$(yq -r ".jobs.\"${job}\".steps[1].uses" "$wf")" = "./.github/actions/${action}" ]
      [ "$(yq -r ".jobs.\"${job}\".steps | length" "$wf")" = "2" ]
    done
  done
}

@test "the job names, which are the status check contexts, are unchanged" {
  local row job action name wf
  for row in "${WHEP[@]}"; do
    IFS='|' read -r job action name <<<"$row"
    for wf in "$PR_WF" "$MERGE_WF"; do
      [ "$(yq -r ".jobs.\"${job}\".name" "$wf")" = "$name" ]
    done
  done
}

@test "the composite actions read no secret" {
  local row job action name
  for row in "${WHEP[@]}"; do
    IFS='|' read -r job action name <<<"$row"
    if grep -q 'secrets\.' ".github/actions/${action}/action.yml"; then
      echo "${action}: reads a secret; take it as an input instead" >&2
      return 1
    fi
  done
}

@test "an action-only change reruns the WebRTC jobs: its glob is in the webrtc paths filter" {
  local row job action name globs
  globs="$(yq -r '.jobs."detect-changes".steps[] | select(.id == "filter-webrtc") | .with.filters' "$PR_WF" | yq -r '.webrtc[]' -)"
  for row in "${WHEP[@]}"; do
    IFS='|' read -r job action name <<<"$row"
    grep -qxF ".github/actions/${action}/**" <<<"$globs" || {
      echo "${action}: glob missing from the webrtc filter" >&2
      return 1
    }
  done
}
