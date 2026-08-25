#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.
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
