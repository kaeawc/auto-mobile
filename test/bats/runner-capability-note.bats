#!/usr/bin/env bats

# scripts/release/runner-capability-note.sh: advisory note when a diff adds a
# control-proxy capability and host code that uses it (#17618).

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  TEST_ROOT="$(mktemp -d)"
  cd "$TEST_ROOT"
  git init -q -b main .
  git config user.email test@example.com
  git config user.name test
  mkdir -p scripts/release scripts/lib android/control-proxy/src ios/control-proxy/Sources src/features
  cp "$REPO_ROOT/scripts/release/runner-capability-note.sh" scripts/release/
  cp "$REPO_ROOT/scripts/lib/vcs-diff.sh" scripts/lib/
  printf 'add("existing_feature_v1")\n' > android/control-proxy/src/WebSocketServer.kt
  printf 'case existing = "ios_existing_v1"\n' > ios/control-proxy/Sources/RunnerFeature.swift
  printf 'export const EXISTING = "existing_feature_v1";\n' > src/features/gates.ts
  git add -A
  git commit -q -m base
  git checkout -q -b feature
  unset GITHUB_ACTIONS
}

teardown() {
  cd /
  rm -rf "$TEST_ROOT"
}

run_note() {
  run bash scripts/release/runner-capability-note.sh --base main
}

add_runner_capability() {
  printf 'add("new_feature_v1")\n' >> android/control-proxy/src/WebSocketServer.kt
}

add_host_use() {
  printf 'export const NEW_FEATURE = "new_feature_v1";\n' >> src/features/gates.ts
}

@test "staged runner and host edits print the note and exit 0" {
  add_runner_capability
  add_host_use
  git add -A
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"NOTE (non-blocking): 'new_feature_v1' is new in control-proxy sources"* ]]
  [[ "$output" == *"next runner release and pin"* ]]
  [[ "$output" == *"scripts/release/check-artifact-capabilities.ts"* ]]
}

@test "unstaged runner and host edits print the note and exit 0" {
  add_runner_capability
  add_host_use
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is new in control-proxy sources"* ]]
}

@test "mixed staged runner edit and unstaged host edit print the note" {
  printf 'case newer = "ios_new_v2"\n' >> ios/control-proxy/Sources/RunnerFeature.swift
  git add -A
  printf 'const gate = "ios_new_v2";\n' >> src/features/gates.ts
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'ios_new_v2' is new"* ]]
}

@test "committed edits since the merge-base print the note" {
  add_runner_capability
  add_host_use
  git commit -q -am feature
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is new"* ]]
}

@test "an untracked host file counts as added host code" {
  add_runner_capability
  printf 'use("new_feature_v1");\n' > src/features/newGate.ts
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is new"* ]]
}

@test "runner capability without host use is silent" {
  add_runner_capability
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "host use of an already released capability is silent" {
  printf 'use("existing_feature_v1");\n' >> src/features/gates.ts
  printf '// unrelated runner edit\n' >> android/control-proxy/src/WebSocketServer.kt
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a moved runner capability is not treated as new" {
  printf '// header\nadd("existing_feature_v1")\n' > android/control-proxy/src/WebSocketServer.kt
  printf 'use("existing_feature_v1");\n' >> src/features/gates.ts
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a bare identifier in runner code is not a capability literal" {
  printf 'val x = new_feature_v1\n' >> android/control-proxy/src/WebSocketServer.kt
  add_host_use
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "GitHub Actions also gets a notice annotation" {
  add_runner_capability
  add_host_use
  GITHUB_ACTIONS=true run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"::notice title=Unreleased runner capability::'new_feature_v1'"* ]]
}

@test "an unresolvable explicit base warns and exits 0" {
  add_runner_capability
  add_host_use
  run bash scripts/release/runner-capability-note.sh --base does-not-exist
  [ "$status" -eq 0 ]
  [[ "$output" == *"base ref 'does-not-exist' does not resolve; skipping."* ]]
}

@test "default base falls back to main when origin/main is absent" {
  add_runner_capability
  add_host_use
  run bash scripts/release/runner-capability-note.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is new"* ]]
}

@test "bad arguments and a non-checkout never fail" {
  run bash scripts/release/runner-capability-note.sh --bogus
  [ "$status" -eq 0 ]
  [[ "$output" == *"unknown option '--bogus'"* ]]
  run bash scripts/release/runner-capability-note.sh --base
  [ "$status" -eq 0 ]
  outside="$(mktemp -d)"
  cp -R scripts "$outside/"
  run env GIT_CEILING_DIRECTORIES="$outside" bash "$outside/scripts/release/runner-capability-note.sh"
  rm -rf "$outside"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
