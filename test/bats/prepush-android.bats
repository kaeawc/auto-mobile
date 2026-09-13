#!/usr/bin/env bats

SCRIPT="scripts/prepush-android.sh"

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
}

@test "prints usage for --help" {
  cd "$REPO_ROOT"
  run bash "$SCRIPT" --help

  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: scripts/prepush-android.sh"* ]]
}

@test "rejects an unknown argument" {
  cd "$REPO_ROOT"
  run bash "$SCRIPT" --unknown

  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown argument: --unknown"* ]]
}

@test "is a successful no-op when there are no Android changes" {
  cd "$REPO_ROOT"
  run env ANDROID_PREPUSH_BASE_REF=HEAD bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"No Android-relevant changes"* ]]
  [[ "$output" == *"nothing to check"* ]]
}

@test "is shellcheck clean" {
  cd "$REPO_ROOT"
  run shellcheck "$SCRIPT"

  [ "$status" -eq 0 ]
}
