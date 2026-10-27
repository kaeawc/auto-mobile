#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ci/workflow-duplication-report.sh"
  FIXTURES="$REPO_ROOT/test/fixtures/ci/workflow-duplication"
}

@test "lists only the jobs both workflows define" {
  run bash "$SCRIPT" "$FIXTURES/a.yml" "$FIXTURES/b.yml"
  [ "$status" -eq 0 ]
  [[ "$output" == *"shared jobs: 2"* ]]
  [[ "$output" == *"build "* ]]
  [[ "$output" == *"lint "* ]]
  [[ "$output" != *"only-a"* ]]
  [[ "$output" != *"only-b"* ]]
}

@test "counts the lines both bodies share, gating differences excluded" {
  run bash "$SCRIPT" "$FIXTURES/a.yml" "$FIXTURES/b.yml"
  [ "$status" -eq 0 ]
  # build: 6 vs 6 lines; the needs/if lines are the only difference, so 5 are shared.
  build_line="$(printf '%s\n' "$output" | grep -E '^build ')"
  [[ "$build_line" =~ ^build[[:space:]]+6[[:space:]]+6[[:space:]]+5[[:space:]]+83% ]]
}

@test "a different runner is a difference" {
  run bash "$SCRIPT" "$FIXTURES/a.yml" "$FIXTURES/b.yml"
  lint_line="$(printf '%s\n' "$output" | grep -E '^lint ')"
  [[ "$lint_line" =~ ^lint[[:space:]]+3[[:space:]]+3[[:space:]]+2[[:space:]]+66% ]]
}

@test "a missing workflow file is a usage error" {
  run bash "$SCRIPT" "$FIXTURES/a.yml" "$FIXTURES/missing.yml"
  [ "$status" -eq 2 ]
  [[ "$output" == *"no such file"* ]]
}

@test "the report runs on the repository's own workflows" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"shared jobs:"* ]]
}
