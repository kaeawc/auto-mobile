#!/usr/bin/env bats
#
# Tests for scripts/android/validate-kotlin-convention.sh (issue #5027).

SCRIPT="scripts/android/validate-kotlin-convention.sh"
CONVENTION="android/build-logic/src/main/kotlin/automobile.kotlin-common.gradle.kts"
FIXTURE="android/zzz-convention-guard-fixture.gradle.kts"

teardown() {
  rm -f "$FIXTURE"
}

@test "passes on the real tree with the convention centralized" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"centralized in $CONVENTION"* ]]
}

@test "fails when the opt-in list is duplicated into another build file" {
  printf '%s\n' \
    'tasks.withType<Nothing> {' \
    '  freeCompilerArgs.add("-opt-in=androidx.compose.material3.ExperimentalMaterial3Api")' \
    '}' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"opt-in list must live only"* ]]
}
