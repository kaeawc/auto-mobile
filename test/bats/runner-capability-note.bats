#!/usr/bin/env bats

# scripts/release/runner-capability-note.sh: advisory note when a diff makes a
# control-proxy artifact advertise a new capability and adds host code that
# gates on it (#17618). The helper reuses the release gate's parsers.

ANDROID_SRC="android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/WebSocketServer.kt"
IOS_SRC="ios/control-proxy/Sources/CtrlProxy/Models/RunnerFeature.swift"
HOST_SRC="src/features/observe/android/gates.ts"

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  export RUNNER_CAPABILITY_DIFF_TS="$REPO_ROOT/scripts/release/runner-capability-diff.ts"
  TEST_ROOT="$(mktemp -d)"
  cd "$TEST_ROOT"
  git init -q -b main .
  git config user.email test@example.com
  git config user.name test
  mkdir -p scripts/release scripts/lib "$(dirname "$ANDROID_SRC")" "$(dirname "$IOS_SRC")" "$(dirname "$HOST_SRC")"
  cp "$REPO_ROOT/scripts/release/runner-capability-note.sh" scripts/release/
  cp "$REPO_ROOT/scripts/lib/vcs-diff.sh" scripts/lib/
  printf 'add("existing_feature_v1")\n' > "$ANDROID_SRC"
  printf 'enum RunnerFeature: String {\n  case existing = "ios_existing_v1"\n}\n' > "$IOS_SRC"
  printf 'export const EXISTING = "existing_feature_v1";\nsupports(EXISTING);\n' > "$HOST_SRC"
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
  printf 'add("new_feature_v1")\n' >> "$ANDROID_SRC"
}

add_host_use() {
  printf 'supports("new_feature_v1");\n' >> "$HOST_SRC"
}

@test "staged runner and host edits print the note and exit 0" {
  add_runner_capability
  add_host_use
  git add -A
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"NOTE (non-blocking): 'new_feature_v1' is newly advertised by control-proxy sources"* ]]
  [[ "$output" == *"next runner release and pin"* ]]
  [[ "$output" == *"scripts/release/check-artifact-capabilities.ts"* ]]
}

@test "unstaged runner and host edits print the note and exit 0" {
  add_runner_capability
  add_host_use
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is newly advertised"* ]]
}

@test "mixed staged iOS runner edit and unstaged host edit print the note" {
  printf 'enum RunnerFeature: String {\n  case existing = "ios_existing_v1"\n  case newer = "ios_new_v2"\n}\n' > "$IOS_SRC"
  git add -A
  printf "const GATE = 'ios_new_v2';\nsupports(GATE);\n" >> "$HOST_SRC"
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'ios_new_v2' is newly advertised"* ]]
}

@test "committed edits since the merge-base print the note" {
  add_runner_capability
  add_host_use
  git commit -q -am feature
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is newly advertised"* ]]
}

@test "an untracked host file counts as added host code" {
  add_runner_capability
  printf "supports('new_feature_v1');\n" > src/features/observe/android/newGate.ts
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is newly advertised"* ]]
}

@test "color.ui=always does not hide the diff" {
  add_runner_capability
  add_host_use
  git config color.ui always
  git config color.diff always
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is newly advertised"* ]]
}

@test "a new reference to a constant declared in an unchanged file prints the note" {
  printf 'export const NEW_FEATURE = "new_feature_v1";\n' > src/features/observe/android/capabilities.ts
  git add -A
  git commit -q -m "declare constant on main side"
  git branch -f main HEAD
  add_runner_capability
  printf 'import { NEW_FEATURE } from "./capabilities";\nsupports(NEW_FEATURE);\n' >> "$HOST_SRC"
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'new_feature_v1' is newly advertised"* ]]
}

@test "adding an iOS-only capability to Android prints the note" {
  printf 'add("ios_existing_v1")\n' >> "$ANDROID_SRC"
  printf 'supports("ios_existing_v1");\n' >> "$HOST_SRC"
  run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"'ios_existing_v1' is newly advertised"* ]]
}

@test "a capability only named in a host comment is silent" {
  add_runner_capability
  printf '// Future documentation: "new_feature_v1"\n' >> "$HOST_SRC"
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a declared host constant that nothing references is silent" {
  add_runner_capability
  printf 'export const NEW_FEATURE = "new_feature_v1";\n' >> "$HOST_SRC"
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "runner capability without host use is silent" {
  add_runner_capability
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "host gate without a runner change is silent" {
  add_host_use
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "new host use of an already advertised capability is silent" {
  printf 'supports("existing_feature_v1");\n' >> src/features/observe/android/other.ts
  printf '// unrelated runner edit\n' >> "$ANDROID_SRC"
  run_note
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a moved runner capability is not treated as new" {
  printf '// header\nadd("existing_feature_v1")\n' > "$ANDROID_SRC"
  printf 'supports("existing_feature_v1");\n' >> src/features/observe/android/other.ts
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

@test "a failing helper warns and exits 0" {
  add_runner_capability
  add_host_use
  printf 'process.exit(5);\n' > "$TEST_ROOT/failing.ts"
  RUNNER_CAPABILITY_DIFF_TS="$TEST_ROOT/failing.ts" run_note
  [ "$status" -eq 0 ]
  [[ "$output" == *"capability diff helper failed; skipping."* ]]
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
  [[ "$output" == *"'new_feature_v1' is newly advertised"* ]]
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
