#!/usr/bin/env bats
#
# Guards the shared Robolectric android-all jar cache (#16396).
#
# Robolectric downloads one android-all-instrumented jar per SDK level into
# ~/.m2 at test time and tries once. With no cache, every Robolectric job
# fetched ~1.4 GB from Maven Central on every run, and one 429 failed the test
# class. gradle-task-run restores one shared cache of those jars; only the
# merge Kotlin Code Coverage job, which runs every Robolectric module, saves it.

SCRIPT="scripts/ci/robolectric-jar-cache.sh"
ACTION=".github/actions/gradle-task-run/action.yml"

write_catalog() {
  cat > "$BATS_TEST_TMPDIR/libs.versions.toml" <<EOF
[versions]
build-robolectric-maxSdk = "35"
robolectric = "$1"
roborazzi = "1.0"

[libraries]
robolectric = { module = "org.robolectric:robolectric", version.ref = "robolectric" }
EOF
}

@test "key names the Robolectric version from the version catalog" {
  write_catalog "4.17"
  run bash "$SCRIPT" key "$BATS_TEST_TMPDIR/libs.versions.toml"
  [ "$status" -eq 0 ]
  [ "$output" = "robolectric-android-all-v1-4.17" ]
}

@test "key changes when Robolectric is bumped" {
  write_catalog "4.18"
  run bash "$SCRIPT" key "$BATS_TEST_TMPDIR/libs.versions.toml"
  [ "$output" = "robolectric-android-all-v1-4.18" ]
}

@test "key fails when the catalog has no robolectric version" {
  printf '[versions]\nkotlin = "2.4.21"\n' > "$BATS_TEST_TMPDIR/libs.versions.toml"
  run bash "$SCRIPT" key "$BATS_TEST_TMPDIR/libs.versions.toml"
  [ "$status" -ne 0 ]
  [[ "$output" == *"no [versions] robolectric"* ]]
}

@test "key reads the real catalog" {
  run bash "$SCRIPT" key android/gradle/libs.versions.toml
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^robolectric-android-all-v1-[0-9][0-9.]*$ ]]
}

@test "fingerprint is 'none' for a missing or jar-less directory" {
  run bash "$SCRIPT" fingerprint "$BATS_TEST_TMPDIR/absent"
  [ "$status" -eq 0 ]
  [ "$output" = "none" ]
  mkdir -p "$BATS_TEST_TMPDIR/empty/sub"
  touch "$BATS_TEST_TMPDIR/empty/sub/readme.txt"
  run bash "$SCRIPT" fingerprint "$BATS_TEST_TMPDIR/empty"
  [ "$output" = "none" ]
}

@test "fingerprint is stable for the same jars and changes when a jar is added" {
  dir="$BATS_TEST_TMPDIR/jars"
  mkdir -p "$dir/11-robolectric-6757853-i7"
  printf 'eleven' > "$dir/11-robolectric-6757853-i7/android-all-instrumented-11-robolectric-6757853-i7.jar"
  first="$(bash "$SCRIPT" fingerprint "$dir")"
  second="$(bash "$SCRIPT" fingerprint "$dir")"
  [ "$first" != "none" ]
  [ "$first" = "$second" ]

  mkdir -p "$dir/14-robolectric-10818077-i7"
  printf 'fourteen' > "$dir/14-robolectric-10818077-i7/android-all-instrumented-14-robolectric-10818077-i7.jar"
  third="$(bash "$SCRIPT" fingerprint "$dir")"
  [ "$third" != "$first" ]
}

@test "fingerprint ignores non-jar files such as .pom and .sha1 siblings" {
  dir="$BATS_TEST_TMPDIR/jars"
  mkdir -p "$dir/v"
  printf 'jar' > "$dir/v/a.jar"
  before="$(bash "$SCRIPT" fingerprint "$dir")"
  printf 'pom' > "$dir/v/a.pom"
  [ "$(bash "$SCRIPT" fingerprint "$dir")" = "$before" ]
}

@test "unknown subcommands fail with usage" {
  run bash "$SCRIPT" bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "gradle-task-run restores the jar cache before Gradle and saves it only from a main push" {
  # The restore must run before the Gradle step, and the save must be limited
  # to save mode on a main push, or every PR job would write a ~1.4 GB entry.
  restore_line="$(grep -n 'name: "Restore Robolectric jar cache"' "$ACTION" | cut -d: -f1)"
  gradle_line="$(grep -n 'name: "Run Tasks via Gradle"' "$ACTION" | cut -d: -f1)"
  save_line="$(grep -n 'name: "Save Robolectric jar cache"' "$ACTION" | cut -d: -f1)"
  [ -n "$restore_line" ]
  [ -n "$gradle_line" ]
  [ -n "$save_line" ]
  [ "$restore_line" -lt "$gradle_line" ]
  [ "$save_line" -gt "$gradle_line" ]
  save_block="$(sed -n "${save_line},\$p" "$ACTION" | sed -n '1,/^    - name:/p')"
  [[ "$save_block" == *"inputs.robolectric-jar-cache == 'save'"* ]]
  [[ "$save_block" == *"github.ref == 'refs/heads/main'"* ]]
  [[ "$save_block" == *"github.event_name == 'push'"* ]]
}

@test "only the merge Kotlin Code Coverage job saves the jar cache" {
  run grep -rl "robolectric-jar-cache: \"save\"" .github/workflows
  [ "$status" -eq 0 ]
  [ "$output" = ".github/workflows/merge.yml" ]
  [ "$(grep -c 'robolectric-jar-cache: "save"' .github/workflows/merge.yml)" -eq 1 ]
  awk '/^  kotlin-code-coverage:/{job=1} job && /robolectric-jar-cache: "save"/{found=1} /^  [a-z0-9-]+:$/ && !/kotlin-code-coverage/{job=0} END{exit !found}' \
    .github/workflows/merge.yml
}
