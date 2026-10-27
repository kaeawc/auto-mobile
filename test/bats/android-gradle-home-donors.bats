#!/usr/bin/env bats
#
# Guards the borrowed Gradle homes of the pull-request Android jobs (#11578).
#
# gradle/actions/setup-gradle is read-only on pull requests: a PR job only ever
# restores a Gradle home that a main-branch run saved. The entry is found by job
# id (GRADLE_BUILD_ACTION_CACHE_KEY_JOB, default: the job id) and by the Gradle
# home path, which is part of the cache version. A PR job whose id has no
# enabled counterpart in merge.yml therefore starts from an empty Gradle home on
# every run: in 30 sampled runs Build Playground App, JVM Consumer Checks and
# Run Android Emulator Tests restored nothing 30 times out of 30 and spent
# about 150 s before their first project task.
#
# Those jobs name a main job to borrow from. This suite fails when the pairing
# stops being able to hit: a donor that is renamed, disabled or moved to another
# Gradle home, or a borrower whose Gradle home path drifts from the donor's.

PR_WF=".github/workflows/pull_request.yml"
MAIN_WF=".github/workflows/merge.yml"
# shellcheck disable=SC2016,SC2088 # GitHub expressions, compared literally.
OWN_HOME='~/.gradle/${{ github.job }}'
# shellcheck disable=SC2016,SC2088 # GitHub expressions, compared literally.
BORROWED_HOME='~/.gradle/${{ env.GRADLE_BUILD_ACTION_CACHE_KEY_JOB }}'

donors_require_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify the Gradle home donor wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

# Gradle home directories a job passes to the repository's Gradle actions, one
# per line. A job whose body is a shared composite action (ci-*, #11872) passes
# them from inside that action.
gradle_homes() {
  yq -r "
    .jobs.\"$2\".steps[]
    | select(.uses == \"./.github/actions/gradle-task-run\" or .uses == \"./.github/actions/android-emulator\")
    | .with.\"gradle-home-directory\"
  " "$1"
  local action
  while IFS= read -r action; do
    [[ -n "$action" && "$action" != null ]] || continue
    yq -r "
      .runs.steps[]
      | select(.uses == \"./.github/actions/gradle-task-run\" or .uses == \"./.github/actions/android-emulator\")
      | .with.\"gradle-home-directory\"
    " "${action#./}/action.yml"
  done < <(yq -r ".jobs.\"$2\".steps[] | select(.uses == \"./.github/actions/ci-*\") | .uses" "$1")
}

# "<borrower job> <donor job>" per line, in workflow order.
borrowers() {
  yq -r '
    .jobs | to_entries[]
    | select(.value.env.GRADLE_BUILD_ACTION_CACHE_KEY_JOB != null)
    | .key + " " + .value.env.GRADLE_BUILD_ACTION_CACHE_KEY_JOB
  ' "$PR_WF"
}

@test "the cold pull-request Android jobs borrow a Gradle home" {
  donors_require_yq
  run borrowers
  [ "$status" -eq 0 ]
  [ "$output" = $'android-emulator-tests kotlin-code-coverage\njvm-consumer-checks sdk-debug-inspector-consumer\nbuild-playground-app kotlin-code-coverage' ]
}

@test "every borrower uses its donor's Gradle home path for each Gradle step" {
  donors_require_yq
  local job donor homes home
  while read -r job donor; do
    homes="$(gradle_homes "$PR_WF" "$job")"
    [ -n "$homes" ]
    while IFS= read -r home; do
      [ "$home" = "$BORROWED_HOME" ]
    done <<< "$homes"
  done < <(borrowers)
}

@test "every donor is an enabled main job that saves its own Gradle home" {
  donors_require_yq
  local job donor homes home
  while read -r job donor; do
    [ "$(yq -r ".jobs | has(\"$donor\")" "$MAIN_WF")" = "true" ]
    # A job gated by `if:` (the disabled main jobs use a constant false) may
    # never run, so it may never save a cache.
    [ "$(yq -r ".jobs.\"$donor\".if" "$MAIN_WF")" = "null" ]
    # Not itself a borrower: it saves under its own job id.
    [ "$(yq -r ".jobs.\"$donor\".env.GRADLE_BUILD_ACTION_CACHE_KEY_JOB" "$MAIN_WF")" = "null" ]
    homes="$(gradle_homes "$MAIN_WF" "$donor")"
    [ -n "$homes" ]
    while IFS= read -r home; do
      [ "$home" = "$OWN_HOME" ]
    done <<< "$homes"
    # reuse-build-cache: false disables the setup-gradle cache altogether.
    [ "$(yq -r ".jobs.\"$donor\".steps[] | select(.uses == \"./.github/actions/gradle-task-run\") | .with.\"reuse-build-cache\"" "$MAIN_WF" | sort -u)" = "null" ]
  done < <(borrowers)
}

@test "a pull-request job with a same-id main job keeps its own Gradle home" {
  donors_require_yq
  local job
  for job in build-android-control-proxy junit-runner-unit-tests kotlin-code-coverage detekt; do
    [ "$(yq -r ".jobs.\"$job\".env.GRADLE_BUILD_ACTION_CACHE_KEY_JOB" "$PR_WF")" = "null" ]
    [ "$(gradle_homes "$PR_WF" "$job" | sort -u)" = "$OWN_HOME" ]
    [ "$(yq -r ".jobs | has(\"$job\")" "$MAIN_WF")" = "true" ]
  done
}
