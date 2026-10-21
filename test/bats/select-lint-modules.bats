#!/usr/bin/env bats
# Module selection shared by scripts/prepush-android.sh and the PR Detekt job.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/android/select-lint-modules.sh"
  fixture_repo="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$fixture_repo/android/foo/src/main/res" "$fixture_repo/android/bar/src/main" \
    "$fixture_repo/android/jvm/src/main" "$fixture_repo/android/playground/baz/src/main"
  printf 'plugins { id("automobile.android-library") }\n' > "$fixture_repo/android/foo/build.gradle.kts"
  printf 'plugins { alias(libs.plugins.android.application) }\n' > "$fixture_repo/android/bar/build.gradle.kts"
  printf 'plugins { id("automobile.kotlin-common") }\n' > "$fixture_repo/android/jvm/build.gradle.kts"
  printf 'plugins { id("automobile.android-library") }\n' > "$fixture_repo/android/playground/baz/build.gradle.kts"
  cd "$fixture_repo"
}

select_for() {
  printf '%s\n' "$@" | bash "$SCRIPT"
}

@test "sources, resources, manifests and baselines select only the owning modules" {
  run select_for android/foo/src/main/Foo.kt android/foo/src/main/res/a.xml \
    android/bar/src/main/AndroidManifest.xml android/bar/lint-baseline.xml
  [ "$status" -eq 0 ]
  [ "$output" = $':bar:lintDebug\n:foo:lintDebug' ]
}

@test "nested modules map to colon-separated tasks" {
  run select_for android/playground/baz/src/main/B.kt
  [ "$status" -eq 0 ]
  [ "$output" = ':playground:baz:lintDebug' ]
}

@test "non-Android modules and unrelated files select nothing" {
  run select_for android/jvm/src/main/J.kt README.md src/daemon/x.ts docs/a.md
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "empty input selects nothing" {
  run bash "$SCRIPT" < /dev/null
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "build-logic, Gradle wiring and module build scripts select all modules" {
  for f in android/build-logic/src/main/kotlin/x.kts android/settings.gradle.kts android/build.gradle.kts \
    android/gradle.properties android/gradle/libs.versions.toml android/gradlew android/foo/build.gradle.kts \
    android/foo/gradle.properties; do
    run select_for "$f" android/foo/src/main/Foo.kt
    [ "$status" -eq 0 ]
    [ "$output" = all ]
  done
}

@test "lint gate scripts and workflows select all modules" {
  for f in scripts/android/check-lint-baseline-shrink.sh scripts/android/select-lint-modules.sh \
    scripts/prepush-android.sh .github/workflows/pull_request.yml .github/workflows/merge.yml \
    .github/actions/gradle-task-run/action.yml; do
    run select_for "$f"
    [ "$status" -eq 0 ]
    [ "$output" = all ]
  done
}

@test "a removed module build script selects all modules" {
  rm android/foo/build.gradle.kts
  run select_for android/foo/build.gradle.kts
  [ "$status" -eq 0 ]
  [ "$output" = all ]
}

@test "unknown arguments fail and help succeeds" {
  run bash "$SCRIPT" --bogus
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *Usage* ]]
}

@test "the PR Detekt job selects lint modules, keeps the full Detekt task list, and merge.yml lints everything" {
  pr="$REPO_ROOT/.github/workflows/pull_request.yml"
  merge="$REPO_ROOT/.github/workflows/merge.yml"
  grep -Fq 'scripts/android/select-lint-modules.sh' "$pr"
  grep -Fq 'detektMain detektTest :build-logic:test ${{ steps.lint-select.outputs.tasks }}' "$pr"
  grep -Fq 'detektMain detektTest :build-logic:test lintDebug' "$merge"
}

@test "SDK changes select direct and transitive Android consumers through JVM modules" {
  mkdir -p android/auto-mobile-sdk/src/main android/playground/app android/playground/bridge
  cat > android/settings.gradle.kts <<'GRADLE'
include(":auto-mobile-sdk", ":foo", ":bar", ":jvm")
include(
  ":playground:bridge",
  ":playground:app",
)
GRADLE
  printf 'plugins { id("automobile.android-library") }\n' > android/auto-mobile-sdk/build.gradle.kts
  cat >> android/foo/build.gradle.kts <<'GRADLE'
dependencies { api(projects.autoMobileSdk) }
GRADLE
  cat > android/playground/bridge/build.gradle.kts <<'GRADLE'
plugins { id("automobile.kotlin-common") }
dependencies { implementation(project(":foo")) }
GRADLE
  cat > android/playground/app/build.gradle.kts <<'GRADLE'
plugins { alias(libs.plugins.android.application) }
dependencies { implementation(projects.playground.bridge) }
GRADLE
  # A cycle must terminate without emitting JVM lint tasks.
  printf 'dependencies { api(project(":playground:app")) }\n' >> android/foo/build.gradle.kts
  for path in src/main/SDK.kt src/main/res/values/strings.xml src/main/AndroidManifest.xml lint-baseline.xml; do
    run select_for "android/auto-mobile-sdk/$path"
    [ "$status" -eq 0 ]
    [ "$output" = $':auto-mobile-sdk:lintDebug\n:foo:lintDebug\n:playground:app:lintDebug' ]
  done
}

@test "real SDK changes include the playground app" {
  cd "$REPO_ROOT"
  run select_for android/auto-mobile-sdk/src/main/kotlin/AutoMobileSDK.kt
  [ "$status" -eq 0 ]
  [[ $'\n'"$output"$'\n' == *$'\n:playground:app:lintDebug\n'* ]]
}

@test "unrelated dependency components stay out of the lint selection" {
  printf 'dependencies { api(project(":playground:baz")) }\n' >> android/bar/build.gradle.kts
  run select_for android/foo/src/main/Foo.kt
  [ "$status" -eq 0 ]
  [ "$output" = ':foo:lintDebug' ]
}

@test "unknown typesafe accessors conservatively select all" {
  printf 'dependencies { api(projects.unknownModule) }\n' >> android/bar/build.gradle.kts
  run select_for android/foo/src/main/Foo.kt
  [ "$status" -eq 0 ]
  [ "$output" = all ]
}

@test "multiline project dependencies carry JVM edits to Android consumers" {
  cat >> android/foo/build.gradle.kts <<'GRADLE'
dependencies {
  implementation(project(
    ":jvm"
  ))
}
GRADLE
  run select_for android/jvm/src/main/J.kt
  [ "$status" -eq 0 ]
  [ "$output" = ':foo:lintDebug' ]
}
