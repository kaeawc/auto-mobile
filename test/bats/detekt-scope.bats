#!/usr/bin/env bats
#
# detekt_scope.sh maps a PR's changed Kotlin files back to the Gradle modules
# that own them, so CI runs only those modules' detekt tasks. A wrongly-narrow
# scope lets a violation reach main, so these tests pin both directions: what
# gets scoped down, and what must fail open to the full task list.

SCRIPT="scripts/android/detekt_scope.sh"

# A throwaway git repo shaped like android/: a settings file listing the
# included projects, and one build.gradle.kts per module. Real fixtures rather
# than a mocked `git diff`, because the module walk is a filesystem fact.
setup() {
  REPO="$(mktemp -d)"
  export REPO

  mkdir -p "$REPO/android/gradle/wrapper" "$REPO/android/config/detekt"
  mkdir -p "$REPO/android/protocol/src/main/kotlin"
  mkdir -p "$REPO/android/playground/design/system/src/main/kotlin"
  mkdir -p "$REPO/android/playground/app/src/main/kotlin"

  cat > "$REPO/android/settings.gradle.kts" <<'EOF'
include(":protocol")
include(":playground:design:system")
include(":playground:app")
EOF

  touch "$REPO/android/build.gradle.kts"
  touch "$REPO/android/gradle.properties"
  touch "$REPO/android/gradle/libs.versions.toml"
  touch "$REPO/android/config/detekt/detekt.yml"
  touch "$REPO/android/protocol/build.gradle.kts"
  touch "$REPO/android/playground/design/system/build.gradle.kts"
  touch "$REPO/android/playground/app/build.gradle.kts"

  mkdir -p "$REPO/scripts/android"
  cp "$BATS_TEST_DIRNAME/../../$SCRIPT" "$REPO/scripts/android/detekt_scope.sh"

  git -C "$REPO" init --quiet
  git -C "$REPO" config user.email "bats@example.com"
  git -C "$REPO" config user.name "bats"
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "base"
  BASE="$(git -C "$REPO" rev-parse HEAD)"
  export BASE
}

teardown() {
  rm -rf "$REPO"
}

# Commit a change to <path> with some content so the diff is non-empty.
commit_change() {
  local path="$1"
  mkdir -p "$(dirname "$REPO/$path")"
  echo "// changed" >> "$REPO/$path"
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "change $path"
}

run_scope() {
  run env PROJECT_ROOT="$REPO" bash "$REPO/scripts/android/detekt_scope.sh" --since "$BASE"
}

@test "scopes to the single module that changed" {
  commit_change "android/protocol/src/main/kotlin/Foo.kt"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = ":protocol:detektMain :protocol:detektTest" ]
}

@test "maps a nested module to its colon-separated Gradle path" {
  commit_change "android/playground/design/system/src/main/kotlin/Theme.kt"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = ":playground:design:system:detektMain :playground:design:system:detektTest" ]
}

@test "scopes to every changed module, deduplicated and sorted" {
  commit_change "android/protocol/src/main/kotlin/Foo.kt"
  commit_change "android/protocol/src/main/kotlin/Bar.kt"
  commit_change "android/playground/app/src/main/kotlin/App.kt"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = ":playground:app:detektMain :playground:app:detektTest :protocol:detektMain :protocol:detektTest" ]
}

@test "a module's own build.gradle.kts scopes to that module" {
  commit_change "android/protocol/build.gradle.kts"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = ":protocol:detektMain :protocol:detektTest" ]
}

@test "emits nothing when no Kotlin source changed" {
  commit_change "android/protocol/src/main/res/values/strings.xml"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a deleted Kotlin file still re-runs its module" {
  echo "// seed" > "$REPO/android/protocol/src/main/kotlin/Doomed.kt"
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "seed"
  BASE="$(git -C "$REPO" rev-parse HEAD)"
  rm "$REPO/android/protocol/src/main/kotlin/Doomed.kt"
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "delete"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = ":protocol:detektMain :protocol:detektTest" ]
}

# --- fail-open cases: scoping is not provably safe, so run everything ---

@test "root build.gradle.kts falls back to the full scope" {
  commit_change "android/build.gradle.kts"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = "detektMain detektTest" ]
}

@test "the detekt config falls back to the full scope" {
  commit_change "android/config/detekt/detekt.yml"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = "detektMain detektTest" ]
}

@test "settings.gradle.kts falls back to the full scope" {
  commit_change "android/settings.gradle.kts"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = "detektMain detektTest" ]
}

@test "the version catalog falls back to the full scope" {
  commit_change "android/gradle/libs.versions.toml"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  [ "$output" = "detektMain detektTest" ]
}

@test "a module missing from settings.gradle.kts falls back to the full scope" {
  mkdir -p "$REPO/android/orphan/src/main/kotlin"
  touch "$REPO/android/orphan/build.gradle.kts"
  commit_change "android/orphan/src/main/kotlin/Orphan.kt"
  cd "$REPO" || return 1
  run_scope
  [ "$status" -eq 0 ]
  # `run` merges stderr into $output, so the warning precedes the task list.
  [[ "$output" == *"not an included project"* ]]
  [[ "$output" == *"detektMain detektTest"* ]]
}

@test "an unresolvable base SHA falls back to the full scope" {
  cd "$REPO" || return 1
  run env PROJECT_ROOT="$REPO" bash "$REPO/scripts/android/detekt_scope.sh" --since deadbeefdeadbeef
  [ "$status" -eq 0 ]
  [[ "$output" == *"detektMain detektTest"* ]]
}

@test "no base SHA at all falls back to the full scope" {
  cd "$REPO" || return 1
  run env PROJECT_ROOT="$REPO" bash "$REPO/scripts/android/detekt_scope.sh"
  [ "$status" -eq 0 ]
  [ "$output" = "detektMain detektTest" ]
}
