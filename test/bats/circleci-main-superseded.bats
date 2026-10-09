#!/usr/bin/env bats
# Guards scripts/ci/circleci-main-superseded.sh (#11010): a post-merge CircleCI
# macOS job is skipped only when a newer main commit touches the same path group.

setup() {
  script="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)/scripts/ci/circleci-main-superseded.sh"
  origin="${BATS_TEST_TMPDIR}/origin.git"
  work="${BATS_TEST_TMPDIR}/work"
  git init --quiet --bare --initial-branch=main "${origin}"
  git init --quiet --initial-branch=main "${work}"
  cd "${work}" || return 1
  git config user.email ci@example.invalid
  git config user.name ci
  git config commit.gpgsign false
  git remote add origin "${origin}"
  mkdir -p .circleci ios docs
  printf '%s\n' \
    'ios/.* run-main-ios true' \
    'android/desktop-app/.* run-main-desktop true' > .circleci/main-macos-paths.txt
  commit_file README.md base
}

commit_file() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >> "$1"
  git add "$1" .circleci/main-macos-paths.txt
  git commit --quiet -m "$1"
  git push --quiet origin HEAD:main
  git rev-parse HEAD
}

@test "runs the job when this commit is the main tip" {
  CIRCLE_SHA1="$(commit_file ios/a.swift one)"
  export CIRCLE_SHA1
  run bash "${script}" run-main-ios
  [ "$status" -eq 1 ]
  [[ "$output" == *"is the main tip"* ]]
}

@test "skips when a newer main commit touches the same path group" {
  CIRCLE_SHA1="$(commit_file ios/a.swift one)"
  export CIRCLE_SHA1
  commit_file ios/b.swift two > /dev/null
  run bash "${script}" run-main-ios
  [ "$status" -eq 0 ]
  [[ "$output" == *"also changes ios/b.swift"* ]]
}

@test "runs when newer main commits touch only other path groups" {
  CIRCLE_SHA1="$(commit_file ios/a.swift one)"
  export CIRCLE_SHA1
  commit_file docs/x.md two > /dev/null
  commit_file android/desktop-app/x.kt three > /dev/null
  run bash "${script}" run-main-ios
  [ "$status" -eq 1 ]
  [[ "$output" == *"no commit after"* ]]
}

@test "fails open when the parameter has no mapped paths or the remote is unreadable" {
  CIRCLE_SHA1="$(commit_file ios/a.swift one)"
  export CIRCLE_SHA1
  run bash "${script}" run-unknown
  [ "$status" -eq 1 ]
  [[ "$output" == *"no run-unknown paths"* ]]

  CIRCLECI_MAIN_REMOTE=missing run bash "${script}" run-main-ios
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not read missing/main"* ]]
}

@test "rejects a missing parameter" {
  run bash "${script}"
  [ "$status" -eq 2 ]
}
